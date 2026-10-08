//! Worker-side request validation and protected-scope rules.

use super::deletion::ResolvedTarget;
use super::prepare::operation_root;
use super::types::{WorkerDataRoot, WorkerRequest};
use super::verified_source_entry_is_safe;
use super::super::{internal, invalid_request, REQUEST_NONCE_LEN, SHA256_HEX_LEN};
use sidekickai_uninstall_core::path::{
    path_is_same_or_descendant, paths_equal, reject_reparse_points, NormalizedAbsolutePath,
};
use sidekickai_uninstall_core::protocol::*;
use std::path::{Path, PathBuf};

/// Validate the request location itself. The request must be the `request.json`
/// of a per-operation directory, next to the relocated `worker.exe`, and neither
/// the request file nor any component of its path (nor the worker image) may be a
/// reparse point. The operation root is intentionally *not* re-derived from the
/// worker's own `%TEMP%`, because an elevated worker may legitimately observe a
/// different environment while the caller's private directory stays the same;
/// this is also what keeps a test-provided operation root usable by the native
/// worker without a production override.
pub(super) fn validate_request_location_for(request_path: &Path, worker_path: &Path) -> Result<(), UninstallError> {
    let directory = request_path.parent().ok_or_else(|| internal("工作请求缺少目录。"))?;
    let request_name = request_path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !request_name.eq_ignore_ascii_case("request.json") {
        return Err(internal("工作请求必须命名为 request.json。"));
    }
    let worker_name = worker_path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !worker_name.eq_ignore_ascii_case("worker.exe") {
        return Err(internal("工作进程不是本操作的重定位可执行文件。"));
    }
    let worker_directory = worker_path.parent().ok_or_else(|| internal("工作进程没有目录。"))?;
    if !paths_equal(worker_directory, directory) {
        return Err(internal("工作进程不是本操作的重定位可执行文件。"));
    }
    if !directory.is_dir() {
        return Err(internal("工作请求不在目录中。"));
    }
    if !request_path.is_file() {
        return Err(internal("工作请求不是普通文件。"));
    }
    if !worker_path.is_file() {
        return Err(internal("重定位的工作进程不是普通文件。"));
    }
    // Reject a request (or worker) that is itself a link, as well as a link
    // anywhere in the ancestor chain.
    reject_reparse_points(request_path)?;
    reject_reparse_points(worker_path)?;
    reject_reparse_points(directory)?;
    Ok(())
}

/// The directory name is `{operationId}-{nonce}`; binding the request to it
/// keeps a stray request from being treated as this operation's work.
pub(super) fn validate_operation_directory_name(directory: &Path, operation_id: &str) -> Result<(), UninstallError> {
    let name = directory.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let prefix = format!("{operation_id}-");
    let Some(suffix) = name.strip_prefix(&prefix) else {
        return Err(invalid_request(operation_id, "工作请求不在本操作的私有目录中。"));
    };
    if suffix.len() != REQUEST_NONCE_LEN || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid_request(operation_id, "工作请求不在本操作的私有目录中。"));
    }
    Ok(())
}

pub(super) fn validate_worker_identifier(value: &str, field: &str, operation_id: &str) -> Result<(), UninstallError> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':' | '\0'))
    {
        return Err(invalid_request(operation_id, format!("工作请求字段 {field} 无效。")));
    }
    Ok(())
}

/// Roots that may never be an uninstall target, regardless of what a request
/// claims. A `FileFingerprint` (and even a source hash) proves nothing about
/// *which* directory is being deleted, so the worker refuses the OS directory,
/// the user profile roots, the temp roots and its own private operation area
/// before it walks or deletes anything.
pub(super) fn protected_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for name in [
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
        "PUBLIC", "SystemRoot", "windir", "TEMP", "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            roots.push(PathBuf::from(value));
        }
    }
    roots.push(operation_root());
    roots
}

