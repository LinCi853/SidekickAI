//! Restricted completion commands reuse the installation's authorized worker.

use super::{OperationRequest, PreparedOperation, OPERATION_PROTOCOL_VERSION};
use crate::{application_launch, application_user, elevate, engine, manifest::InstallRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

const IDLE_LIMIT: Duration = Duration::from_secs(600);
const SESSION_LIMIT: Duration = Duration::from_secs(1800);
const COMMAND_LIMIT: Duration = Duration::from_secs(100);
const MESSAGE_LIMIT: u64 = 64 * 1024;
struct State { session: Option<Session>, operation: Option<Arc<PreparedOperation>>, expected: Option<PathBuf>, failure: Option<String> }
static CURRENT: Mutex<State> = Mutex::new(State { session: None, operation: None, expected: None, failure: None });

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration { features: Map<String, Value>, options: Map<String, Value> }

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
enum Action { FlushConfig, OpenApplication }

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    protocol_version: u32,
    operation_id: String,
    nonce: String,
    sequence: u32,
    action: Action,
    configuration: Option<Configuration>,
    show_guide: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release { protocol_version: u32, operation_id: String, nonce: String }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding { protocol_version: u32, operation_id: String, nonce: String, pid: u32, started: u64, session: u32, executable: PathBuf }

struct PinnedDirectory { directory: HANDLE, request: HANDLE }
impl Drop for PinnedDirectory {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.request) };
        let _ = unsafe { CloseHandle(self.directory) };
    }
}
impl PinnedDirectory {
    fn open(path: &Path) -> Result<Self, String> {
        sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
        let name = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
        // The immutable request keeps the directory nonempty; directory write sharing permits atomic child results.
        let mut pinned = Self { directory: unsafe { CreateFileW(windows::core::PCWSTR(name.as_ptr()), (FILE_READ_ATTRIBUTES | DELETE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, HANDLE::default()) }.map_err(|error| error.to_string())?, request: HANDLE::default() };
        let request = path.join(super::REQUEST_FILE).as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
        pinned.request = unsafe { CreateFileW(windows::core::PCWSTR(request.as_ptr()), GENERIC_READ.0,
            FILE_SHARE_READ, None, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, HANDLE::default()) }.map_err(|error| error.to_string())?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(pinned.directory, &mut info) }.map_err(|error| error.to_string())?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err("完成操作路径不是普通目录。".into());
        }
        unsafe { GetFileInformationByHandle(pinned.request, &mut info) }.map_err(|error| error.to_string())?;
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT.0 | FILE_ATTRIBUTE_DIRECTORY.0) != 0 {
            return Err("完成操作请求不是普通文件。".into());
        }
        sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
        super::directory::verify_private_directory(path)?;
        Ok(pinned)
    }
}

struct Session {
    operation: Arc<PreparedOperation>,
    process: Arc<elevate::AuthorizedProcess>,
    executable: PathBuf,
    sequence: u32,
    opened: Instant,
    status_offset: usize,
    failed: bool,
}

fn read_private<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|error| error.to_string())?.take(MESSAGE_LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MESSAGE_LIMIT { return Err("完成操作信息过大。".into()); }
    serde_json::from_slice(&bytes).map_err(|error| format!("完成操作信息无效：{error}"))
}

fn write_private<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    sidekickai_uninstall_core::write_private_file(path, &serde_json::to_vec(value).map_err(|error| error.to_string())?).map_err(|error| error.message)
}

fn command_id(operation_id: &str, sequence: u32) -> String { format!("{operation_id}-completion-{sequence}") }
fn command_directory(request_path: &Path, sequence: u32) -> Result<PathBuf, String> {
    Ok(request_path.parent().ok_or("完成操作目录无效。")?.join(format!("completion-{sequence}")))
}

