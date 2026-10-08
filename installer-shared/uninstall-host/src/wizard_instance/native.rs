//! Windows peers are bound to live process identity and a private local pipe.

use super::{Decision, Shared};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::PSECURITY_DESCRIPTOR;

const MUTEX_NAME: &str = "Local\\SidekickAI-Maintenance-Wizard";
const MAX_MESSAGE: usize = 65536;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_ABANDONED: u32 = 0x80;
const ERROR_ALREADY_EXISTS: u32 = 183;
const ERROR_PIPE_CONNECTED: u32 = 535;
const ERROR_NO_DATA: u32 = 232;
const ERROR_PIPE_LISTENING: u32 = 536;
const INVALID_HANDLE: *mut c_void = -1isize as *mut c_void;

type RawHandle = *mut c_void;

#[repr(C)]
struct SecurityAttributes {
    size: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *const SecurityAttributes, owner: i32, name: *const u16) -> RawHandle;
    fn ReleaseMutex(handle: RawHandle) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn GetLastError() -> u32;
    fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        instances: u32,
        output: u32,
        input: u32,
        timeout: u32,
        attributes: *const SecurityAttributes,
    ) -> RawHandle;
    fn ConnectNamedPipe(pipe: RawHandle, overlapped: *mut c_void) -> i32;
    fn DisconnectNamedPipe(pipe: RawHandle) -> i32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        sharing: u32,
        attributes: *const c_void,
        disposition: u32,
        flags: u32,
        template: RawHandle,
    ) -> RawHandle;
    fn ReadFile(handle: RawHandle, buffer: *mut c_void, length: u32, read: *mut u32, overlapped: *mut c_void) -> i32;
    fn WriteFile(
        handle: RawHandle,
        buffer: *const c_void,
        length: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn SetNamedPipeHandleState(pipe: RawHandle, mode: *const u32, count: *const u32, timeout: *const u32) -> i32;
    fn GetNamedPipeClientProcessId(pipe: RawHandle, pid: *mut u32) -> i32;
    fn GetNamedPipeServerProcessId(pipe: RawHandle, pid: *mut u32) -> i32;
    fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn QueryFullProcessImageNameW(process: RawHandle, flags: u32, path: *mut u16, length: *mut u32) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn AllowSetForegroundWindow(pid: u32) -> i32;
    fn EnumWindows(callback: unsafe extern "system" fn(RawHandle, isize) -> i32, value: isize) -> i32;
    fn GetWindowThreadProcessId(window: RawHandle, pid: *mut u32) -> u32;
    fn GetWindowTextW(window: RawHandle, text: *mut u16, length: i32) -> i32;
    fn ShowWindow(window: RawHandle, show: i32) -> i32;
    fn SetForegroundWindow(window: RawHandle) -> i32;
}

#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(path: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(path: *const u16, handle: u32, length: u32, data: *mut c_void) -> i32;
    fn VerQueryValueW(data: *const c_void, block: *const u16, value: *mut *mut c_void, length: *mut u32) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn failure() -> String {
    format!("维护协调暂时不可用：{}", std::io::Error::last_os_error())
}

struct Handle(RawHandle);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct Security(PSECURITY_DESCRIPTOR);
impl Security {
    fn new(sid: &str) -> Result<Self, String> {
        if !sid.starts_with("S-1-") || !sid.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'S' | b'-')) {
            return Err("维护用户身份无效。".into());
        }
        let text = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})S:(ML;;NW;;;ME)"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok(Self(descriptor))
    }
    fn attributes(&self) -> SecurityAttributes {
        SecurityAttributes { size: std::mem::size_of::<SecurityAttributes>() as u32, descriptor: self.0 .0, inherit: 0 }
    }
}
impl Drop for Security {
    fn drop(&mut self) {
        let _ = unsafe { LocalFree(HLOCAL(self.0 .0)) };
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    request_id: String,
    entry: String,
    executable: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    protocol_version: u32,
    request_id: String,
    decision: String,
    entry: String,
}

fn session(pid: u32) -> Result<u32, String> {
    let mut value = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut value) } == 0 {
        return Err(failure());
    }
    Ok(value)
}

fn test_scope() -> Result<Option<String>, String> {
    let namespace = match std::env::var("SIDEKICK_WIZARD_TEST_NAMESPACE") {
        Ok(namespace) => namespace,
        Err(_) => return Ok(None),
    };
    if namespace.is_empty()
        || namespace.len() > 128
        || !namespace.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("维护验证命名空间无效。".into());
    }
    let root = PathBuf::from(std::env::var_os("SIDEKICK_WIZARD_TEST_ROOT").ok_or("维护验证目录未指定。")?);
    if !root.is_absolute() {
        return Err("维护验证目录必须是绝对路径。".into());
    }
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let executable = std::fs::canonicalize(std::env::current_exe().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    if !sidekickai_uninstall_core::path::path_is_same_or_descendant(&executable, &root) {
        return Err("维护验证程序不属于隔离目录。".into());
    }
    Ok(Some(format!("{:x}", Sha256::digest(namespace.as_bytes()))[..24].to_owned()))
}

