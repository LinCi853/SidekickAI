//! Private operation directories, controller preparation and handoff.

use super::super::hashing::{sha256_file, write_atomic};
use super::super::identity::{current_user_sid, process_user_sid, DataRootIdentity, DirectoryIdentity};
use super::super::tree::export_tree_digest;
#[cfg(test)]
use super::process::{spawn_worker, wait_for_outcome};
use super::types::{
    BackupProof, TargetDirectoryProof, WorkerDataRoot, WorkerOutcome, WorkerPreparation, WorkerRequest, WorkerTarget,
};
use super::{
    installation_markers_present, verify_verified_source_hashes, verified_source_entry_is_safe,
};
use super::super::{
    harden_operation_directory, internal, invalid_request, SHA256_HEX_LEN, WORKER_ROOT,
};
use sidekickai_uninstall_core::path::{normalize_target_path, paths_equal, validate_tree};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::scan::FileFingerprint;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
thread_local! {
    // Tests never enumerate or sweep the real global relocation directory. Each
    // test thread gets one unpredictable operation root; production code always
    // uses `%TEMP%\SidekickAI-Uninstall`.
    static TEST_OPERATION_ROOT: PathBuf = std::env::temp_dir()
        .join(format!("{WORKER_ROOT}-test-{}", random_nonce().unwrap()));
}

pub fn operation_root() -> PathBuf {
    #[cfg(test)]
    { return TEST_OPERATION_ROOT.with(Clone::clone); }
    #[cfg(not(test))]
    { std::env::temp_dir().join(WORKER_ROOT) }
}