/// The platform-independent rule, split out so it can be exercised without the
/// real machine's environment.
pub(super) fn protected_scope_reason_for(path: &Path, roots: &[PathBuf], system_root: Option<&Path>, operation: &Path) -> Option<&'static str> {
    if roots.iter().any(|root| paths_equal(path, root)) {
        return Some("受保护的系统或用户根目录不能作为卸载目标。");
    }
    if roots.iter().any(|root| path_is_same_or_descendant(root, path)) {
        return Some("卸载目标不能包含受保护的系统或用户根目录。");
    }
    if system_root.is_some_and(|root| path_is_same_or_descendant(path, root)) {
        return Some("不接受位于操作系统目录内的目标。");
    }
    if path_is_same_or_descendant(path, operation) {
        return Some("不接受位于卸载器私有操作区内的目标。");
    }
    None
}

pub(super) fn protected_scope_reason(path: &Path) -> Option<&'static str> {
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from);
    protected_scope_reason_for(path, &protected_roots(), system_root.as_deref(), &operation_root())
}

/// The scan accepts an installation only when `resources\app.asar` and
/// `uninstall.exe` are present; `SidekickAI.exe` may be absent for a
/// registry-corroborated degraded identity. The worker re-checks the same two
/// markers, so a fingerprint synthesized for an arbitrary folder (empty,
/// system or otherwise) is not enough to authorize a deletion.

pub(super) fn validate_worker_request(request: &WorkerRequest) -> Result<(), UninstallError> {
    let operation_id = request.operation_id.as_str();
    if request.protocol_version != UNINSTALL_PROTOCOL_VERSION {
        return Err(invalid_request(operation_id, "不支持的工作进程协议版本。"));
    }
    validate_worker_identifier(&request.operation_id, "operationId", operation_id)?;
    validate_worker_identifier(&request.request_id, "requestId", operation_id)?;
    if request.nonce.len() != REQUEST_NONCE_LEN || !request.nonce.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid_request(operation_id, "工作请求随机数格式错误。"));
    }
    if request.worker_sha256.len() != SHA256_HEX_LEN
        || !request.worker_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid_request(operation_id, "工作请求未绑定工作进程镜像哈希。"));
    }
    if let Some(task_id) = &request.resume_task_id {
        validate_worker_identifier(task_id, "resumeTaskId", operation_id)?;
        if task_id != &request.request_id || !request.targets.is_empty() || !request.data_roots.is_empty()
            || request.preparation.is_some() || request.strategy != DataStrategy::Keep
            || request.backup_path.is_some() || !request.backup_proofs.is_empty() {
            return Err(invalid_request(operation_id, "恢复请求不能携带新的删除范围。"));
        }
        return Ok(());
    }
    for root in &request.data_roots {
        if root.identity.tree_sha256.len() != SHA256_HEX_LEN
            || !root.identity.tree_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid_request(operation_id, "数据根未携带有效的树标识。"));
        }
        if let Some(tree) = &root.verified_tree_sha256 {
            if tree.len() != SHA256_HEX_LEN || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid_request(operation_id, "已校验的数据根未携带有效的导出树标识。"));
            }
        }
        for (entry, hash) in &root.verified_source_hashes {
            if !verified_source_entry_is_safe(entry, hash) {
                return Err(invalid_request(operation_id, "已校验的数据根包含不安全的源条目。"));
            }
        }
    }
    if request.targets.is_empty() {
        return Err(invalid_request(operation_id, "工作请求没有已确认目标。"));
    }
    if request.target_identities.len() != request.targets.len() {
        return Err(invalid_request(
            operation_id,
            "工作请求未为每个目标绑定目录标识。",
        ));
    }
    for target in &request.targets {
        if target.path.trim().is_empty() {
            return Err(invalid_request(operation_id, "工作请求包含空目标路径。"));
        }
        let bound = request
            .target_identities
            .iter()
            .filter(|proof| paths_equal(Path::new(&proof.path), Path::new(&target.path)))
            .count();
        if bound != 1 {
            return Err(invalid_request(
                operation_id,
                "工作请求未为每个目标绑定唯一目录标识。",
            ));
        }
        for root in &target.registered_roots {
            if root != "HKCU" && root != "HKLM" {
                return Err(invalid_request(
                    operation_id,
                    format!("工作请求指定了未知注册表根：{root}"),
                ));
            }
        }
    }
    if let Some(hash) = &request.backup_sha256 {
        if hash.len() != SHA256_HEX_LEN || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid_request(operation_id, "工作请求归档哈希格式错误。"));
        }
    }
    if !request.backup_proofs.is_empty() {
        if request.strategy != DataStrategy::Export || request.backup_proofs.len() != request.data_roots.len() {
            return Err(invalid_request(operation_id, "备份证明数量与数据范围不一致。"));
        }
        for proof in &request.backup_proofs {
            let matching = request.data_roots.iter().filter(|root| paths_equal(Path::new(&root.path), Path::new(&proof.root))).collect::<Vec<_>>();
            if matching.len() != 1 || matching[0].verified_source_hashes != proof.entry_hashes
                || matching[0].verified_tree_sha256.as_deref() != Some(proof.tree_sha256.as_str())
                || proof.archive_sha256.len() != SHA256_HEX_LEN || !proof.archive_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                || request.backup_proofs.iter().filter(|item| paths_equal(Path::new(&item.path), Path::new(&proof.path))).count() != 1 {
                return Err(invalid_request(operation_id, "备份证明未准确绑定独立数据根。"));
            }
        }
        let first = &request.backup_proofs[0];
        if request.backup_path.as_deref() != Some(first.path.as_str()) || request.backup_sha256.as_deref() != Some(first.archive_sha256.as_str()) {
            return Err(invalid_request(operation_id, "备份首项与兼容字段不一致。"));
        }
    }
    match request.strategy {
        DataStrategy::Keep => {
            if !request.data_roots.is_empty() {
                return Err(invalid_request(operation_id, "保留用户数据请求不得携带数据根。"));
            }
            if request.backup_path.is_some() || request.backup_sha256.is_some() {
                return Err(invalid_request(operation_id, "保留用户数据请求不得携带备份。"));
            }
        }
        DataStrategy::Export => {
            if request.backup_path.is_none() {
                return Err(invalid_request(operation_id, "导出请求需要已校验的备份路径。"));
            }
            if request.backup_sha256.is_none() {
                return Err(invalid_request(operation_id, "导出请求必须绑定原始归档哈希。"));
            }
            if request.data_roots.iter().any(|root| root.verified_tree_sha256.is_none()) {
                return Err(invalid_request(operation_id, "导出请求必须绑定导出端完整数据树摘要。"));
            }
        }
        DataStrategy::Delete => {
            if request.backup_path.is_some() || request.backup_sha256.is_some() {
                return Err(invalid_request(operation_id, "删除请求不得携带备份。"));
            }
        }
    }
    Ok(())
}

