//! Worker-side execution entry and irreversible deletion.

use super::super::hashing::{sha256_file, write_atomic};
use super::super::identity::DirectoryIdentity;
use super::super::pinned::{pin_external_ancestors, RemovalFailure};
use super::super::tree::export_tree_digest;
use super::prepare::assert_trusted_caller;
use super::types::{WorkerDataRoot, WorkerOutcome, WorkerRequest, WorkerTarget};
use super::validate::{
    protected_scope_reason, reject_dangerous_overlaps, validate_operation_directory_name,
    validate_request_location_for, validate_worker_request,
};
use super::{
    installation_markers_present, verify_verified_source_hashes,
};
use super::super::{internal, invalid_request, SHA256_HEX_LEN};
use sidekickai_uninstall_core::lock::PathLocks;
use sidekickai_uninstall_core::path::{
    normalize_target_path, paths_equal, validate_tree, NormalizedAbsolutePath,
};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::scan::FileFingerprint;
use std::fs;
use std::path::{Path, PathBuf};

pub fn run_worker(request_path: &str) -> i32 {
    match execute_worker(Path::new(request_path)) {
        Ok(true) => 0,
        Ok(false) => 20,
        Err(_) => 30,
    }
}

pub(super) fn execute_worker(request_path: &Path) -> Result<bool, UninstallError> {
    let current = std::env::current_exe().map_err(|e| internal(e.to_string()))?;
    execute_worker_with(request_path, &current)
}

/// Split from the process-wide executable lookup so the deletion path can be
/// exercised end to end against an isolated fixture root.
pub(super) fn execute_worker_with(request_path: &Path, worker_path: &Path) -> Result<bool, UninstallError> {
    validate_request_location_for(request_path, worker_path)?;
    let directory = request_path.parent().ok_or_else(|| internal("工作请求路径无效。"))?.to_path_buf();
    let request: WorkerRequest = serde_json::from_slice(&fs::read(request_path).map_err(|e| internal(e.to_string()))?)
        .map_err(|e| internal(format!("工作请求无效：{e}")))?;
    let mut outcome = WorkerOutcome {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        operation_id: request.operation_id.clone(),
        nonce: request.nonce.clone(),
        removed_install_paths: Vec::new(),
        removed_data_roots: Vec::new(),
        partially_removed_paths: Vec::new(),
        warnings: if request.strategy == DataStrategy::Keep { vec!["USER_DATA_PRESERVED".into()] } else { Vec::new() },
        error: None,
    };
    // The worker must be the exact image the controller relocated and hashed,
    // otherwise a swapped executable could delete under this request's authority.
    outcome.error = verify_worker_image(&request, worker_path)
        .err()
        .or_else(|| {
            if request.resume_task_id.is_some() {
                super::transaction::resume(&request, &mut outcome).err()
            } else if request.preparation.is_some() {
                super::session::run_worker_session(&request, &directory, &mut outcome).err()
            } else {
                run_worker_deletion(&request, &directory, &mut outcome).err()
            }
        });
    let succeeded = outcome.error.is_none();
    let bytes = serde_json::to_vec_pretty(&outcome).map_err(|e| internal(e.to_string()))?;
    write_atomic(&directory.join("result.json"), &bytes).map_err(internal)?;
    Ok(succeeded)
}

/// Bind the running worker image to the hash recorded in the request.
///
/// Honest limit: the request file is writable by the same user, so this binds
/// the request to the image it was prepared for; it is not authenticity against
/// a same-user process that rewrites both the request and the image. The private
/// operation-directory ACL and the alternate-admin SID check (which does fail
/// closed) narrow that window without eliminating it.
pub(super) fn verify_worker_image(request: &WorkerRequest, worker_path: &Path) -> Result<(), UninstallError> {
    if request.worker_sha256.len() != SHA256_HEX_LEN
        || !request.worker_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid_request(&request.operation_id, "工作请求未绑定工作进程镜像哈希。"));
    }
    let actual = sha256_file(worker_path).map_err(|e| internal(format!("无法计算工作进程镜像哈希：{e}")))?;
    if !actual.eq_ignore_ascii_case(&request.worker_sha256) {
        return Err(invalid_request(
            &request.operation_id,
            "正在运行的工作进程镜像与本请求准备的重定位副本不一致。",
        ));
    }
    Ok(())
}

pub(super) struct ResolvedTarget {
    pub(super) target: WorkerTarget,
    pub(super) path: NormalizedAbsolutePath,
    pub(super) identity: DirectoryIdentity,
    pub(super) edition: &'static sidekickai_uninstall_core::product::Edition,
}

