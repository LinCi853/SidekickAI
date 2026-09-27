// envelope —— 请求/结果线格式与身份校验
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sidekickai_uninstall_core::path::reject_reparse_points;

use crate::manifest::InstallRequest;

use super::directory::{
    current_user_sid, process_user_sid, validate_operation_directory_name, verify_private_directory,
};
use super::{OPERATION_PROTOCOL_VERSION, REQUEST_FILE, SHA256_HEX_LEN};

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    pub protocol_version: u32,
    pub operation_id: String,
    pub nonce: String,
    /// `install` / `repair` / `flush-config`; the child only accepts known values.
    pub action: String,
    /// The controller process that prepared this request. The child refuses a
    /// request whose controller is gone or belongs to another user.
    pub controller_pid: u32,
    /// User SID of the caller that launched the wizard. Alternate-admin UAC
    /// changes the SID and is refused before the engine runs.
    pub caller_user_sid: String,
    /// SHA-256 of the controller's own executable image. The child hashes
    /// itself and refuses a request that was not prepared by this exact image.
    pub source_sha256: String,
    pub request: InstallRequest,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationResult {
    pub protocol_version: u32,
    pub operation_id: String,
    pub nonce: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Load a request from a location validated structurally and by source
/// identity: named `request.json` directly inside a private operation
/// directory, non-reparse, parseable and self-consistent (protocol version and
/// directory-name binding).
pub(super) fn load_request(request_path: &Path) -> Result<OperationRequest, String> {
    // Read and parse first: the operation identity lives in the envelope, and a
    // location that fails validation afterwards still produces no result file.
    let raw = fs::read(request_path).map_err(|error| format!("读取安装请求失败：{error}"))?;
    let envelope: OperationRequest =
        serde_json::from_slice(&raw).map_err(|error| format!("解析安装请求失败：{error}"))?;
    if envelope.protocol_version != OPERATION_PROTOCOL_VERSION {
        return Err("安装请求协议版本不匹配。".into());
    }
    let directory = validate_request_location(request_path)?;
    validate_operation_directory_name(&directory, &envelope.operation_id, &envelope.nonce)?;
    Ok(envelope)
}

/// Bind a loaded request to the running image and to the caller identity.
pub(super) fn verify_request(envelope: &OperationRequest, worker_path: &Path) -> Result<(), String> {
    // The running image must be the one that prepared this request; a stale or
    // swapped copy cannot inherit the request's authority.
    let actual = sha256_file(worker_path)?;
    if envelope.source_sha256.len() != SHA256_HEX_LEN
        || !envelope.source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !actual.eq_ignore_ascii_case(&envelope.source_sha256)
    {
        return Err("运行中的安装程序与准备请求的镜像不一致。".into());
    }
    assert_trusted_caller(envelope)
}

/// Validate the request location structurally and by source identity.
///
/// The operation root is deliberately *not* re-derived from the child's own
/// `%TEMP%`: same-account UAC can hand the elevated child a different temp
/// environment and an alternate admin observes another profile entirely, so an
/// equality test against the worker temp root rejects a legitimate private
/// directory. Instead the request must be `request.json` directly inside a
/// directory this protocol created: owned by the current process user with a
/// protected DACL carrying exactly the three ACEs `harden_private_directory`
/// applies. A directory that merely shares a name cannot pass, so the child
/// never writes a result into an arbitrary location.
pub(super) fn validate_request_location(request_path: &Path) -> Result<PathBuf, String> {
    let name = request_path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case(REQUEST_FILE) {
        return Err("安装请求必须命名为 request.json。".into());
    }
    let directory = request_path
        .parent()
        .ok_or_else(|| "安装请求没有所在目录。".to_string())?;
    if !directory.is_dir() {
        return Err("安装请求不在目录中。".into());
    }
    if !request_path.is_file() {
        return Err("安装请求不是普通文件。".into());
    }
    reject_reparse_points(request_path).map_err(|error| format!("安装请求路径不可信：{}", error.message))?;
    reject_reparse_points(directory).map_err(|error| format!("安装请求目录不可信：{}", error.message))?;
    verify_private_directory(directory)?;
    Ok(directory.to_path_buf())
}

/// Refuse the run unless the child executes as the same user as the caller and
/// the recorded controller process is still a live process of that same user.
/// This fails closed on alternate-admin elevation instead of writing another
/// account's config or using another account's temp directory.
///
/// Honest limit: a matching user SID on some live PID is a coarse binding, not
/// proof of controller authenticity. The private directory ACL narrows the
/// window; no elevated install authority is granted on the SID match alone.
pub(super) fn assert_trusted_caller(envelope: &OperationRequest) -> Result<(), String> {
    let child_sid = current_user_sid()?;
    if envelope.caller_user_sid != child_sid {
        return Err(
            "安装进程以不同用户账户运行；已拒绝，未写入任何内容。".into(),
        );
    }
    if envelope.controller_pid == 0 {
        return Err("安装请求没有记录发起进程。".into());
    }
    let controller_sid = process_user_sid(envelope.controller_pid)
        .map_err(|error| format!("无法确认安装发起进程：{error}"))?;
    if controller_sid != child_sid {
        return Err("安装发起进程不属于当前用户账户；已拒绝。".into());
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取文件失败：{error}"))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

pub(super) fn random_hex() -> Result<String, String> {
    let id = sidekickai_uninstall_core::random_id("nonce").map_err(|error| error.message)?;
    Ok(id.trim_start_matches("nonce-").to_string())
}
