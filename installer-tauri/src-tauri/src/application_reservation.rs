use super::{process_image, process_started, verify_account_session};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sidekickai_uninstall_core::lock::PathLocks;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

pub(super) struct Reservation { file: PathBuf, request_id: String, _lock: PathLocks }
impl Reservation {
    pub(super) fn acquire(pipe: &str, executable: &Path, version: &str, edition: &str, owner_pid: u32) -> Result<Self, String> {
        let hash = pipe.strip_prefix("sidekick-editions-").filter(|value| value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or("程序启动协调标识无效。")?;
        let root = std::env::var_os("LOCALAPPDATA").ok_or("无法确认用户的本地协调目录。")?;
        let directory = Path::new(&root).join("SidekickAI-Startup/coordination").join(hash);
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        sidekickai_uninstall_host::harden_private_directory(&directory).map_err(|error| error.message)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let lock = loop {
            match PathLocks::acquire(std::slice::from_ref(&directory), "application-completion") {
                Ok(lock) => break lock,
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => return Err(error.message),
            }
        };
        let random = |label: &str| -> Result<String, String> {
            let value = sidekickai_uninstall_core::random_id(label).map_err(|error| error.message)?;
            Ok(value.rsplit('-').next().unwrap().to_string())
        };
        let request_id = format!("{}{}", random("launch")?, random("request")?);
        verify_account_session(owner_pid)?;
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, owner_pid) }.map_err(|error| error.to_string())?;
        struct Owned(HANDLE);
        impl Drop for Owned { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; } }
        let owner = Owned(handle);
        let mut session = 0;
        unsafe { ProcessIdToSessionId(owner_pid, &mut session) }.map_err(|error| error.to_string())?;
        let expires = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis() + 120000;
        let value = json!({ "protocol": 1, "requestId": request_id, "executable": executable, "edition": edition, "version": version,
            "pid": owner_pid, "ownerExecutable": process_image(owner.0)?, "ownerStarted": process_started(owner.0)?.to_string(),
            "sid": sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)?, "session": session, "expiresAt": expires as u64 });
        let file = directory.join("installation.json");
        sidekickai_uninstall_core::write_private_file(&file, &serde_json::to_vec(&value).map_err(|error| error.to_string())?).map_err(|error| error.message)?;
        Ok(Self { file, request_id, _lock: lock })
    }
    pub(super) fn request_id(&self) -> &str { &self.request_id }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if std::fs::read(&self.file).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|value| value["requestId"].as_str() == Some(&self.request_id)) { let _ = std::fs::remove_file(&self.file); }
    }
}

pub(super) fn current_request(executable: &Path, request_id: &str) -> Result<(), String> {
    if request_id.len() != 64 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("程序启动请求标识无效。".into()); }
    let data = super::inventory_data()?;
    let namespace = format!("{}|{}", data.home.to_lowercase(), data.session);
    #[cfg(test)]
    let namespace = std::env::var("SIDEKICK_APPLICATION_TEST_NAMESPACE").map(|value| format!("test:{value}")).unwrap_or(namespace);
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(format!("{namespace}|exclusive-application").as_bytes()));
    let root = std::env::var_os("LOCALAPPDATA").ok_or("无法确认用户本地目录。")?;
    let file = Path::new(&root).join("SidekickAI-Startup/coordination").join(&hash[..24]).join("installation.json");
    let bytes = std::fs::read(file).map_err(|error| error.to_string())?;
    if bytes.len() > 4096 { return Err("程序启动协调信息过大。".into()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis() as u64;
    if value["protocol"] != 1 || value["requestId"] != request_id || !value["executable"].as_str().is_some_and(|path| sidekickai_uninstall_core::path::paths_equal(Path::new(path), executable)) || value["expiresAt"].as_u64().is_none_or(|expires| expires <= now || expires > now + 180000) {
        return Err("程序启动协调不属于本次安装。".into());
    }
    let pid = value["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).ok_or("程序启动协调进程无效。")?;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }.map_err(|error| error.to_string())?;
    let result = (|| {
        if unsafe { WaitForSingleObject(handle, 0) == WAIT_OBJECT_0 } || value["ownerStarted"] != process_started(handle)?.to_string()
            || !value["ownerExecutable"].as_str().is_some_and(|path| process_image(handle).is_ok_and(|image| sidekickai_uninstall_core::path::paths_equal(Path::new(path), &image))) {
            return Err("程序启动协调进程身份已变化。".into());
        }
        verify_account_session(pid)
    })();
    let _ = unsafe { CloseHandle(handle) };
    result
}