fn product_name(path: &Path) -> Option<String> {
    let path = wide(path.to_str()?);
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = |key: &str| {
        let mut value = std::ptr::null_mut();
        let mut length = 0;
        let key = wide(key);
        if unsafe { VerQueryValueW(buffer.as_ptr().cast(), key.as_ptr(), &mut value, &mut length) } == 0 {
            return None;
        }
        Some((value, length))
    };
    let (translation, length) = query("\\VarFileInfo\\Translation")?;
    if length < 4 || translation.is_null() {
        return None;
    }
    let ids = unsafe { std::slice::from_raw_parts(translation.cast::<u16>(), 2) };
    let (value, length) = query(&format!("\\StringFileInfo\\{:04x}{:04x}\\ProductName", ids[0], ids[1]))?;
    if value.is_null() || length == 0 || length > 512 {
        return None;
    }
    let text = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), length as usize) };
    Some(String::from_utf16_lossy(text).trim_end_matches('\0').to_owned())
}

fn maintenance_image(path: &Path) -> bool {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let application = sidekickai_uninstall_core::product::product();
    if name.eq_ignore_ascii_case(&application.executable)
        || application.editions.values().any(|edition| name.eq_ignore_ascii_case(&edition.legacy_executable))
        || !name.to_ascii_lowercase().ends_with(".exe")
    {
        return false;
    }
    product_name(path)
        .is_some_and(|name| matches!(name.as_str(), "SidekickAI" | "SidekickAI Installer" | "SidekickAI Uninstaller"))
}

fn executable_matches(actual: &Path, claimed: &Path) -> bool {
    match (std::fs::canonicalize(actual), std::fs::canonicalize(claimed)) {
        (Ok(actual), Ok(claimed)) => sidekickai_uninstall_core::path::paths_equal(&actual, &claimed),
        _ => false,
    }
}

struct Peer {
    process: Handle,
    executable: PathBuf,
}
impl Peer {
    fn verified(pid: u32, sid: &str, own_session: u32) -> Result<Self, String> {
        let handle = unsafe { OpenProcess(0x00100000 | 0x1000, 0, pid) };
        if handle.is_null() {
            return Err(failure());
        }
        let process = Handle(handle);
        if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0
            || session(pid)? != own_session
            || crate::process_user_sid(pid).map_err(|error| error.message)? != sid
        {
            return Err("维护进程身份不匹配。".into());
        }
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length) } == 0 {
            return Err(failure());
        }
        let executable = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
        if !maintenance_image(&executable) || unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
            return Err("维护程序身份无法确认。".into());
        }
        Ok(Self { process, executable })
    }
    fn is_live(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) != WAIT_OBJECT_0 }
    }
}

