//! Installation completion closes verified application owners before launching.
#[cfg(test)]
#[path = "application_launch_tests.rs"]
mod tests;
#[path = "application_reservation.rs"]
mod reservation;
#[path = "application_native.rs"]
mod native;
#[cfg(all(test, feature = "native-ui-acceptance"))]
#[path = "application_completion_ui_tests.rs"]
mod ui_tests;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::os::windows::process::CommandExt;
use sidekickai_uninstall_core::{path::paths_equal, product};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

#[derive(Deserialize)]
struct Inventory { session: u32, home: String, processes: Vec<ProcessRecord> }
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessRecord { process_id: u32, #[serde(default)] parent_process_id: u32, executable_path: Option<String>, command_line: Option<String>, #[serde(default)] created: Option<u64> }
struct Application { handle: HANDLE, pid: u32, executable: PathBuf, edition: String, version: String }
#[derive(Debug)]
enum RequestError { IdentityMismatch, Unavailable(String) }
impl std::fmt::Display for RequestError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::IdentityMismatch => output.write_str("工百窗协调进程身份不匹配。"), Self::Unavailable(message) => output.write_str(message) }
    }
}
impl Drop for Application { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.handle) }; } }
impl Application {
    fn exited(&self) -> bool { unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 } }
}

fn process_image(handle: HANDLE) -> Result<PathBuf, String> {
    let mut buffer = [0u16; 32768];
    let mut size = buffer.len() as u32;
    unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut size) }.map_err(|error| error.to_string())?;
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])))
}

fn process_started(handle: HANDLE) -> Result<u64, String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }.map_err(|error| error.to_string())?;
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

fn verify_account_session(pid: u32) -> Result<(), String> {
    let mut own = 0;
    let mut peer = 0;
    unsafe {
        ProcessIdToSessionId(std::process::id(), &mut own).map_err(|error| error.to_string())?;
        ProcessIdToSessionId(pid, &mut peer).map_err(|error| error.to_string())?;
    }
    if own != peer || sidekickai_uninstall_host::process_user_sid(pid).map_err(|error| error.message)? != sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)? {
        return Err("工百窗进程账户或会话不匹配。".into());
    }
    Ok(())
}

fn process_snapshot_matches(started: u64, created: Option<u64>) -> bool {
    // CIM creation timestamps have microsecond precision.
    created.is_some_and(|snapshot| snapshot > 0 && snapshot / 10 == started / 10)
}

fn capture_owned_descendant(application: &Application, record: &ProcessRecord, parent_started: u64) -> Option<Application> {
    let child = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, record.process_id) }.ok()?;
    let mut captured = Application { handle: child, pid: record.process_id, executable: PathBuf::new(), edition: application.edition.clone(), version: application.version.clone() };
    let started = process_started(child).ok()?;
    if captured.exited() || !process_snapshot_matches(started, record.created) || started < parent_started { return None; }
    captured.executable = process_image(child).ok()?;
    let root = application.executable.parent()?;
    let owned_image = paths_equal(&captured.executable, &application.executable)
        || sidekickai_uninstall_core::path::path_is_same_or_descendant(&captured.executable, &root.join("resources"));
    let name = captured.executable.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let maintenance = ["uninstall", "installer", "setup"].iter().any(|value| name.contains(value))
        || record.command_line.as_ref().is_some_and(|command| command.split_whitespace().any(|arg| matches!(arg.trim_matches('"'), "--worker" | "--elevated" | "--uninstall" | "--export-user-data")));
    if owned_image && !maintenance && verify_account_session(record.process_id).is_ok() { Some(captured) } else { None }
}

