//! Save-first shutdown of applications bound to a verified installation.

#[path = "shutdown_pipe.rs"]
mod pipe;
#[cfg(test)]
#[path = "shutdown_tests.rs"]
mod tests;
#[cfg(test)]
pub(crate) use tests::assert_save_without_data_locks;

use super::process::target_processes;
use super::super::identity::{current_user_sid, process_user_sid};
use sidekickai_uninstall_core::path::{paths_equal, NormalizedAbsolutePath};
use sidekickai_uninstall_core::{product, protocol::*};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

struct Application {
    handle: HANDLE,
    pid: u32,
    started: u64,
    executable: PathBuf,
    edition: String,
    version: String,
    main: bool,
}

impl Drop for Application { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.handle) }; } }
impl Application { fn exited(&self) -> bool { unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 } } }

pub(super) struct Prepared {
    applications: Vec<Application>,
    controller: HANDLE,
}
impl Drop for Prepared { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.controller) }; } }
impl Prepared { fn controller_alive(&self) -> bool { unsafe { WaitForSingleObject(self.controller, 0) == windows::Win32::Foundation::WAIT_TIMEOUT } } }

fn failure(operation_id: &str, message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::ProcessStopFailed, message, UninstallPhase::Stopping, true, operation_id)
}

fn started(handle: HANDLE) -> Result<u64, String> {
    let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }.map_err(|error| error.to_string())?;
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

fn image(handle: HANDLE) -> Result<PathBuf, String> {
    let mut buffer = [0u16; 32768];
    let mut length = buffer.len() as u32;
    unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length) }.map_err(|error| error.to_string())?;
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
}

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

fn protected_role(command: &str) -> bool {
    command.split_whitespace().map(|argument| argument.trim_matches('"')).any(|argument| {
        ["--worker", "--elevated", "--uninstall", "--export-user-data", "--sidekick-cookie-worker", "--backup-cookie-snapshot", "--backup-snapshot-worker", "--backup-recovery-guardian", "--sidekick-startup-authorize", "--sidekick-process-authorize"]
            .iter().any(|name| argument == *name || argument.strip_prefix(name).is_some_and(|suffix| suffix.starts_with('=')))
    })
}

fn inspect(handle: HANDLE, pid: u32, targets: &[NormalizedAbsolutePath]) -> Result<(PathBuf, String, String, bool), String> {
    let executable = image(handle)?;
    let root = executable.parent().ok_or("无法核对程序目录。")?;
    if !targets.iter().any(|target| paths_equal(target.as_path(), root)) || !paths_equal(&executable, &product::application_executable(root)) {
        return Err(format!("目标目录仍有非主应用程序运行（PID {pid}），未终止该程序。"));
    }
    let command = command_line(handle).ok_or_else(|| format!("无法核对进程角色（PID {pid}）。"))?;
    if protected_role(&command) { return Err(format!("维护或授权工作进程仍在运行（PID {pid}），未终止该程序。")); }
    let mut own_session = 0;
    let mut peer_session = 0;
    unsafe {
        ProcessIdToSessionId(std::process::id(), &mut own_session).map_err(|error| error.to_string())?;
        ProcessIdToSessionId(pid, &mut peer_session).map_err(|error| error.to_string())?;
    }
    if own_session != peer_session || process_user_sid(pid).map_err(|error| error.message)? != current_user_sid().map_err(|error| error.message)? {
        return Err(format!("进程属于其他账户或会话（PID {pid}），未终止该程序。"));
    }
    let (edition, _) = product::installation_edition(root).ok_or("无法核对运行程序的安装身份。")?;
    let version = product::package_identity(&root.join("resources/app.asar"))?.version.filter(|value| !value.is_empty()).ok_or("无法核对运行程序的版本身份。")?;
    let main = !command.split_whitespace().any(|argument| argument.trim_matches('"').starts_with("--type="));
    Ok((executable, edition.into(), version, main))
}

fn capture(targets: &[NormalizedAbsolutePath], operation_id: &str) -> Result<Vec<Application>, UninstallError> {
    let mut applications = Vec::new();
    for pid in target_processes(targets)? {
        let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => handle,
            Err(_) if !target_processes(targets)?.contains(&pid) => continue,
            Err(error) => return Err(failure(operation_id, format!("无法核对进程 {pid}：{error}"))),
        };
        let mut application = Application { handle, pid, started: 0, executable: PathBuf::new(), edition: String::new(), version: String::new(), main: false };
        if application.exited() { continue; }
        let identity = inspect(handle, pid, targets);
        if application.exited() { continue; }
        let (executable, edition, version, main) = identity.map_err(|error| failure(operation_id, error))?;
        application.started = started(handle).map_err(|error| failure(operation_id, error))?;
        application.executable = executable;
        application.edition = edition;
        application.version = version;
        application.main = main;
        applications.push(application);
    }
    Ok(applications)
}