/// Resolve every proposed scope and refuse dangerous overlaps before anything is
/// touched. A data root that contains a selected installation is refused, since
/// deleting it first would silently remove the installation as a side effect.
/// A validated installation scope with its handle-derived directory identity, so

pub(super) fn reject_dangerous_overlaps(
    targets: &[ResolvedTarget],
    data: &[(&WorkerDataRoot, NormalizedAbsolutePath)],
    operation_id: &str,
) -> Result<(), UninstallError> {
    let overlap = || {
        UninstallError::new(
            UninstallErrorCode::TargetIsParent,
            "工作请求包含重叠或嵌套的移除范围。",
            UninstallPhase::Validating,
            false,
            operation_id,
        )
    };
    for (index, left) in targets.iter().enumerate() {
        for right in targets.iter().skip(index + 1) {
            if left.path.is_same_or_descendant_of(&right.path) || right.path.is_same_or_descendant_of(&left.path) {
                return Err(overlap());
            }
        }
    }
    for (index, (_, left)) in data.iter().enumerate() {
        for (_, right) in data.iter().skip(index + 1) {
            if left.is_same_or_descendant_of(right) || right.is_same_or_descendant_of(left) {
                return Err(overlap());
            }
        }
    }
    for (_, data_path) in data {
        for target in targets {
            if target.path.is_same_or_descendant_of(data_path) {
                return Err(overlap());
            }
        }
    }
    Ok(())
}
