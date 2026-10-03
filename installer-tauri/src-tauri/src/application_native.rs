//! Bounded Windows process and pipe inspection without auxiliary processes.

use super::{Inventory, ProcessRecord, process_image, process_started};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, GENERIC_READ, GENERIC_WRITE, ERROR_IO_PENDING, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_NO_MORE_FILES, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{CreateEventW, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION};

struct Owned(HANDLE);
impl Drop for Owned { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; } }

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(process: HANDLE, class: u32, data: *mut std::ffi::c_void, length: u32, returned: *mut u32) -> i32;
}

#[repr(C)]
struct UnicodeString { length: u16, capacity: u16, buffer: PWSTR }

fn command_line(handle: HANDLE) -> Option<String> {
    let mut length = 0;
    unsafe { NtQueryInformationProcess(handle, 60, std::ptr::null_mut(), 0, &mut length); }
    if length < std::mem::size_of::<UnicodeString>() as u32 || length > 1024 * 1024 { return None; }
    let mut data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { NtQueryInformationProcess(handle, 60, data.as_mut_ptr().cast(), length, &mut length) } < 0 { return None; }
    let text = unsafe { &*data.as_ptr().cast::<UnicodeString>() };
    let base = data.as_ptr() as usize;
    let address = text.buffer.0 as usize;
    let end = base.checked_add(data.len() * std::mem::size_of::<usize>())?;
    if text.length % 2 != 0 || address % 2 != 0 || address < base || address.checked_add(text.length as usize)? > end { return None; }
    Some(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text.buffer.0, text.length as usize / 2) }))
}

pub(super) fn inventory() -> Result<Inventory, String> {
    let mut session = 0;
    unsafe { ProcessIdToSessionId(std::process::id(), &mut session) }.map_err(|error| error.to_string())?;
    let snapshot = Owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|error| error.to_string())?);
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut processes = Vec::new();
    while next.is_ok() {
        let size = entry.szExeFile.iter().position(|value| *value == 0).unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..size]);
        if ["SidekickAI.exe", "SidekickAI-OpenSource.exe"].iter().any(|expected| name.eq_ignore_ascii_case(expected)) {
            let mut peer_session = 0;
            if unsafe { ProcessIdToSessionId(entry.th32ProcessID, &mut peer_session) }.is_ok() && session == peer_session {
                let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) }.ok().map(Owned);
                let (image, command, created) = handle.as_ref().map(|handle| (
                    process_image(handle.0).ok().map(|path| path.to_string_lossy().into_owned()),
                    command_line(handle.0), process_started(handle.0).ok()
                )).unwrap_or((None, None, None));
                processes.push(ProcessRecord { process_id: entry.th32ProcessID, parent_process_id: entry.th32ParentProcessID, executable_path: image, command_line: command, created });
            }
        }
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if next.as_ref().err().is_some_and(|error| error.code() != ERROR_NO_MORE_FILES.to_hresult()) { return Err(next.unwrap_err().to_string()); }
    let home = std::env::var("USERPROFILE").map_err(|_| "无法定位当前用户。")?;
    Ok(Inventory { session, home, processes })
}

fn connect(pipe: &str) -> Result<Owned, String> {
    if pipe.is_empty() || !pipe.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return Err("程序协调管道名称无效。".into()); }
    let path = format!("\\\\.\\pipe\\{pipe}").encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match unsafe { CreateFileW(PCWSTR(path.as_ptr()), GENERIC_READ.0 | GENERIC_WRITE.0, FILE_SHARE_MODE(0), None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, HANDLE::default()) } {
            Ok(handle) => return Ok(Owned(handle)),
            Err(error) if [ERROR_FILE_NOT_FOUND.to_hresult(), ERROR_PIPE_BUSY.to_hresult()].contains(&error.code()) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("无法连接程序协调管道：{error}")),
        }
    }
}

fn transfer(handle: HANDLE, deadline: Instant, operation: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>) -> Result<usize, String> {
    let event = Owned(unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(|error| error.to_string())?);
    let mut overlapped = OVERLAPPED { hEvent: event.0, ..Default::default() };
    if let Err(error) = operation(&mut overlapped) {
        if error.code() != ERROR_IO_PENDING.to_hresult() { return Err(error.to_string()); }
    }
    let remaining = deadline.saturating_duration_since(Instant::now()).as_millis().min(u32::MAX as u128) as u32;
    if unsafe { WaitForSingleObject(event.0, remaining) } != WAIT_OBJECT_0 {
        // Cancellation must finish before the overlapped buffer leaves scope.
        let _ = unsafe { CancelIoEx(handle, Some(&overlapped)) };
        let mut ignored = 0;
        let _ = unsafe { GetOverlappedResult(handle, &overlapped, &mut ignored, true) };
        return Err("程序协调响应超时。".into());
    }
    let mut transferred = 0;
    unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, false) }.map_err(|error| error.to_string())?;
    Ok(transferred as usize)
}