pub(super) fn removal_failure(
    path: &NormalizedAbsolutePath,
    phase: UninstallPhase,
    operation_id: &str,
    failure: &RemovalFailure,
) -> UninstallError {
    UninstallError::new(
        UninstallErrorCode::DeleteFailed,
        format!("无法移除 {}：{}", failure.path.display(), failure.message),
        phase,
        false,
        operation_id,
    )
    .with_detail("partiallyRemovedPath", DetailValue::String(path.as_string()))
    .with_detail("removedEntries", DetailValue::Number(failure.removed_entries as i64))
}

/// The controller-captured directory identity for one target. The worker never
/// derives this itself: a same-user process could otherwise replace the
/// directory and have the worker validate its own replacement.
pub(super) fn target_directory_identity<'a>(request: &'a WorkerRequest, path: &Path) -> Result<&'a DirectoryIdentity, UninstallError> {
    request
        .target_identities
        .iter()
        .find(|proof| paths_equal(Path::new(&proof.path), path))
        .map(|proof| &proof.directory)
        .ok_or_else(|| invalid_request(&request.operation_id, "工作请求未为此目标绑定目录标识。"))
}

/// Prove that the raw archive file is still the exact file the strict receipt
/// verified. An encrypted SABK container is hashed as stored, so re-encryption
/// or a swapped archive is refused before any deletion.
pub(super) fn verify_backup_archive(request: &WorkerRequest) -> Result<(), UninstallError> {
    for proof in &request.backup_proofs {
        let actual = sha256_file(Path::new(&proof.path)).map_err(|error| UninstallError::new(
            UninstallErrorCode::BackupIncomplete, format!("已校验的备份无法读取：{error}"),
            UninstallPhase::Validating, true, &request.operation_id))?;
        if !actual.eq_ignore_ascii_case(&proof.archive_sha256) {
            return Err(invalid_request(&request.operation_id, "已验证备份归档发生变化，未执行删除。"));
        }
    }
    let (Some(path), Some(expected)) = (request.backup_path.as_deref(), request.backup_sha256.as_deref()) else {
        return Ok(());
    };
    let actual = sha256_file(Path::new(path)).map_err(|error| {
        UninstallError::new(
            UninstallErrorCode::BackupIncomplete,
            format!("已校验的备份归档无法读取：{error}"),
            UninstallPhase::Validating,
            false,
            &request.operation_id,
        )
    })?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(UninstallError::new(
            UninstallErrorCode::BackupIncomplete,
            "备份归档在校验后已变化，未执行删除。",
            UninstallPhase::Validating,
            false,
            &request.operation_id,
        ));
    }
    Ok(())
}

/// The irreversible worker section. The caller owns `outcome` so every path that
/// was actually removed survives a later failure.
pub(super) fn run_worker_deletion(
    request: &WorkerRequest,
    directory: &Path,
    outcome: &mut WorkerOutcome,
) -> Result<(), UninstallError> {
    run_worker_deletion_with_task_cleanup(request, directory, outcome, &mut crate::startup_tasks::remove_installation)
}