fn capture_owned_descendants(application: &Application, records: &[ProcessRecord]) -> Result<Vec<Application>, String> {
    let mut parents = HashMap::from([(application.pid, process_started(application.handle)?)]);
    let mut seen = HashSet::new();
    let mut descendants = Vec::new();
    loop {
        let mut changed = false;
        for record in records {
            if record.process_id == application.pid || seen.contains(&record.process_id) { continue; }
            let Some(parent_started) = parents.get(&record.parent_process_id).copied() else { continue; };
            seen.insert(record.process_id);
            if let Some(captured) = capture_owned_descendant(application, record, parent_started) {
                parents.insert(captured.pid, process_started(captured.handle)?);
                descendants.push(captured);
                changed = true;
            }
        }
        if !changed { return Ok(descendants); }
    }
}

fn terminate_application(application: &Application, alive: &dyn Fn() -> Result<bool, String>) -> Result<Vec<Application>, String> {
    require_live_controller(alive)?;
    if application.exited() { return Ok(Vec::new()); }
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, application.pid) }.map_err(|error| error.to_string())?;
    let owner = Application { handle, pid: application.pid, executable: application.executable.clone(), edition: application.edition.clone(), version: application.version.clone() };
    if owner.exited() { return Ok(Vec::new()); }
    if !paths_equal(&process_image(handle)?, &application.executable) || process_started(handle)? != process_started(application.handle)? {
        return Err("工百窗进程身份已改变。".into());
    }
    verify_account_session(application.pid)?;
    let records: Vec<ProcessRecord> = serde_json::from_str(&powershell("descendants", &[("SIDEKICK_LAUNCH_PID", application.pid.to_string())])?).map_err(|error| error.to_string())?;
    let mut descendants = capture_owned_descendants(&owner, &records)?;
    require_live_controller(alive)?;
    unsafe { TerminateProcess(handle, 0) }.map_err(|error| error.to_string())?;
    for child in &descendants {
        if !child.exited() {
            require_live_controller(alive)?;
            unsafe { TerminateProcess(child.handle, 0) }.map_err(|error| error.to_string())?;
        }
    }
    descendants.push(owner);
    Ok(descendants)
}