pub(super) fn peer(pipe: &str) -> Result<u32, String> {
    let connection = connect(pipe)?;
    let mut pid = 0;
    unsafe { GetNamedPipeServerProcessId(connection.0, &mut pid) }.map_err(|error| error.to_string())?;
    Ok(pid)
}

pub(super) fn request(pipe: &str, value: &Value) -> Result<Value, String> {
    let connection = connect(pipe)?;
    let mut pid = 0;
    unsafe { GetNamedPipeServerProcessId(connection.0, &mut pid) }.map_err(|error| error.to_string())?;
    let bytes = format!("{value}\n").into_bytes();
    let timeout = match value["action"].as_str() {
        Some("activate" | "shutdown") => Duration::from_secs(5),
        _ => Duration::from_millis(1500),
    };
    let deadline = Instant::now() + timeout;
    let mut written = 0;
    while written < bytes.len() {
        let count = transfer(connection.0, deadline, |overlapped| unsafe { WriteFile(connection.0, Some(&bytes[written..]), None, Some(overlapped)) })?;
        if count == 0 { return Err("程序协调连接已断开。".into()); }
        written += count;
    }
    let mut response = Vec::new();
    loop {
        let mut buffer = [0u8; 4096];
        let count = transfer(connection.0, deadline, |overlapped| unsafe { ReadFile(connection.0, Some(&mut buffer), None, Some(overlapped)) })?;
        if count == 0 { return Err("程序协调连接已断开。".into()); }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > 16384 { return Err("程序协调响应过大。".into()); }
        if let Some(end) = response.iter().position(|byte| *byte == b'\n') {
            let peer: Value = serde_json::from_slice(&response[..end]).map_err(|error| error.to_string())?;
            return Ok(json!({ "serverPid": pid, "peer": peer }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    struct Probe(Child);
    impl Drop for Probe {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }

    fn delayed_owner() -> (Probe, String) {
        let pipe = format!("sidekick-action-budget-{}", sidekickai_uninstall_core::random_id("pipe").unwrap());
        let script = r#"
const net = require('node:net');
const server = net.createServer(socket => {
  socket.on('error', () => {});
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    if (!input.includes('\n')) return;
    socket.removeAllListeners('data');
    setTimeout(() => socket.end(JSON.stringify({pid:process.pid,status:'yielding'}) + '\n'), 2000);
  });
});
server.listen(['', '', '.', 'pipe', process.env.PROBE_PIPE].join(String.fromCharCode(92)), () => console.log('ready'));
"#;
        let mut probe = Probe(Command::new("node").args(["-e", script]).env("PROBE_PIPE", &pipe)
            .creation_flags(0x08000000).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap());
        let mut ready = String::new();
        BufReader::new(probe.0.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        (probe, pipe)
    }

    #[test]
    fn verified_actions_allow_a_delayed_reply_without_losing_pipe_identity() {
        for action in ["activate", "shutdown"] {
            let (probe, pipe) = delayed_owner();
            let started = Instant::now();
            let reply = request(&pipe, &json!({ "protocol": 1, "action": action })).unwrap();
            assert_eq!(reply["serverPid"].as_u64(), Some(probe.0.id() as u64));
            assert_eq!(reply["peer"]["pid"].as_u64(), Some(probe.0.id() as u64));
            assert!(started.elapsed() >= Duration::from_millis(1900));
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[test]
    fn status_and_unknown_actions_keep_the_short_reply_deadline() {
        for action in ["status", "unknown", "shutdown-extra"] {
            let (_probe, pipe) = delayed_owner();
            let started = Instant::now();
            let error = request(&pipe, &json!({ "protocol": 1, "action": action })).unwrap_err();
            assert!(error.contains("超时"));
            assert!(started.elapsed() >= Duration::from_millis(1400));
            assert!(started.elapsed() < Duration::from_millis(1900));
        }
    }
}