pub(super) fn validate_process(handle: HANDLE, pid: u32, targets: &[NormalizedAbsolutePath], prepared: &Prepared, operation_id: &str) -> Result<(), UninstallError> {
    if !prepared.controller_alive() { return Err(failure(operation_id, "卸载向导已退出，未继续终止进程。")); }
    let original = prepared.applications.iter().find(|application| application.pid == pid).ok_or_else(|| failure(operation_id, format!("关闭期间出现新进程（PID {pid}），尚未删除内容。")))?;
    let (executable, edition, version, _) = inspect(handle, pid, targets).map_err(|error| failure(operation_id, error))?;
    if started(handle).map_err(|error| failure(operation_id, error))? != original.started || !paths_equal(&executable, &original.executable)
        || edition != original.edition || version != original.version {
        return Err(failure(operation_id, "关闭期间进程身份变化，尚未删除内容。"));
    }
    Ok(())
}

fn verify_reply(response: Value, application: &Application) -> Result<Value, String> {
    let peer = &response["peer"];
    if response["serverPid"].as_u64() != Some(application.pid as u64) || peer["pid"].as_u64() != Some(application.pid as u64)
        || peer["protocol"] != 1 || peer["edition"] != application.edition || peer["version"] != application.version
        || !peer["executable"].as_str().is_some_and(|value| paths_equal(Path::new(value), &application.executable)) {
        return Err("程序协调身份不匹配，未终止或删除内容。".into());
    }
    if peer["status"] == "denied" {
        return Err("应用未能完成保存，已保留应用和原资料。".into());
    }
    if peer["intent"] == "installation" { return Err("应用正在完成安装维护，尚未删除内容。".into()); }
    if !matches!(peer["status"].as_str(), Some("running" | "busy" | "starting" | "yielding")) { return Err("无法核对应用保存状态。".into()); }
    Ok(peer.clone())
}

fn save_and_wait(applications: &[Application], endpoint: &str, deadline: Instant, operation_id: &str, controller_alive: impl Fn() -> bool) -> Result<(), UninstallError> {
    let mut requested = HashSet::new();
    let mut acknowledged = HashSet::new();
    while applications.iter().any(|application| application.main && !application.exited()) && Instant::now() < deadline {
        for application in applications.iter().filter(|application| application.main && !application.exited()) {
            if !controller_alive() { return Err(failure(operation_id, "卸载向导已退出，未继续关闭应用。")); }
            let status = pipe::request(endpoint, application.pid, &json!({ "protocol": 1, "edition": application.edition, "action": "status" }), deadline);
            if application.exited() { continue; }
            let status = match status {
                Ok(response) => verify_reply(response, application).map_err(|error| failure(operation_id, error))?,
                Err(error) if error.contains("身份不匹配") => return Err(failure(operation_id, error)),
                Err(_) => continue,
            };
            if status["retryableHandoff"] == true && requested.contains(&application.pid) {
                return Err(failure(operation_id, "应用未能完成本次保存，已保留应用和原资料。"));
            }
            if status["status"] == "yielding" {
                acknowledged.insert(application.pid);
                requested.insert(application.pid);
                continue;
            }
            if status["status"] != "starting" && !acknowledged.contains(&application.pid) {
                requested.insert(application.pid);
                if !controller_alive() { return Err(failure(operation_id, "卸载向导已退出，未继续关闭应用。")); }
                let response = pipe::request(endpoint, application.pid, &json!({ "protocol": 1, "edition": application.edition,
                    "version": application.version, "executable": application.executable, "requestId": operation_id, "action": "shutdown" }), deadline);
                if application.exited() { continue; }
                match response {
                    Ok(response) => {
                        let peer = verify_reply(response, application).map_err(|error| failure(operation_id, error))?;
                        if peer["retryableHandoff"] == true { return Err(failure(operation_id, "应用未能完成本次保存，已保留应用和原资料。")); }
                        if peer["status"] == "yielding" { acknowledged.insert(application.pid); }
                    }
                    Err(error) if error.contains("身份不匹配") => return Err(failure(operation_id, error)),
                    Err(_) => {}
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if applications.iter().any(|application| acknowledged.contains(&application.pid) && !application.exited()) {
        return Err(failure(operation_id, "应用保存退出尚未完成，已保留应用和原资料。"));
    }
    Ok(())
}

pub(super) fn prepare(targets: &[NormalizedAbsolutePath], operation_id: &str, controller_pid: u32) -> Result<Prepared, UninstallError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let controller = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, controller_pid) }
        .map_err(|error| failure(operation_id, format!("无法核对卸载向导：{error}")))?;
    let mut prepared = Prepared { applications: Vec::new(), controller };
    if !prepared.controller_alive() { return Err(failure(operation_id, "卸载向导已退出。")); }
    prepared.applications = capture(targets, operation_id)?;
    if prepared.applications.iter().all(|application| !application.main) { return Ok(prepared); }
    let mut session = 0;
    unsafe { ProcessIdToSessionId(std::process::id(), &mut session) }.map_err(|error| failure(operation_id, error.to_string()))?;
    let home = std::env::var("USERPROFILE").map_err(|_| failure(operation_id, "无法核对当前用户资料位置。"))?;
    let hash = format!("{:x}", Sha256::digest(format!("{}|{session}|exclusive-application", home.to_lowercase()).as_bytes()));
    let endpoint = format!("sidekick-editions-{}", &hash[..24]);
    #[cfg(test)]
    let endpoint = tests::endpoint().unwrap_or(endpoint);
    save_and_wait(&prepared.applications, &endpoint, deadline, operation_id, || prepared.controller_alive())?;
    Ok(prepared)
}