impl Session {
    fn execute(&mut self, action: Action, configuration: Option<Configuration>, show_guide: bool, progress: &dyn Fn(&str)) -> Result<(), String> {
        if self.failed || self.opened.elapsed() >= SESSION_LIMIT || self.process.exit_code()?.is_some() {
            return Err("本次安装的授权会话已结束。请关闭向导后重新运行安装器，不会自动再次请求授权。".into());
        }
        let sequence = self.sequence.checked_add(1).ok_or("完成操作次数超出限制。")?;
        let directory = command_directory(&self.operation.request_path, sequence)?;
        let command = Command { protocol_version: OPERATION_PROTOCOL_VERSION, operation_id: self.operation.operation_id.clone(), nonce: self.operation.nonce.clone(),
            sequence, action, configuration, show_guide };
        let prepared = (|| {
            std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
            super::directory::harden_private_directory(&directory)?;
            write_private(&directory.join("request.json"), &command)
        })();
        if let Err(error) = prepared {
            self.failed = true;
            self.request_release();
            return Err(format!("完成请求未能准备，授权会话已停止接收操作。请关闭向导后重新运行安装器：{error}"));
        }
        self.sequence = sequence;
        let id = command_id(&command.operation_id, command.sequence);
        let argument = if show_guide { "--show-guide" } else { "--skip-guide" };
        let mut responded = false;
        let started = Instant::now();
        loop {
            if self.operation.request_path.with_file_name("release.json").is_file() {
                self.failed = true;
                return Err("安装向导已经退出或交接已取消，完成操作已停止。".into());
            }
            if let Ok(text) = std::fs::read_to_string(&self.operation.log_path) {
                if let Some(end) = text.rfind('\n').map(|index| index + 1) {
                    if end >= self.status_offset {
                        for line in text[self.status_offset..end].lines() { if let Some(message) = line.strip_prefix("S|") { progress(message); } }
                    }
                    self.status_offset = end;
                }
            }
            if matches!(command.action, Action::OpenApplication) {
                // The authorized worker verifies readiness; only the ordinary controller launches.
                let _ = application_user::respond_to_launch_at(&directory.join("request.json"), &id, &command.nonce, &self.executable, argument, &mut responded);
            }
            let result_path = directory.join("result.json");
            if result_path.is_file() {
                let result: super::envelope::OperationResult = match read_private(&result_path) {
                    Ok(result) => result,
                    Err(error) => { self.failed = true; self.request_release(); return Err(error); }
                };
                if result.protocol_version != OPERATION_PROTOCOL_VERSION || result.operation_id != id || result.nonce != command.nonce {
                    self.failed = true;
                    self.request_release();
                    return Err("完成操作结果不属于本次授权请求。".into());
                }
                let raw = serde_json::to_string(&result).map_err(|error| error.to_string())?;
                return super::interpret_child_result(Some(&raw), 0, &id, &command.nonce);
            }
            if self.process.exit_code()?.is_some() || started.elapsed() >= COMMAND_LIMIT {
                self.failed = true;
                self.request_release();
                return Err("完成操作的授权执行器已退出或响应超时。请关闭向导后重新运行安装器，不会自动再次请求授权。".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn request_release(&self) {
        request_release(&self.operation);
    }
}

fn request_release(operation: &PreparedOperation) {
    if let Some(root) = operation.request_path.parent() {
        let release = Release { protocol_version: OPERATION_PROTOCOL_VERSION, operation_id: operation.operation_id.clone(), nonce: operation.nonce.clone() };
        let _ = write_private(&root.join("release.json"), &release);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.request_release();
        // Keep the private directory alive until the worker observes release or exits.
        let operation = self.operation.clone();
        let process = self.process.clone();
        std::thread::spawn(move || {
            while process.exit_code().ok().flatten().is_none() { std::thread::sleep(Duration::from_millis(100)); }
            drop(operation);
        });
    }
}

fn completed_without_session(session: Session, executable: &Path, detail: String) -> Result<(), String> {
    let message = format!("程序操作已完成，但完成授权会话不可用。请关闭向导后重新运行安装器：{detail}");
    crate::engine::write_log(&format!("S|{message}"));
    let mut state = CURRENT.lock().map_err(|_| "安装授权会话不可用。")?;
    state.expected = Some(executable.into());
    state.operation = Some(session.operation.clone());
    state.failure = Some(message);
    drop(state);
    drop(session);
    Ok(())
}

pub(crate) fn install(operation: Arc<PreparedOperation>, executable: &Path) -> Result<(), String> {
    release();
    let root = operation.request_path.parent().ok_or("安装授权目录无效。")?;
    let caller = Caller::inspect(std::process::id())?;
    let binding = Binding { protocol_version: OPERATION_PROTOCOL_VERSION, operation_id: operation.operation_id.clone(), nonce: operation.nonce.clone(),
        pid: std::process::id(), started: caller.started, session: caller.session, executable: caller.executable.clone() };
    write_private(&root.join("session-binding.json"), &binding)?;
    let session = Session { operation: operation.clone(), process: Arc::new(elevate::spawn_elevated(&operation.request_path)?), executable: executable.into(),
        sequence: 0, opened: Instant::now(), status_offset: 0, failed: false };
    wait_for_install(session, executable)
}

fn wait_for_install(mut session: Session, executable: &Path) -> Result<(), String> {
    let operation = session.operation.clone();
    let root = operation.request_path.parent().ok_or("安装授权目录无效。")?;
    loop {
        if operation.result_path.is_file() {
            let result: super::envelope::OperationResult = read_private(&operation.result_path)?;
            let raw = serde_json::to_string(&result).map_err(|error| error.to_string())?;
            super::interpret_child_result(Some(&raw), 0, &operation.operation_id, &operation.nonce)?;
            if root.join("session-ready.json").is_file() {
                let ready: Release = match read_private(&root.join("session-ready.json")) {
                    Ok(ready) => ready,
                    Err(error) => return completed_without_session(session, executable, error),
                };
                if ready.protocol_version != OPERATION_PROTOCOL_VERSION || ready.operation_id != operation.operation_id || ready.nonce != operation.nonce {
                    return completed_without_session(session, executable, "安装授权会话的就绪身份不匹配。".into());
                }
                if session.process.exit_code()?.is_some() {
                    return completed_without_session(session, executable, "授权执行器已经退出。".into());
                }
                session.status_offset = std::fs::read_to_string(&operation.log_path).map(|text| text.len()).unwrap_or(0);
                session.opened = Instant::now();
                let mut state = CURRENT.lock().map_err(|_| "安装授权会话不可用。")?;
                state.expected = Some(executable.into());
                state.operation = Some(operation.clone());
                state.failure = None;
                state.session = Some(session);
                return Ok(());
            }
        }
        if let Some(code) = session.process.exit_code()? {
            if operation.result_path.is_file() {
                let result: super::envelope::OperationResult = read_private(&operation.result_path)?;
                let raw = serde_json::to_string(&result).map_err(|error| error.to_string())?;
                super::interpret_child_result(Some(&raw), 0, &operation.operation_id, &operation.nonce)?;
                return completed_without_session(session, executable, "授权执行器未能就绪，请查看操作日志。".into());
            }
            return super::interpret_child_result(None, code, &operation.operation_id, &operation.nonce);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(crate) fn release() {
    let (session, operation) = match CURRENT.lock() {
        Ok(mut state) => (state.session.take(), state.operation.take()),
        Err(_) => return,
    };
    if let Some(operation) = operation { request_release(&operation); }
    drop(session);
}

pub(crate) fn reset() {
    release();
    if let Ok(mut state) = CURRENT.lock() { state.expected = None; state.failure = None; }
}

fn with_session(target: &Path, execute: impl FnOnce(&mut Session) -> Result<(), String>) -> Option<Result<(), String>> {
    let mut current = match CURRENT.lock() { Ok(current) => current, Err(_) => return Some(Err("安装授权会话不可用。".into())) };
    let Some(session) = current.session.as_ref() else {
        return current.expected.as_ref().map(|_| Err(current.failure.clone().unwrap_or_else(|| "本次安装的授权会话已结束。请关闭向导后重新运行安装器，不会自动再次请求授权。".into())));
    };
    if !sidekickai_uninstall_core::path::paths_equal(target, &session.executable) {
        return Some(Err("完成操作目标不属于本次安装授权。".into()));
    }
    let mut session = current.session.take().unwrap();
    drop(current);
    let result = execute(&mut session);
    if let Ok(mut current) = CURRENT.lock() {
        if current.operation.as_ref().is_some_and(|operation| Arc::ptr_eq(operation, &session.operation)) {
            current.session = Some(session);
        }
    }
    Some(result)
}

pub(crate) fn flush_config(request: &InstallRequest) -> Option<Result<(), String>> {
    with_session(&Path::new(&request.install_dir).join("SidekickAI.exe"), |session| session.execute(Action::FlushConfig,
        Some(Configuration { features: request.features.clone(), options: request.options.clone() }), false, &|_| {}))
}

pub(crate) fn open(executable: &Path, argument: &str, progress: &dyn Fn(&str)) -> Option<Result<(), String>> {
    with_session(executable, |session| {
        if !matches!(argument, "--show-guide" | "--skip-guide") { return Err("程序启动参数无效。".into()); }
        progress("正在复用本次安装授权核对并打开程序…");
        session.execute(Action::OpenApplication, None, argument == "--show-guide", progress)
    })
}

struct Caller { handle: HANDLE, started: u64, session: u32, executable: PathBuf }
impl Drop for Caller { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.handle) }; } }
impl Caller {
    fn inspect(pid: u32) -> Result<Self, String> {
        let mut caller = Self { handle: unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }.map_err(|error| error.to_string())?, started: 0, session: 0, executable: PathBuf::new() };
        if !caller.alive()? { return Err("安装向导已经退出。".into()); }
        unsafe { ProcessIdToSessionId(pid, &mut caller.session) }.map_err(|error| error.to_string())?;
        let mut name = [0u16; 32768];
        let mut size = name.len() as u32;
        unsafe { QueryFullProcessImageNameW(caller.handle, PROCESS_NAME_WIN32, windows::core::PWSTR(name.as_mut_ptr()), &mut size) }.map_err(|error| error.to_string())?;
        caller.executable = PathBuf::from(String::from_utf16_lossy(&name[..size as usize]));
        let mut created = Default::default();
        let mut exited = Default::default();
        let mut kernel = Default::default();
        let mut user = Default::default();
        unsafe { GetProcessTimes(caller.handle, &mut created, &mut exited, &mut kernel, &mut user) }.map_err(|error| error.to_string())?;
        caller.started = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        // This live handle retains the original process identity even if its PID is reused.
        Ok(caller)
    }

    fn capture(envelope: &OperationRequest, request_path: &Path) -> Result<Self, String> {
        let root = request_path.parent().ok_or("安装授权目录无效。")?;
        let binding: Binding = read_private(&root.join("session-binding.json"))?;
        let caller = Self::inspect(envelope.controller_pid)?;
        let mut own_session = 0;
        unsafe { ProcessIdToSessionId(std::process::id(), &mut own_session) }.map_err(|error| error.to_string())?;
        if binding.protocol_version != OPERATION_PROTOCOL_VERSION || binding.operation_id != envelope.operation_id || binding.nonce != envelope.nonce
            || binding.pid != envelope.controller_pid || binding.started != caller.started || binding.session != caller.session || caller.session != own_session
            || !sidekickai_uninstall_core::path::paths_equal(&binding.executable, &caller.executable)
            || !sidekickai_uninstall_core::path::paths_equal(&caller.executable, &std::env::current_exe().map_err(|error| error.to_string())?) {
            return Err("安装向导进程、创建时间、会话或镜像不匹配。".into());
        }
        Ok(caller)
    }
    fn alive(&self) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(self.handle, 0) } { WAIT_OBJECT_0 => Ok(false), WAIT_TIMEOUT => Ok(true), _ => Err("无法确认安装向导的存活状态。".into()) }
    }
}

fn verify_command(command: &Command, envelope: &OperationRequest, sequence: u32) -> Result<(), String> {
    if command.protocol_version != OPERATION_PROTOCOL_VERSION || command.operation_id != envelope.operation_id || command.nonce != envelope.nonce || command.sequence != sequence {
        return Err("完成操作不属于本次安装授权，或请求顺序无效。".into());
    }
    match command.action {
        Action::FlushConfig if command.configuration.is_some() && !command.show_guide => Ok(()),
        Action::OpenApplication if command.configuration.is_none() => Ok(()),
        _ => Err("完成操作的内容与授权范围不匹配。".into()),
    }
}

fn is_released(root: &Path, envelope: &OperationRequest) -> Result<bool, String> {
    let path = root.join("release.json");
    if !path.is_file() { return Ok(false); }
    let release: Release = read_private(&path)?;
    if release.protocol_version != OPERATION_PROTOCOL_VERSION || release.operation_id != envelope.operation_id || release.nonce != envelope.nonce { return Err("授权会话释放请求不匹配。".into()); }
    Ok(true)
}

pub(super) struct Worker { caller: Caller, _root: PinnedDirectory }
impl Worker {
    pub(super) fn bind(envelope: &OperationRequest, request_path: &Path) -> Result<Self, String> {
        let root = PinnedDirectory::open(request_path.parent().ok_or("安装授权目录无效。")?)?;
        Ok(Self { caller: Caller::capture(envelope, request_path)?, _root: root })
    }
    pub(super) fn serve(&self, envelope: &OperationRequest, request_path: &Path) -> Result<(), String> {
    let root = request_path.parent().ok_or("安装授权目录无效。")?;
    let executable = Path::new(&envelope.request.install_dir).join("SidekickAI.exe");
    application_launch::validate_target(&executable)?;
    let (receipt, _) = sidekickai_uninstall_core::product::read_install_receipt(Path::new(&envelope.request.install_dir))?;
    write_private(&root.join("session-ready.json"), &Release { protocol_version: OPERATION_PROTOCOL_VERSION, operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone() })?;
    let started = Instant::now();
    let mut last_command = Instant::now();
    let mut sequence = 1;
    while self.caller.alive()? && started.elapsed() < SESSION_LIMIT && last_command.elapsed() < IDLE_LIMIT {
        if is_released(root, envelope)? { return Ok(()); }
        let directory = command_directory(request_path, sequence)?;
        let path = directory.join("request.json");
        if path.is_file() {
            let _command = PinnedDirectory::open(&directory)?;
            let outcome = (|| {
                let command: Command = read_private(&path)?;
                verify_command(&command, envelope, sequence)?;
                application_launch::validate_target(&executable)?;
                let (current, _) = sidekickai_uninstall_core::product::read_install_receipt(Path::new(&envelope.request.install_dir))?;
                if current.installation_id != receipt.installation_id { return Err("安装目标的身份已变化，授权会话不再适用。".into()); }
                let mut scoped = envelope.clone();
                scoped.operation_id = command_id(&envelope.operation_id, sequence);
                scoped.request.cleanup_paths.clear();
                scoped.request.cloud_assets.clear();
                scoped.request.delete_user_data = false;
                scoped.request.action = match command.action { Action::FlushConfig => super::ACTION_FLUSH_CONFIG, Action::OpenApplication => super::ACTION_OPEN_APPLICATION }.into();
                match command.action {
                    Action::FlushConfig => {
                        let configuration = command.configuration.ok_or("完成设置缺少内容。")?;
                        scoped.request.features = configuration.features;
                        scoped.request.options = configuration.options;
                        engine::flush_install_config(&scoped.request)
                    }
                    Action::OpenApplication => {
                        scoped.request.launch_after_install = true;
                        scoped.request.show_guide_after_install = command.show_guide;
                        application_user::launch_as_caller_guarded(&scoped, &path, &|| Ok(self.caller.alive()? && !is_released(root, envelope)?))
                    }
                }
            })();
            let mut scoped = envelope.clone();
            scoped.operation_id = command_id(&envelope.operation_id, sequence);
            if super::run::finish_operation(&path, &scoped, outcome) != 0 && !directory.join("result.json").is_file() { return Err("无法保存完成操作结果。".into()); }
            sequence = sequence.checked_add(1).ok_or("完成操作次数超出限制。")?;
            last_command = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;