pub(super) fn run_worker_deletion_with_task_cleanup(
    request: &WorkerRequest,
    directory: &Path,
    outcome: &mut WorkerOutcome,
    cleanup_tasks: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), UninstallError> {
    validate_worker_request(request)?;
    if request.preparation.is_some() {
        return Err(invalid_request(&request.operation_id, "准备操作不能直接执行删除。"));
    }
    validate_operation_directory_name(directory, &request.operation_id)?;
    assert_trusted_caller(request)?;
    verify_backup_archive(request)?;

    // Resolve and validate every target and every data root before deleting any
    // of them; a changed or linked scope aborts the whole operation.
    let resolved_targets = resolve_worker_targets(request)?;
    let mut lock_paths: Vec<PathBuf> = resolved_targets.iter().map(|resolved| resolved.path.as_path().to_owned()).collect();
    for root in &request.data_roots { lock_paths.push(normalize_target_path(&root.path)?.as_path().to_owned()); }
    let _worker_locks = PathLocks::acquire(&lock_paths, "worker")?;
    let scopes = resolved_targets.iter().map(|target| target.path.clone()).collect::<Vec<_>>();
    super::process::stop_worker_processes(request, &scopes)?;
    let mut resolved_data: Vec<(&WorkerDataRoot, NormalizedAbsolutePath)> = Vec::new();
    for root in &request.data_roots {
        let path = normalize_target_path(&root.path)?;
        validate_tree(path.as_path())?;
        let current = FileFingerprint::from_path(path.as_path())?;
        if current != root.fingerprint {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("用户数据在扫描后已变化：{}", path.as_string()),
                UninstallPhase::Validating,
                false,
                &request.operation_id,
            ));
        }
        // Strong identity: the directory object must be the one the controller
        // captured (after any verified export) and its complete tree must be
        // byte-identical, including files that were overwritten in place.
        if let Err(_changed) = root.identity.verify(path.as_path()) {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("用户数据在扫描后已变化：{}", path.as_string()),
                UninstallPhase::Validating,
                false,
                &request.operation_id,
            ));
        }
        // Every byte the verified backup carries must still be present, even
        // though the snapshot itself may legitimately contain newer bytes.
        if !root.verified_source_hashes.is_empty() {
            verify_verified_source_hashes(&path, &root.verified_source_hashes, &request.operation_id)?;
        }
        // The complete exporter-time tree digest is the binding that also covers
        // unselected files: a file added after the export to a selected directory
        // (absent from `verified_source_hashes`) changes this digest and refuses
        // the deletion. The digest is never recaptured here as authorization.
        if let Some(expected) = &root.verified_tree_sha256 {
            let actual = export_tree_digest(path.as_path())?;
            if &actual != expected {
                return Err(UninstallError::new(
                    UninstallErrorCode::TargetChanged,
                    format!("用户数据在已校验导出后已变化：{}", path.as_string()),
                    UninstallPhase::Validating,
                    false,
                    &request.operation_id,
                ));
            }
        }
        resolved_data.push((root, path));
    }
    reject_dangerous_overlaps(&resolved_targets, &resolved_data, &request.operation_id)?;
    let confirmed_data = resolved_data.iter().map(|(_, path)| path.as_path().to_owned()).collect::<Vec<_>>();
    for target in &resolved_targets {
        crate::discovery::validate_local_data_selection(target.path.as_path(), &request.strategy, &confirmed_data)?;
    }

    // Pin the external ancestor chain of every scope (never a selected scope
    // itself, which would deadlock a portable in-place data root) from the
    // volume root downward, so the names cannot be renamed or swapped.
    let _ancestor_pins = pin_external_ancestors(&lock_paths)?;

    super::transaction::execute(request, &resolved_targets, &resolved_data, outcome, cleanup_tasks)
}

pub(super) fn resolve_worker_targets(request: &WorkerRequest) -> Result<Vec<ResolvedTarget>, UninstallError> {
    let mut resolved_targets: Vec<ResolvedTarget> = Vec::new();
    for target in &request.targets {
        let path = normalize_target_path(&target.path)?;
        // Protected roots are refused before the tree is walked: a fingerprint
        // (or even a source hash) does not identify which directory this is.
        if let Some(reason) = protected_scope_reason(path.as_path()) {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetScopeInvalid,
                reason,
                UninstallPhase::Validating,
                false,
                &request.operation_id,
            ));
        }
        sidekickai_uninstall_core::distribution::verify_installed_identity(path.as_path()).map_err(|message|
            UninstallError::new(UninstallErrorCode::TargetNotInstall, message, UninstallPhase::Validating, false, &request.operation_id))?;
        if !installation_markers_present(&target.fingerprint)
            || sidekickai_uninstall_core::product::validate_uninstall_identity(path.as_path()).is_err() {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetNotInstall,
                format!("目标不是可识别的 SidekickAI 安装：{}", path.as_string()),
                UninstallPhase::Validating,
                false,
                &request.operation_id,
            ));
        }
        validate_tree(path.as_path())?;
        let current = FileFingerprint::from_path(path.as_path())?;
        if current != target.fingerprint {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("目标在扫描后已变化：{}", path.as_string()),
                UninstallPhase::Validating,
                false,
                &request.operation_id,
            ));
        }
        let identity = target_directory_identity(request, path.as_path())?.clone();
        if DirectoryIdentity::from_path(path.as_path())? != identity {
            return Err(UninstallError::new(UninstallErrorCode::TargetChanged,
                "安装目录身份已变化，未关闭程序或删除内容。", UninstallPhase::Validating, false, &request.operation_id));
        }
        let (_, edition) = sidekickai_uninstall_core::product::installation_edition(path.as_path())
            .ok_or_else(|| invalid_request(&request.operation_id, "安装身份已变化。"))?;
        resolved_targets.push(ResolvedTarget { target: target.clone(), path, identity, edition });
    }
    Ok(resolved_targets)
}