fn terminate_applications(applications: &[Application], alive: &dyn Fn() -> Result<bool, String>) -> Result<(), String> {
    let mut terminated = Vec::new();
    for application in applications { terminated.extend(terminate_application(application, alive)?); }
    let deadline = Instant::now() + Duration::from_secs(5);
    while terminated.iter().any(|application| !application.exited()) {
        if Instant::now() >= deadline { return Err("正在等待工百窗释放程序和数据。".into()); }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn powershell(action: &str, variables: &[(&str, String)]) -> Result<String, String> {
    let system = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 运行环境。")?;
    let mut command = Command::new(Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("application-launch.ps1")])
        .env("SIDEKICK_LAUNCH_ACTION", action).creation_flags(0x08000000)
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    for (key, value) in variables { command.env(key, value); }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let read = |stream: Box<dyn Read + Send>| std::thread::spawn(move || { let mut bytes = Vec::new(); let _ = stream.take(1024 * 1024).read_to_end(&mut bytes); bytes });
    let output = read(Box::new(child.stdout.take().unwrap()));
    let errors = read(Box::new(child.stderr.take().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(12);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? { break status; }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err("核对已有程序超时，请先保存并退出后重试。".into()); }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = output.join().map_err(|_| "无法读取启动检查结果。")?;
    let stderr = errors.join().map_err(|_| "无法读取启动检查错误。")?;
    if !status.success() { return Err(String::from_utf8_lossy(&stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

fn inventory() -> Result<(String, Vec<Application>), String> {
    inventory_in_scope(None)
}

fn inventory_in_scope(pids: Option<&[u32]>) -> Result<(String, Vec<Application>), String> {
    let data = inventory_data()?;
    if data.home.is_empty() { return Err("无法确认当前用户。".into()); }
    let namespace = format!("{}|{}", data.home.to_lowercase(), data.session);
    #[cfg(test)]
    let namespace = std::env::var("SIDEKICK_APPLICATION_TEST_NAMESPACE").map(|value| format!("test:{value}")).unwrap_or(namespace);
    let hash = format!("{:x}", Sha256::digest(format!("{namespace}|exclusive-application").as_bytes()));
    let pipe = format!("sidekick-editions-{}", &hash[..24]);
    let sid = sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)?;
    let mut applications = Vec::new();
    for record in &data.processes {
        if pids.is_some_and(|pids| !pids.contains(&record.process_id)) { continue; }
        if !is_application_owner(record, &data.processes) { continue; }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, record.process_id) }.map_err(|error| error.to_string())?;
        let executable = match process_image(handle) { Ok(path) => path, Err(error) => { let _ = unsafe { CloseHandle(handle) }; return Err(error); } };
        let mut guard = Application { handle, pid: record.process_id, executable: executable.clone(), edition: String::new(), version: String::new() };
        if guard.exited() { continue; }
        if record.created.is_some() && !process_snapshot_matches(process_started(handle)?, record.created) { continue; }
        let Some(directory) = executable.parent() else { continue; };
        let Some((edition, _)) = product::installation_edition(directory) else { continue; };
        if !paths_equal(&executable, &product::application_executable(directory)) { continue; }
        let version = product::package_identity(&directory.join("resources/app.asar"))?.version.ok_or("无法确认已有工百窗版本，请先退出后重试。")?;
        guard.edition = edition.into();
        guard.version = version;
        let application = guard;
        if application.exited() { continue; }
        let mut buffer = [0u16; 32768];
        let mut size = buffer.len() as u32;
        unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut size) }.map_err(|error| error.to_string())?;
        if !paths_equal(Path::new(&String::from_utf16_lossy(&buffer[..size as usize])), &application.executable) { return Err("已有程序身份发生变化，请重试。".into()); }
        if sidekickai_uninstall_host::process_user_sid(record.process_id).map_err(|error| error.message)? != sid { continue; }
        applications.push(application);
    }
    Ok((pipe, applications))
}

fn inventory_data() -> Result<Inventory, String> {
    let data = native::inventory()?;
    #[cfg(test)]
    let data = if let Ok(root) = std::env::var("SIDEKICK_APPLICATION_TEST_ROOT") {
        let processes = data.processes.into_iter().filter(|record| {
            let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, record.process_id) }) else { return false; };
            let mut buffer = [0u16; 32768];
            let mut size = buffer.len() as u32;
            let result = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut size) };
            let _ = unsafe { CloseHandle(handle) };
            result.is_ok() && sidekickai_uninstall_core::path::path_is_same_or_descendant(Path::new(&String::from_utf16_lossy(&buffer[..size as usize])), Path::new(&root))
        }).collect();
        Inventory { processes, ..data }
    } else { data };
    Ok(data)
}

fn request(pipe: &str, value: Value) -> Result<Value, RequestError> {
    let response = native::request(pipe, &value).map_err(RequestError::Unavailable)?;
    if response["serverPid"].as_u64().filter(|pid| *pid > 0) != response["peer"]["pid"].as_u64() {
        return Err(RequestError::IdentityMismatch);
    }
    Ok(response["peer"].clone())
}

fn shutdown_request(peer: &Value, applications: &[Application]) -> Result<Value, String> {
    let target = applications.iter().find(|app| peer["pid"].as_u64() == Some(app.pid as u64)).ok_or("已有程序的协调身份不匹配，请先退出后重试。")?;
    if peer["protocol"] != 1 || peer["edition"] != target.edition || peer["version"] != target.version
        || !peer["executable"].as_str().is_some_and(|exe| paths_equal(Path::new(exe), &target.executable)) {
        return Err("已有程序的协调身份不匹配，请先退出后重试。".into());
    }
    // Maintenance targets the verified owner, independent of the new edition.
    Ok(json!({ "protocol": 1, "edition": target.edition, "version": target.version, "executable": target.executable, "action": "shutdown" }))
}

pub fn validate_target(executable: &Path) -> Result<(), String> {
    let directory = executable.parent().ok_or("安装目录无效。")?;
    let identity = product::package_identity(&directory.join("resources/app.asar"))?;
    let version = crate::setup_metadata::current()?.product_version.as_str();
    if !executable.is_file() || !product::owns_installation(directory) || identity.version.as_deref() != Some(version) {
        return Err("无法确认本次安装的程序，请修复安装后再打开。".into());
    }
    Ok(())
}

