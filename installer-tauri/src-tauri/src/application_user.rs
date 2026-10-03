//! The ordinary wizard starts the application after privileged owner shutdown.

use crate::{application_launch, controller, elevate, manifest::InstallRequest};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

const READY: &str = "launch-ready.json";
const STARTED: &str = "launch-started.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchStage { protocol_version: u32, operation_id: String, nonce: String, #[serde(default)] launch_request_id: Option<String>, started: bool, error: Option<String> }

struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; } }

fn read_stage(path: &Path, operation_id: &str, nonce: &str) -> Result<LaunchStage, String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|error| error.to_string())?.take(4097).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > 4096 { return Err("程序启动交接信息过大。".into()); }
    let stage: LaunchStage = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if stage.protocol_version != controller::OPERATION_PROTOCOL_VERSION || stage.operation_id != operation_id || stage.nonce != nonce {
        return Err("程序启动交接不属于本次完成操作。".into());
    }
    Ok(stage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_ready_records_are_bound_to_one_operation_and_cannot_be_replayed() {
        let operation = controller::OperationDirectory::create("open-op").unwrap();
        let ready = operation.request_path().with_file_name(READY);
        write_stage(&ready, operation.operation_id(), "unrelated", false, None).unwrap();
        let mut responded = false;
        let error = respond_to_launch(&operation, Path::new("E:/unrelated/SidekickAI.exe"), "--skip-guide", &mut responded).unwrap_err();
        assert!(error.contains("不属于本次"));
        let answer = read_stage(&ready.with_file_name(STARTED), operation.operation_id(), operation.nonce()).unwrap();
        assert!(!answer.started);
        assert!(answer.error.unwrap().contains("不属于本次"));
        assert!(respond_to_launch(&operation, Path::new("E:/unrelated/SidekickAI.exe"), "--skip-guide", &mut responded).is_ok());
    }

    #[test]
    fn oversized_or_unknown_launch_ready_records_are_refused() {
        for bytes in [vec![b'x'; 4097], br#"{"protocolVersion":1,"operationId":"id","nonce":"nonce","started":false,"error":null,"extra":true}"#.to_vec()] {
            let operation = controller::OperationDirectory::create("open-op").unwrap();
            let ready = operation.request_path().with_file_name(READY);
            sidekickai_uninstall_core::write_private_file(&ready, &bytes).unwrap();
            assert!(read_stage(&ready, "id", "nonce").is_err());
        }
    }

    #[test]
    fn a_prior_completion_ready_record_cannot_start_a_retry() {
        let operation = controller::OperationDirectory::create("open-op").unwrap();
        let ready = operation.request_path().with_file_name(READY);
        let first = format!("{}-completion-1", operation.operation_id());
        let retry = format!("{}-completion-2", operation.operation_id());
        write_stage(&ready, &first, operation.nonce(), false, None).unwrap();
        let mut responded = false;
        let error = respond_to_launch_at(&operation.request_path(), &retry, operation.nonce(), Path::new("E:/unrelated/SidekickAI.exe"), "--skip-guide", &mut responded).unwrap_err();
        assert!(error.contains("不属于本次"));
        let rejected = read_stage(&ready.with_file_name(STARTED), &retry, operation.nonce()).unwrap();
        assert!(!rejected.started);
        assert!(rejected.error.unwrap().contains("不属于本次"));
    }
}

fn write_stage(path: &Path, operation_id: &str, nonce: &str, started: bool, error: Option<String>) -> Result<(), String> {
    write_stage_with_request(path, operation_id, nonce, None, started, error)
}

fn write_stage_with_request(path: &Path, operation_id: &str, nonce: &str, launch_request_id: Option<&str>, started: bool, error: Option<String>) -> Result<(), String> {
    let stage = LaunchStage { protocol_version: controller::OPERATION_PROTOCOL_VERSION, operation_id: operation_id.into(), nonce: nonce.into(), launch_request_id: launch_request_id.map(String::from), started, error };
    let bytes = serde_json::to_vec(&stage).map_err(|error| error.to_string())?;
    sidekickai_uninstall_core::write_private_file(path, &bytes).map_err(|error| error.message)
}

pub fn respond_to_launch(operation: &controller::OperationDirectory, executable: &Path, argument: &str, responded: &mut bool) -> Result<(), String> {
    respond_to_launch_at(&operation.request_path(), operation.operation_id(), operation.nonce(), executable, argument, responded)
}