fn read_message(handle: &Handle, deadline: Instant, stop: Option<&AtomicBool>) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; MAX_MESSAGE];
    loop {
        let mut read = 0;
        let success = unsafe {
            ReadFile(handle.0, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut read, std::ptr::null_mut())
        };
        if success != 0 && read != 0 {
            buffer.truncate(read as usize);
            return Ok(buffer);
        }
        let error = unsafe { GetLastError() };
        if success == 0 && !matches!(error, ERROR_NO_DATA | ERROR_PIPE_LISTENING) {
            return Err(failure());
        }
        if Instant::now() >= deadline || stop.is_some_and(|stop| stop.load(Ordering::SeqCst)) {
            return Err("等待维护协调响应。".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn write_message<T: Serialize>(handle: &Handle, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("维护协调请求过大。".into());
    }
    let mut written = 0;
    if unsafe { WriteFile(handle.0, bytes.as_ptr().cast(), bytes.len() as u32, &mut written, std::ptr::null_mut()) }
        == 0
        || written != bytes.len() as u32
    {
        return Err(failure());
    }
    Ok(())
}

fn send_request(pipe_name: &str, entry: &str, sid: &str, own_session: u32) -> Result<String, String> {
    let name = wide(pipe_name);
    let handle =
        unsafe { CreateFileW(name.as_ptr(), 0x80000000 | 0x40000000, 0, std::ptr::null(), 3, 0, std::ptr::null_mut()) };
    if handle == INVALID_HANDLE {
        return Err(failure());
    }
    let pipe = Handle(handle);
    let mode = 3;
    if unsafe { SetNamedPipeHandleState(pipe.0, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
        return Err(failure());
    }
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) } == 0 {
        return Err(failure());
    }
    let peer = Peer::verified(pid, sid, own_session)?;
    unsafe {
        AllowSetForegroundWindow(pid);
    }
    let request = Request {
        protocol_version: 2,
        request_id: sidekickai_uninstall_core::random_id("wizard").map_err(|error| error.message)?,
        entry: entry.into(),
        executable: std::env::current_exe().map_err(|error| error.to_string())?.to_string_lossy().into_owned(),
    };
    write_message(&pipe, &request)?;
    let response: Response =
        serde_json::from_slice(&read_message(&pipe, Instant::now() + Duration::from_secs(if super::precise_entry(entry){1}else{3}), None)?)
            .map_err(|error| error.to_string())?;
    if !peer.is_live()
        || response.protocol_version != 2
        || response.request_id != request.request_id
        || !matches!(response.decision.as_str(), "activate" | "switch" | "rejected")
        || super::precise_entry(entry) && response.decision=="activate" && response.entry!=entry
    {
        return Err("维护协调响应无法核验。".into());
    }
    write_message(
        &pipe,
        &Response { protocol_version: 2, request_id: request.request_id, decision: "received".into(),entry:entry.into() },
    )?;
    Ok(response.decision)
}

fn serve(pipe: Handle, sid: String, own_session: u32, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        let connected = unsafe { ConnectNamedPipe(pipe.0, std::ptr::null_mut()) } != 0;
        let error = unsafe { GetLastError() };
        if !connected && error != ERROR_PIPE_CONNECTED {
            if error == ERROR_NO_DATA {
                unsafe {
                    DisconnectNamedPipe(pipe.0);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let result = (|| {
            let mut pid = 0;
            if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut pid) } == 0 {
                return Err(failure());
            }
            let peer = Peer::verified(pid, &sid, own_session)?;
            let request: Request =
                serde_json::from_slice(&read_message(&pipe, Instant::now() + Duration::from_secs(2), Some(&stop))?)
                    .map_err(|error| error.to_string())?;
            if request.protocol_version != 2
                || request.request_id.is_empty()
                || request.request_id.len() > 160
                || request.entry.is_empty()
                || request.entry.len() > 32768
                || !peer.is_live()
                || !executable_matches(&peer.executable, Path::new(&request.executable))
            {
                return Err("维护协调请求无法核验。".into());
            }
            let (decision, callback) = shared.request(&request.entry);
            let reply = write_message(
                &pipe,
                &Response {
                    protocol_version: 2,
                    request_id: request.request_id,
                    decision: match decision {Decision::Switch=>"switch",Decision::Activate=>"activate",Decision::Reject=>"rejected"}.into(),
                    entry:shared.entry()?,
                },
            );
            if reply.is_ok() {
                let _ = read_message(&pipe, Instant::now() + Duration::from_secs(2), Some(&stop));
            }
            if let Some(callback) = callback {
                callback();
            }
            reply
        })();
        if let Err(error) = result {
            eprintln!("{error}");
        }
        unsafe {
            DisconnectNamedPipe(pipe.0);
        }
    }
}

struct LegacySearch {
    sid: String,
    session: u32,
    activated: bool,
}
unsafe extern "system" fn find_legacy(window: RawHandle, data: isize) -> i32 {
    let search = &mut *(data as *mut LegacySearch);
    let mut title = [0u16; 128];
    let length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
    if length <= 0 {
        return 1;
    }
    let title = String::from_utf16_lossy(&title[..length as usize]);
    if !matches!(title.as_str(), "工百窗安装向导" | "工百窗卸载向导") {
        return 1;
    }
    let mut pid = 0;
    GetWindowThreadProcessId(window, &mut pid);
    if Peer::verified(pid, &search.sid, search.session).is_err() {
        return 1;
    }
    AllowSetForegroundWindow(pid);
    ShowWindow(window, 9);
    SetForegroundWindow(window);
    search.activated = true;
    0
}

fn activate_legacy(sid: &str, session: u32) -> bool {
    let mut search = LegacySearch { sid: sid.into(), session, activated: false };
    unsafe {
        EnumWindows(find_legacy, (&mut search as *mut LegacySearch) as isize);
    }
    search.activated
}

pub(super) struct Owner {
    mutex: Handle,
    stop: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}

impl Owner {
    pub(super) fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stop();
        unsafe {
            ReleaseMutex(self.mutex.0);
        }
    }
}