fn wait_for_exit(pipe: &str, applications: &[Application], timeout: Duration) -> Result<(), String> {
    wait_for_exit_guarded(pipe, applications, timeout, &|| Ok(true))
}

fn require_live_controller(alive: &dyn Fn() -> Result<bool, String>) -> Result<(), String> {
    if alive()? { Ok(()) } else { Err("安装向导已经退出，未执行的程序启动与终止操作已取消。".into()) }
}

fn wait_for_exit_guarded(pipe: &str, applications: &[Application], timeout: Duration, alive: &dyn Fn() -> Result<bool, String>) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut requested = std::collections::HashSet::new();
    let mut legacy_requested = std::collections::HashSet::new();
    while applications.iter().any(|app| !app.exited()) {
        require_live_controller(alive)?;
        if Instant::now() >= deadline {
            return terminate_applications(applications, alive);
        }
        match request(pipe, json!({ "protocol": 1, "edition": product::edition_id(), "action": "status" })) {
            Ok(peer) => {
                let shutdown = shutdown_request(&peer, applications)?;
                let pid = peer["pid"].as_u64().unwrap();
                match peer["status"].as_str() {
                    Some("running" | "busy" | "denied") if !requested.contains(&pid) => {
                        let reply = match request(pipe, shutdown) {
                            Ok(reply) => reply,
                            Err(_) if applications.iter().all(Application::exited) => return Ok(()),
                            Err(error) => return Err(error.to_string()),
                        };
                        shutdown_request(&reply, applications)?;
                        requested.insert(pid);
                        if reply["status"] == "denied" || peer["retryableHandoff"] == true {
                            require_live_controller(alive)?;
                            return terminate_applications(applications, alive);
                        }
                    }
                    Some("busy") if peer["retryableHandoff"] == true => {
                        require_live_controller(alive)?;
                        return terminate_applications(applications, alive);
                    },
                    Some("starting" | "yielding" | "running" | "busy" | "denied") => {},
                    _ => return Err("无法确认已有工百窗状态，请先退出后重试。".into()),
                }
            }
            Err(error @ RequestError::IdentityMismatch) => return Err(error.to_string()),
            Err(_) => {
                if let Ok(pid) = native::peer(pipe) {
                    if !applications.iter().any(|app| pid == app.pid) { return Err(RequestError::IdentityMismatch.to_string()); }
                }
                for app in applications.iter().filter(|app| !app.exited()) {
                    if legacy_requested.insert(app.pid as u64) {
                        require_live_controller(alive)?;
                        let _ = powershell("close", &[("SIDEKICK_LAUNCH_PID", app.pid.to_string()), ("SIDEKICK_LAUNCH_EXECUTABLE", app.executable.to_string_lossy().into_owned())]);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

pub fn stop_installations(targets: &[PathBuf]) -> Result<(), String> {
    let normalized = targets.iter().map(|target| sidekickai_uninstall_core::path::NormalizedAbsolutePath::parse_target(target)
        .map_err(|error| error.message)).collect::<Result<Vec<_>, _>>()?;
    let processes = sidekickai_uninstall_host::target_processes(&normalized).map_err(|error| error.message)?;
    if processes.is_empty() { return Ok(()); }
    let (pipe, applications) = inventory_in_scope(Some(&processes))?;
    let selected: Vec<_> = applications.into_iter().filter(|app| targets.iter().any(|target|
        sidekickai_uninstall_core::path::path_is_same_or_descendant(&app.executable, target))).collect();
    wait_for_exit(&pipe, &selected, Duration::from_secs(30))?;
    if !sidekickai_uninstall_host::target_processes(&normalized).map_err(|error| error.message)?.is_empty() {
        return Err("目标目录内仍有程序未正常退出。已停止替换，请先保存并退出后重试。".into());
    }
    Ok(())
}

pub fn needs_elevated_inspection(_executable: &Path) -> Result<bool, String> {
    if crate::elevate::is_process_elevated() { return Ok(false); }
    let data = inventory_data()?;
    Ok(inspection_requires_elevation(&data.processes))
}

fn inspection_requires_elevation(records: &[ProcessRecord]) -> bool {
    records.iter().any(|record| {
        if !is_application_owner(record, records) { return false; }
        record.command_line.is_none() || record.executable_path.is_none()
            || sidekickai_uninstall_host::process_user_sid(record.process_id).is_err()
            || requires_privileged_control(record.process_id)
    })
}

fn is_application_owner(record: &ProcessRecord, records: &[ProcessRecord]) -> bool {
    !record.command_line.as_ref().is_some_and(|command| command.split_whitespace().any(|arg|
        arg.starts_with("--type=") || matches!(arg.trim_matches('"'), "--export-user-data" | "--sidekick-cookie-worker" | "--worker" | "--elevated" | "--uninstall")))
        && !records.iter().any(|parent| parent.process_id == record.parent_process_id && parent.executable_path == record.executable_path && parent.executable_path.is_some())
}

fn requires_privileged_control(pid: u32) -> bool {
    match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(handle) => { let _ = unsafe { CloseHandle(handle) }; false },
        Err(_) => match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => { let alive = unsafe { WaitForSingleObject(handle, 0) } != WAIT_OBJECT_0; let _ = unsafe { CloseHandle(handle) }; alive },
            Err(_) => true,
        },
    }
}

fn verify_started_owner(peer: &Value, executable: &Path) -> Result<(), String> {
    if peer["protocol"] != 1 || peer["edition"] != product::edition_id()
        || peer["version"] != crate::setup_metadata::current()?.product_version
        || !peer["executable"].as_str().is_some_and(|path| paths_equal(Path::new(path), executable)) {
        return Err("启动期间出现了另一工百窗实例，未能打开本次安装。请先退出已有程序后重试。".into());
    }
    let pid = peer["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0)
        .ok_or("无法确认启动后的工百窗进程。")?;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }
        .map_err(|_| "无法核对启动后的工百窗进程。")?;
    let application = Application { handle, pid, executable: executable.into(), edition: product::edition_id().into(), version: peer["version"].as_str().unwrap().into() };
    if application.exited() { return Err("启动后的工百窗已退出，请处理后重试。".into()); }
    let mut buffer = [0u16; 32768];
    let mut size = buffer.len() as u32;
    unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut size) }
        .map_err(|error| error.to_string())?;
    let mut own_session = 0;
    let mut peer_session = 0;
    unsafe {
        ProcessIdToSessionId(std::process::id(), &mut own_session).map_err(|error| error.to_string())?;
        ProcessIdToSessionId(pid, &mut peer_session).map_err(|error| error.to_string())?;
    }
    if own_session != peer_session || !paths_equal(Path::new(&String::from_utf16_lossy(&buffer[..size as usize])), executable)
        || sidekickai_uninstall_host::process_user_sid(pid).map_err(|error| error.message)? != sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)? {
        return Err("启动后的工百窗账户、会话或程序位置不匹配。".into());
    }
    Ok(())
}