pub(crate) fn respond_to_launch_at(request_path: &Path, operation_id: &str, nonce: &str, executable: &Path, argument: &str, responded: &mut bool) -> Result<(), String> {
    let ready = request_path.parent().ok_or("程序启动交接目录无效。")?.join(READY);
    if *responded || !ready.is_file() { return Ok(()); }
    *responded = true;
    let result = (|| {
        let stage = read_stage(&ready, operation_id, nonce)?;
        if stage.started || stage.error.is_some() { return Err("程序启动交接状态无效。".into()); }
        application_launch::validate_target(executable)?;
        if !matches!(argument, "--show-guide" | "--skip-guide") { return Err("程序启动参数无效。".into()); }
        application_launch::spawn_target(executable, argument, stage.launch_request_id.as_deref().ok_or("程序启动交接缺少本次请求标识。")?)
    })();
    write_stage(&ready.with_file_name(STARTED), operation_id, nonce, result.is_ok(), result.as_ref().err().cloned())?;
    result
}

pub fn launch_from_wizard_reporting(executable: &Path, argument: &str, progress: &dyn Fn(&str)) -> Result<(), String> {
    application_launch::validate_target(executable)?;
    if let Some(result) = controller::completion::open(executable, argument, progress) { return result; }
    if !application_launch::needs_elevated_inspection(executable)? {
        return application_launch::launch_reporting(executable, argument, progress);
    }
    progress("已有程序需要管理员权限才能核对和关闭，正在等待系统授权…");
    let request: InstallRequest = serde_json::from_value(json!({
        "action": controller::ACTION_OPEN_APPLICATION,
        "installDir": executable.parent().ok_or("安装目录无效。")?,
        "forAllUsers": false, "createDesktopShortcut": false, "launchAfterInstall": true,
        "showGuideAfterInstall": argument == "--show-guide", "features": {}, "options": {}, "mode": "repair"
    })).map_err(|error| error.to_string())?;
    let operation = controller::OperationDirectory::create("open-op")?;
    operation.write_envelope(controller::ACTION_OPEN_APPLICATION, &request)?;
    let mut responded = false;
    let mut offset = 0;
    let result = elevate::run_elevated_with_callback(&operation.request_path(), &operation.result_path(), operation.operation_id(), operation.nonce(),
        || {
            if let Ok(text) = std::fs::read_to_string(operation.log_path()) {
                if let Some(end) = text.rfind('\n').map(|index| index + 1) {
                    if end >= offset { for line in text[offset..end].lines() { if let Some(message) = line.strip_prefix("S|") { progress(message); } } }
                    offset = end;
                }
            }
            respond_to_launch(&operation, executable, argument, &mut responded)
        });
    if result.is_ok() { progress("本次安装的程序已打开，正在关闭向导…"); }
    result
}

pub fn launch_as_caller(envelope: &controller::OperationRequest, request_path: &Path) -> Result<(), String> {
    launch_as_caller_guarded(envelope, request_path, &|| Ok(true))
}

pub(crate) fn launch_as_caller_guarded(envelope: &controller::OperationRequest, request_path: &Path, alive: &dyn Fn() -> Result<bool, String>) -> Result<(), String> {
    let request = &envelope.request;
    if request.action != controller::ACTION_OPEN_APPLICATION || !request.launch_after_install
        || !request.cleanup_paths.is_empty() || request.delete_user_data || !request.cloud_assets.is_empty() {
        return Err("程序启动请求的范围不匹配。".into());
    }
    let caller = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, envelope.controller_pid) }
        .map_err(|error| error.to_string())?);
    let executable = sidekickai_uninstall_core::product::application_executable(Path::new(&request.install_dir));
    let argument = if request.show_guide_after_install { "--show-guide" } else { "--skip-guide" };
    application_launch::launch_with_owner_reporting_guarded(&executable, argument, envelope.controller_pid, |_, _, request_id| {
        let ready = request_path.parent().ok_or("程序启动交接目录无效。")?.join(READY);
        write_stage_with_request(&ready, &envelope.operation_id, &envelope.nonce, Some(request_id), false, None)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if !alive()? || unsafe { WaitForSingleObject(caller.0, 0) == WAIT_OBJECT_0 } { return Err("安装向导已经退出或交接已取消，程序启动已停止。".into()); }
            let started = ready.with_file_name(STARTED);
            if started.is_file() {
                let stage = read_stage(&started, &envelope.operation_id, &envelope.nonce)?;
                return if stage.started && stage.error.is_none() { Ok(()) } else { Err(stage.error.unwrap_or("本次安装的程序未能启动。".into())) };
            }
            if Instant::now() >= deadline { return Err("等待安装向导启动本次程序超时，请重试或关闭向导。".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
    }, &crate::engine::status, &|| {
        if !alive()? { return Ok(false); }
        match unsafe { WaitForSingleObject(caller.0, 0) } {
            WAIT_OBJECT_0 => Ok(false),
            windows::Win32::Foundation::WAIT_TIMEOUT => Ok(true),
            _ => Err("无法确认安装向导的存活状态。".into()),
        }
    })
}
