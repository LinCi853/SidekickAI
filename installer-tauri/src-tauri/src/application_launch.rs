//! Installation completion closes verified application owners before launching.
#[cfg(test)]
#[path = "application_launch_tests.rs"]
mod tests;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::os::windows::process::CommandExt;
use sidekickai_uninstall_core::{path::paths_equal, product};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

#[derive(Deserialize)]
struct Inventory { session: u32, home: String, processes: Vec<ProcessRecord> }
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessRecord { process_id: u32, executable_path: Option<String>, command_line: Option<String> }
struct Application { handle: HANDLE, pid: u32, executable: PathBuf, edition: String, version: String }
impl Drop for Application { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.handle) }; } }
impl Application {
    fn exited(&self) -> bool { unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 } }
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
    let data: Inventory = serde_json::from_str(&powershell("inventory", &[])?).map_err(|error| error.to_string())?;
    if data.home.is_empty() { return Err("无法确认当前用户。".into()); }
    let hash = format!("{:x}", Sha256::digest(format!("{}|{}|exclusive-application", data.home.to_lowercase(), data.session).as_bytes()));
    let pipe = format!("sidekick-editions-{}", &hash[..24]);
    let sid = sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)?;
    let mut applications = Vec::new();
    for record in data.processes {
        let Some(command) = record.command_line else { return Err("无法核对已有程序的启动身份，请先退出后重试。".into()); };
        if command.split_whitespace().any(|arg| arg.starts_with("--type=") || arg == "--export-user-data") { continue; }
        let executable = PathBuf::from(record.executable_path.ok_or("无法读取已有程序位置，请先退出后重试。")?);
        let Some(directory) = executable.parent() else { continue; };
        let Some((edition, _)) = product::installation_edition(directory) else { continue; };
        if !paths_equal(&executable, &product::application_executable(directory)) { continue; }
        let version = product::package_identity(&directory.join("resources/app.asar"))?.version.ok_or("无法确认已有工百窗版本，请先退出后重试。")?;
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, record.process_id) }
            .map_err(|_| "无法确认已有工百窗进程，请先退出后重试。")?;
        let application = Application { handle, pid: record.process_id, executable, edition: edition.into(), version };
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

fn request(pipe: &str, value: Value) -> Result<Value, String> {
    serde_json::from_str(&powershell("request", &[("SIDEKICK_LAUNCH_PIPE", pipe.into()), ("SIDEKICK_LAUNCH_REQUEST", value.to_string())])?).map_err(|error| error.to_string())
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
    if !executable.is_file() || !product::owns_installation(directory) || identity.version.as_deref() != Some(env!("CARGO_PKG_VERSION")) {
        return Err("无法确认本次安装的程序，请修复安装后再打开。".into());
    }
    Ok(())
}

fn wait_for_exit(pipe: &str, applications: &[Application], timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut requested = std::collections::HashSet::new();
    let mut legacy_requested = std::collections::HashSet::new();
    while applications.iter().any(|app| !app.exited()) {
        if Instant::now() >= deadline { return Err("已有工百窗尚未完成保存退出。请处理关闭确认或从托盘退出，再点击完成。".into()); }
        match request(pipe, json!({ "protocol": 1, "edition": product::edition_id(), "action": "status" })) {
            Ok(peer) => {
                let shutdown = shutdown_request(&peer, applications)?;
                let pid = peer["pid"].as_u64().unwrap();
                match peer["status"].as_str() {
                    Some("busy") | Some("denied") => return Err("已有工百窗正在处理数据或未能保存。请处理后再点击完成。".into()),
                    Some("running") if !requested.contains(&pid) => {
                        let reply = match request(pipe, shutdown) {
                            Ok(reply) => reply,
                            Err(_) if applications.iter().all(Application::exited) => return Ok(()),
                            Err(error) => return Err(error),
                        };
                        shutdown_request(&reply, applications)?;
                        if reply["status"] != "yielding" { return Err("已有工百窗未接受保存退出，请处理后再点击完成。".into()); }
                        requested.insert(pid);
                    }
                    Some("starting" | "yielding" | "running") => {},
                    _ => return Err("无法确认已有工百窗状态，请先退出后重试。".into()),
                }
            }
            Err(_) => {
                for app in applications.iter().filter(|app| !app.exited()) {
                    if legacy_requested.insert(app.pid as u64) {
                        powershell("close", &[("SIDEKICK_LAUNCH_PID", app.pid.to_string()), ("SIDEKICK_LAUNCH_EXECUTABLE", app.executable.to_string_lossy().into_owned())])?;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

pub fn launch(executable: &Path, argument: &str) -> Result<(), String> {
    validate_target(executable)?;
    let (pipe, applications) = inventory()?;
    wait_for_exit(&pipe, &applications, Duration::from_secs(30))?;
    if !inventory()?.1.is_empty() { return Err("另一个工百窗刚刚启动，请先退出后再点击完成。".into()); }
    validate_target(executable)?;
    let mut child = Command::new(executable).arg(argument).spawn().map_err(|error| format!("本次安装的程序未能启动：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            return Err("本次安装的程序已退出，未能确认窗口打开。请处理启动提示后重试。".into());
        }
        if let Ok(peer) = request(&pipe, json!({ "protocol": 1, "edition": product::edition_id(), "action": "status" })) {
            if peer["pid"].as_u64() != Some(child.id() as u64) || peer["edition"] != product::edition_id()
                || peer["version"] != env!("CARGO_PKG_VERSION") || !peer["executable"].as_str().is_some_and(|path| paths_equal(Path::new(path), executable)) {
                return Err("启动期间出现了另一工百窗实例，未能打开本次安装。请先退出已有程序后重试。".into());
            }
            if peer["status"] == "running" { return Ok(()); }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("程序已收到启动请求，但尚未确认本次安装的窗口打开。请检查启动提示后重试。".into())
}