/// A private, unpredictable directory for exactly one operation. The directory
/// carries a restrictive DACL (current user, SYSTEM and Administrators only)
/// applied through its inheritable ACEs, so a request or result inside it cannot
/// be read or replaced by another interactive user.
pub fn create_operation_dir(operation_id: &str) -> Result<PathBuf, UninstallError> {
    let root = operation_root();
    fs::create_dir_all(&root).map_err(|e| internal(format!("无法创建操作根目录：{e}")))?;
    for _ in 0..16 {
        let nonce = random_nonce()?;
        let directory = root.join(format!("{operation_id}-{nonce}"));
        match fs::create_dir(&directory) {
            Ok(()) => {
                if let Err(error) = harden_operation_directory(&directory) {
                    let _ = fs::remove_dir(&directory);
                    return Err(error);
                }
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(internal(format!("无法创建操作目录：{error}"))),
        }
    }
    Err(internal("无法分配私有操作目录。"))
}
pub(super) fn random_nonce() -> Result<String, UninstallError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| internal(format!("无法创建随机数：{e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Refuse the irreversible step unless the worker runs as the same user as the
/// caller and the recorded controller process is still a live process of that
/// same user. This fails closed on alternate-admin elevation instead of using
/// another account's temp directory, HKCU or APPDATA.
///
/// Honest limit: a matching user SID on some live PID is a coarse binding, not
/// proof of controller authenticity. Any process that already runs as the same
/// user can present that SID, so this check raises the cost of an alternate
/// account or a stale/elevated PID but does not defend against a malicious
/// same-user process. The private operation-directory ACL narrows the window; it
/// does not authenticate the caller, and no elevated deletion authority is
/// granted on the strength of the SID match alone.
pub(super) fn assert_trusted_caller(request: &WorkerRequest) -> Result<(), UninstallError> {
    let worker_sid = current_user_sid()?;
    if request.caller_user_sid != worker_sid {
        return Err(UninstallError::new(
            UninstallErrorCode::ElevationFailed,
            "删除工作进程与卸载器的用户账户不一致；未删除任何内容。",
            UninstallPhase::Validating,
            false,
            &request.operation_id,
        ));
    }
    if request.controller_pid == 0 {
        return Err(invalid_request(&request.operation_id, "工作进程请求缺少控制器进程标识。"));
    }
    let controller_sid = process_user_sid(request.controller_pid)?;
    if controller_sid != worker_sid {
        return Err(UninstallError::new(
            UninstallErrorCode::ElevationFailed,
            "控制器进程不属于工作进程的用户账户；未删除任何内容。",
            UninstallPhase::Validating,
            false,
            &request.operation_id,
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Controller-side preparation
// ---------------------------------------------------------------------------

/// Controller-side preparation: relocate the running executable into a private
/// operation directory and hand the worker a self-describing request.
///
/// `source_exe` is explicit so the controller/worker handoff can be exercised
/// against the built standalone binary as well as the running process.
///
/// This wrapper carries no verified-backup proof, so it is limited to the
/// `Keep` and `Delete` strategies (tests and non-export runs). An `Export`
/// deletion must go through [`prepare_worker_from_verified`], which binds the
/// deletion to the strict export the controller already verified.
#[cfg(test)]
pub fn prepare_worker_from(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
) -> Result<(PathBuf, PathBuf, String), UninstallError> {
    prepare_worker_with_proof(source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path, None)
}

/// Controller-side preparation for an `Export` deletion.
///
/// The deletion is authorized by the [`BackupProof`] the host produced when it
/// verified the strict export receipt, never by a data-root snapshot captured
/// afterwards. Before any snapshot is captured this function re-hashes the raw
/// archive, every selected source file the backup contains **and** the exact
/// exporter-time complete-tree digest, so a tree that gained, lost or changed
/// bytes after the backup cannot be captured as "post-backup verified".
#[cfg(test)]
pub fn prepare_worker_from_verified(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
    proof: &BackupProof,
) -> Result<(PathBuf, PathBuf, String), UninstallError> {
    prepare_worker_with_proof(source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path, Some(proof))
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(super) fn prepare_worker_with_proof(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
    proof: Option<&BackupProof>,
) -> Result<(PathBuf, PathBuf, String), UninstallError> {
    prepare_worker_request(source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path, proof, None)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_worker_request(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
    proof: Option<&BackupProof>,
    preparation: Option<WorkerPreparation>,
) -> Result<(PathBuf, PathBuf, String), UninstallError> {
    let (verified_data_roots, target_identities) = capture_worker_scopes(
        operation_id, strategy, targets, data_roots, backup_path, proof, preparation.is_some(),
    )?;
    let caller_user_sid = current_user_sid()?;
    let directory = create_operation_dir(operation_id)?;
    let cleanup_on_error = |error: UninstallError| -> UninstallError {
        cleanup_directory(&directory);
        error
    };
    let worker = directory.join("worker.exe");
    fs::copy(source_exe, &worker)
        .map_err(|e| internal(format!("无法重定位卸载器：{e}")))
        .map_err(cleanup_on_error)?;
    let source_hash = sha256_file(source_exe).map_err(internal).map_err(cleanup_on_error)?;
    let worker_hash = sha256_file(&worker).map_err(internal).map_err(cleanup_on_error)?;
    if source_hash != worker_hash {
        return Err(cleanup_on_error(internal("已重定位的卸载器与正在运行的可执行文件不匹配。")));
    }
    let nonce = random_nonce()?;
    let request = WorkerRequest {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        operation_id: operation_id.to_string(),
        request_id: request_id.to_string(),
        nonce: nonce.clone(),
        controller_pid: std::process::id(),
        caller_user_sid,
        worker_sha256: worker_hash,
        strategy: strategy.clone(),
        targets: targets.to_vec(),
        target_identities,
        data_roots: verified_data_roots,
        backup_path: backup_path.map(str::to_string),
        backup_sha256: proof.map(|proof| proof.archive_sha256.clone()),
        preparation,
    };
    let request_path = directory.join("request.json");
    let bytes = serde_json::to_vec(&request).map_err(|e| internal(e.to_string())).map_err(cleanup_on_error)?;
    write_atomic(&request_path, &bytes).map_err(internal).map_err(cleanup_on_error)?;
    Ok((directory, request_path, nonce))
}

pub fn read_outcome(directory: &Path, nonce: &str, operation_id: &str) -> Result<WorkerOutcome, UninstallError> {
    let raw = fs::read(directory.join("result.json"))
        .map_err(|e| internal(format!("卸载工作进程未返回结果：{e}")))?;
    let outcome: WorkerOutcome = serde_json::from_slice(&raw).map_err(|e| internal(format!("工作进程结果无效：{e}")))?;
    if outcome.protocol_version != UNINSTALL_PROTOCOL_VERSION || outcome.nonce != nonce || outcome.operation_id != operation_id {
        return Err(internal("工作进程结果与当前操作不匹配。"));
    }
    Ok(outcome)
}

pub fn cleanup_directory(directory: &Path) {
    let _ = fs::remove_dir_all(directory);
}

/// Full controller handoff: relocate the worker, start it, wait for its verified
/// result, then release the private operation directory. On a wait failure the
/// directory is intentionally kept for diagnosis and its path is reported.
///
/// This wrapper carries no verified-backup proof and is therefore limited to
/// `Keep` and `Delete`. Export fixtures use a verified backup proof.
#[cfg(test)]
pub fn run_worker_operation_with(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
    elevate: bool,
    cancel: Arc<AtomicBool>,
) -> Result<WorkerOutcome, UninstallError> {
    run_worker_operation_inner(
        source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path, None, elevate, cancel,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(super) fn run_worker_operation_inner(
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    targets: &[WorkerTarget],
    data_roots: &[String],
    backup_path: Option<&str>,
    proof: Option<&BackupProof>,
    elevate: bool,
    cancel: Arc<AtomicBool>,
) -> Result<WorkerOutcome, UninstallError> {
    let (directory, request_path, nonce) = match proof {
        Some(proof) => prepare_worker_from_verified(
            source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path, proof,
        )?,
        None => prepare_worker_from(
            source_exe, operation_id, request_id, strategy, targets, data_roots, backup_path,
        )?,
    };
    let process = match spawn_worker(&directory.join("worker.exe"), &request_path, elevate) {
        Ok(process) => process,
        Err(error) => {
            cleanup_directory(&directory);
            return Err(error);
        }
    };
    match wait_for_outcome(&directory, &nonce, operation_id, cancel, &process) {
        Ok(mut outcome) => {
            // A worker-reported failure still names the exact worker PID, so the
            // partial deletion can be audited even after the process is gone.
            if let Some(error) = outcome.error.take() {
                outcome.error = Some(error.with_detail("workerPid", DetailValue::Number(process.pid() as i64)));
            }
            cleanup_directory(&directory);
            Ok(outcome)
        }
        Err(error) => Err(error
            .with_detail("workerPid", DetailValue::Number(process.pid() as i64))
            .with_detail(
                "operationDirectory",
                DetailValue::String(directory.to_string_lossy().into_owned()),
            )),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn capture_worker_scopes(
    operation_id: &str, strategy: &DataStrategy, targets: &[WorkerTarget],
    data_roots: &[String], backup_path: Option<&str>, proof: Option<&BackupProof>,
    stopping_only: bool,
) -> Result<(Vec<WorkerDataRoot>, Vec<TargetDirectoryProof>), UninstallError> {
    // Only an export may carry a proof, and an export must carry one.
    let (verified_source_hashes, verified_tree_sha256) = match (strategy, proof) {
        (DataStrategy::Export, Some(proof)) => {
            let path = backup_path.ok_or_else(|| {
                invalid_request(operation_id, "导出删除需要已确认的备份路径。")
            })?;
            if !paths_equal(Path::new(path), Path::new(&proof.path)) {
                return Err(invalid_request(operation_id, "已确认备份证明指向了不同的归档文件。"));
            }
            if data_roots.len() != 1 || !paths_equal(Path::new(&data_roots[0]), Path::new(&proof.root)) {
                return Err(invalid_request(operation_id, "已确认备份证明指向了不同的数据根。"));
            }
            if proof.archive_sha256.len() != SHA256_HEX_LEN
                || !proof.archive_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(invalid_request(operation_id, "已确认备份证明缺少有效的归档哈希。"));
            }
            if proof.tree_sha256.len() != SHA256_HEX_LEN
                || !proof.tree_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(invalid_request(operation_id, "已确认备份证明缺少有效的完整数据树摘要。"));
            }
            if proof.entry_hashes.is_empty() {
                return Err(invalid_request(operation_id, "已确认备份证明没有所选源清单。"));
            }
            for (entry, hash) in &proof.entry_hashes {
                if !verified_source_entry_is_safe(entry, hash) {
                    return Err(invalid_request(operation_id, "已确认备份证明包含不安全的源条目。"));
                }
            }
            let actual = sha256_file(Path::new(&proof.path)).map_err(|error| {
                UninstallError::new(
                    UninstallErrorCode::BackupIncomplete,
                    format!("已确认备份归档无法读取：{error}"),
                    UninstallPhase::BackingUp,
                    false,
                    operation_id,
                )
            })?;
            if !actual.eq_ignore_ascii_case(&proof.archive_sha256) {
                return Err(UninstallError::new(
                    UninstallErrorCode::BackupIncomplete,
                    "备份归档在确认后发生变更；未准备删除任何内容。",
                    UninstallPhase::BackingUp,
                    false,
                    operation_id,
                ));
            }
            (proof.entry_hashes.clone(), Some(proof.tree_sha256.clone()))
        }
        (DataStrategy::Export, None) => {
            return Err(invalid_request(
                operation_id,
                "导出删除需要控制器已确认的备份证明。",
            ));
        }
        (_, Some(_)) => {
            return Err(invalid_request(
                operation_id,
                "只有导出删除才能携带已确认备份证明。",
            ));
        }
        (_, None) => (BTreeMap::new(), None),
    };

    // Capture strong data-root identity up front so the worker can detect a
    // replacement or a content change that happens before the irreversible step.
    // For an export run the selected source hashes and the exact exporter-time
    // complete-tree digest are revalidated first, so the captured directory
    // snapshot is never the authority for which files the export covered.
    let mut verified_data_roots = Vec::with_capacity(data_roots.len());
    for root in data_roots {
        let path = normalize_target_path(root)?;
        validate_tree(path.as_path())?;
        if !verified_source_hashes.is_empty() {
            verify_verified_source_hashes(&path, &verified_source_hashes, operation_id)?;
        }
        // The export binding is the digest the exporter recorded, never a digest
        // recaptured here: a file added after the export (even one the selected
        // categories would have archived) would otherwise be captured as
        // "post-backup verified". Refuse before any request exists.
        if let Some(expected) = &verified_tree_sha256 {
            let actual = export_tree_digest(path.as_path()).map_err(|error| {
                UninstallError::new(
                    UninstallErrorCode::BackupIncomplete,
                    format!("完整数据树无法重新检查：{}", error.message),
                    UninstallPhase::BackingUp,
                    false,
                    operation_id,
                )
            })?;
            if &actual != expected {
                return Err(UninstallError::new(
                    UninstallErrorCode::TargetChanged,
                    "导出快照后完整数据树已变更；未准备删除任何内容。",
                    UninstallPhase::Validating,
                    false,
                    operation_id,
                ));
            }
        }
        verified_data_roots.push(WorkerDataRoot {
            path: path.as_string(),
            fingerprint: FileFingerprint::from_path(path.as_path())?,
            identity: DataRootIdentity::capture(path.as_path())?,
            verified_source_hashes: verified_source_hashes.clone(),
            verified_tree_sha256: verified_tree_sha256.clone(),
        });
    }
    // The controller captures each target's directory identity while it still
    // holds the validated target; the worker only compares it and never derives
    // the identity of the directory it is about to delete.
    let mut target_identities = Vec::with_capacity(targets.len());
    for target in targets {
        let path = normalize_target_path(&target.path)?;
        let confirmed_data = data_roots.iter().map(PathBuf::from).collect::<Vec<_>>();
        if !stopping_only {
            crate::discovery::validate_local_data_selection(path.as_path(), strategy, &confirmed_data)?;
        }
        if !installation_markers_present(&target.fingerprint)
            || sidekickai_uninstall_core::product::validate_uninstall_identity(path.as_path()).is_err() {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetNotInstall,
                format!("目标不是可识别的 SidekickAI 安装：{}", path.as_string()),
                UninstallPhase::Validating,
                false,
                operation_id,
            ));
        }
        target_identities.push(TargetDirectoryProof {
            path: path.as_string(),
            directory: DirectoryIdentity::from_path(path.as_path())?,
        });
    }
    Ok((verified_data_roots, target_identities))
}