pub fn launch_reporting(executable: &Path, argument: &str, progress: &dyn Fn(&str)) -> Result<(), String> {
    launch_with_owner_reporting(executable, argument, std::process::id(), spawn_target, progress)
}

pub fn spawn_target(executable: &Path, argument: &str, request_id: &str) -> Result<(), String> {
    validate_target(executable)?;
    if !matches!(argument, "--show-guide" | "--skip-guide") { return Err("程序启动参数无效。".into()); }
    reservation::current_request(executable, request_id)?;
    let mut command = Command::new(executable);
    command.arg(argument).env("SIDEKICK_APPLICATION_INTENT", "installation").env("SIDEKICK_APPLICATION_REQUEST_ID", request_id);
    #[cfg(all(test, feature = "native-ui-acceptance"))]
    if let Ok(root) = std::env::var("SIDEKICK_APPLICATION_UI_BOOTSTRAP") {
        let root = PathBuf::from(root);
        let build = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build").canonicalize().map_err(|error| error.to_string())?;
        let canonical = root.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(&build) || !executable.canonicalize().map_err(|error| error.to_string())?.starts_with(&canonical) || !root.join("ui-fixture.json").is_file() {
            return Err("程序界面验证目录不属于本次隔离运行。".into());
        }
        let bootstrap = root.join("target-bootstrap");
        std::fs::create_dir_all(&bootstrap).map_err(|error| error.to_string())?;
        let output = std::fs::File::create_new(root.join("target-process.log")).map_err(|error| error.to_string())?;
        let errors = output.try_clone().map_err(|error| error.to_string())?;
        command.args(["--inspect-brk=0", "--remote-debugging-port=0"])
            .arg(format!("--user-data-dir={}", bootstrap.display())).stdout(Stdio::from(output)).stderr(Stdio::from(errors));
    }
    command.spawn().map(|_| ()).map_err(|error| format!("本次安装的程序未能启动：{error}"))
}