pub(super) fn acquire(entry: &str, shared: Arc<Shared>) -> Result<Option<Owner>, String> {
    let sid = crate::current_user_sid().map_err(|error| error.message)?;
    let own_session = session(std::process::id())?;
    let security = Security::new(&sid)?;
    let attributes = security.attributes();
    let scope = test_scope()?;
    let activate_existing = || scope.is_none() && activate_legacy(&sid, own_session);
    let precise=super::precise_entry(entry);
    let mutex_name = scope
        .as_ref()
        .map(|scope| format!("Local\\SidekickAI-Maintenance-Test-{scope}"))
        .unwrap_or_else(|| MUTEX_NAME.into());
    let name = wide(&mutex_name);
    let handle = unsafe { CreateMutexW(&attributes, 0, name.as_ptr()) };
    if handle.is_null() {
        return if !precise && activate_existing() { Ok(None) } else { Err(failure()) };
    }
    let existing = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let mutex = Handle(handle);
    let suffix = scope.as_ref().map(|scope| format!("-Test-{scope}")).unwrap_or_default();
    let pipe_name = format!("\\\\.\\pipe\\SidekickAI-Maintenance-{sid}-{own_session}{suffix}");
    if existing {
        let deadline = Instant::now() + Duration::from_secs(if precise {3}else{10});
        loop {
            match send_request(&pipe_name, entry, &sid, own_session) {
                Ok(decision) if decision == "activate" => return Ok(None),
                Ok(decision) if decision == "rejected" => return Err("当前维护向导正在准备或执行另一项发行操作；已唤起原窗口，本次更新尚未接管。请等待完成后重试。".into()),
                Ok(_) => {
                    let remaining =
                        deadline.saturating_duration_since(Instant::now()).as_millis().min(u32::MAX as u128) as u32;
                    if !matches!(unsafe { WaitForSingleObject(mutex.0, remaining) }, WAIT_OBJECT_0 | WAIT_ABANDONED) {
                        if precise {return Err("维护向导尚未完成发行交接，请稍后重试。".into());}
                        activate_existing();
                        return Ok(None);
                    }
                    break;
                }
                Err(_) if !precise && activate_existing() => return Ok(None),
                Err(_) => {
                    if Instant::now() >= deadline {
                        if matches!(unsafe { WaitForSingleObject(mutex.0, 0) }, WAIT_OBJECT_0 | WAIT_ABANDONED) {
                            break;
                        }
                        return if precise {Err("已有维护向导未确认本次精准发行，请关闭空闲窗口后重试。".into())} else {Ok(None)};
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    } else if !matches!(unsafe { WaitForSingleObject(mutex.0, 10000) }, WAIT_OBJECT_0 | WAIT_ABANDONED) {
        return Err("正在等待维护向导。".into());
    }
    let pipe_name = wide(&pipe_name);
    let pipe = unsafe {
        CreateNamedPipeW(
            pipe_name.as_ptr(),
            3 | 0x00080000,
            4 | 2 | 1 | 8,
            1,
            MAX_MESSAGE as u32,
            MAX_MESSAGE as u32,
            3000,
            &attributes,
        )
    };
    if pipe == INVALID_HANDLE {
        unsafe {
            ReleaseMutex(mutex.0);
        }
        return Err(failure());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = stop.clone();
    let pipe = Handle(pipe);
    let server = std::thread::spawn(move || serve(pipe, sid, own_session, shared, server_stop));
    Ok(Some(Owner { mutex, stop, server: Some(server) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_descriptor_is_private_and_rejects_sid_injection() {
        let sid = crate::current_user_sid().unwrap();
        assert!(Security::new(&sid).is_ok());
        assert!(Security::new("S-1-5-21)(A;;GA;;;WD)").is_err());
    }

    #[test]
    fn peer_verification_rejects_other_account_and_session() {
        let sid = crate::current_user_sid().unwrap();
        let pid = std::process::id();
        let own_session = session(pid).unwrap();
        assert!(Peer::verified(pid, "S-1-0-0", own_session).is_err());
        assert!(Peer::verified(pid, &sid, own_session.wrapping_add(1)).is_err());
    }

    #[test]
    fn application_images_and_unresolved_executable_claims_are_not_wizards() {
        let application = sidekickai_uninstall_core::product::product();
        assert!(!maintenance_image(Path::new(&application.executable)));
        for edition in application.editions.values() {
            assert!(!maintenance_image(Path::new(&edition.legacy_executable)));
        }
        let executable = std::env::current_exe().unwrap();
        assert!(executable_matches(&executable, &executable));
        assert!(!executable_matches(&executable, &executable.with_extension("unrelated")));
    }

    #[test]
    fn coordination_packets_reject_unknown_fields() {
        let request =
            br#"{"protocolVersion":1,"requestId":"request","entry":"entry","executable":"E:/setup.exe","extra":true}"#;
        let response = br#"{"protocolVersion":1,"requestId":"request","decision":"activate","extra":true}"#;
        assert!(serde_json::from_slice::<Request>(request).is_err());
        assert!(serde_json::from_slice::<Response>(response).is_err());
    }
}