#[cfg(test)]
pub fn launch_with(executable: &Path, argument: &str, spawn: impl FnOnce(&Path, &str, &str) -> Result<(), String>) -> Result<(), String> {
    launch_with_owner(executable, argument, std::process::id(), spawn)
}

#[cfg(test)]
pub(crate) fn launch_with_owner(executable: &Path, argument: &str, owner_pid: u32, spawn: impl FnOnce(&Path, &str, &str) -> Result<(), String>) -> Result<(), String> {
    launch_with_owner_reporting(executable, argument, owner_pid, spawn, &|_| {})
}

pub(crate) fn launch_with_owner_reporting(executable: &Path, argument: &str, owner_pid: u32, spawn: impl FnOnce(&Path, &str, &str) -> Result<(), String>, progress: &dyn Fn(&str)) -> Result<(), String> {
    launch_with_owner_reporting_guarded(executable, argument, owner_pid, spawn, progress, &|| Ok(true))
}

pub(crate) fn launch_with_owner_reporting_guarded(executable: &Path, argument: &str, owner_pid: u32, spawn: impl FnOnce(&Path, &str, &str) -> Result<(), String>, progress: &dyn Fn(&str), alive: &dyn Fn() -> Result<bool, String>) -> Result<(), String> {
    require_live_controller(alive)?;
    validate_target(executable)?;
    progress("正在核对已有程序…");
    let (pipe, applications) = inventory()?;
    let reservation = reservation::Reservation::acquire(&pipe, executable, crate::setup_metadata::current()?.product_version.as_str(), product::edition_id(), owner_pid)?;
    if !applications.is_empty() { progress("正在保存并关闭已有程序…"); }
    wait_for_exit_guarded(&pipe, &applications, Duration::from_secs(30), alive)?;
    let concurrent = inventory()?.1;
    if !concurrent.is_empty() { wait_for_exit_guarded(&pipe, &concurrent, Duration::from_secs(5), alive)?; }
    require_live_controller(alive)?;
    validate_target(executable)?;
    progress("正在启动本次安装的程序…");
    spawn(executable, argument, reservation.request_id())?;
    progress("正在等待本次安装的窗口就绪…");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_error = None;
    while Instant::now() < deadline {
        require_live_controller(alive)?;
        match request(&pipe, json!({ "protocol": 1, "edition": product::edition_id(), "action": "status" })) {
            Ok(peer) => {
                verify_started_owner(&peer, executable)?;
                if peer["status"] == "running" { progress("本次安装的程序已打开，正在关闭向导…"); return Ok(()); }
            }
            Err(error @ RequestError::IdentityMismatch) => return Err(error.to_string()),
            Err(error) => last_error = Some(error.to_string()),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("程序已收到启动请求，但尚未确认本次安装的窗口打开。请检查启动提示后重试。{}", last_error.map(|error| format!("核对结果：{error}")).unwrap_or_default()))
}
