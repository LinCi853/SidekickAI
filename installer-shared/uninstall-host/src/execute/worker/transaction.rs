//! Durable uninstall isolation, compensating restoration and residual cleanup.

use super::deletion::ResolvedTarget;
use super::registration_snapshot::{self, RegistrationSnapshot};
use super::types::{WorkerDataRoot, WorkerOutcome, WorkerRequest};
use super::super::hashing::{sha256_file, write_atomic};
use super::super::identity::{current_user_sid, harden_operation_directory, DirectoryIdentity};
use super::super::pinned::{pin_external_ancestors, remove_item_pinned, rename_pinned};
use super::super::{internal, invalid_request};
use crate::startup_tasks::{self, TaskSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sidekickai_uninstall_core::lock::PathLocks;
use sidekickai_uninstall_core::path::{normalize_target_path, paths_equal, reject_reparse_points, NormalizedAbsolutePath};
use sidekickai_uninstall_core::protocol::*;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum State { Prepared, Isolating, Registering, Committed, Cleaning, Completed, RollingBack, RolledBack, RecoveryRequired }

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IsolatedRoot {
    original: PathBuf, container: PathBuf, isolated: PathBuf,
    identity: DirectoryIdentity, container_identity: DirectoryIdentity,
    parent_identity: DirectoryIdentity,
    moved: bool, cleaned: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShortcutSnapshot { path: PathBuf, bytes: Vec<u8>, sha256: String }

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema: u32, task_id: String, sid: String, state: State, elevated: bool,
    install_paths: Vec<String>, data_paths: Vec<String>, roots: Vec<IsolatedRoot>,
    registrations: Vec<RegistrationSnapshot>, tasks: Vec<TaskSnapshot>, shortcuts: Vec<ShortcutSnapshot>,
    message: String,
    #[serde(default)]
    backup_proofs: Vec<super::types::BackupProof>,
}

#[cfg(test)]
thread_local! { static TEST_ROOT: std::cell::RefCell<PathBuf> = std::cell::RefCell::new(std::env::temp_dir().join(format!("SidekickAI-Journal-Test-{}", super::prepare::random_nonce().unwrap()))); }

fn journal_root() -> Result<PathBuf, UninstallError> {
    #[cfg(test)] { return Ok(TEST_ROOT.with(|root| root.borrow().clone())); }
    #[cfg(not(test))] {
        std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("SidekickAI/Maintenance/uninstall"))
            .ok_or_else(|| internal("无法定位当前用户的维护任务目录。"))
    }
}

fn task_directory(task_id: &str) -> Result<PathBuf, UninstallError> {
    super::validate::validate_worker_identifier(task_id, "taskId", task_id)?;
    Ok(journal_root()?.join(format!("{:x}", Sha256::digest(task_id.as_bytes()))))
}

fn save(journal: &Journal) -> Result<(), UninstallError> {
    let directory = task_directory(&journal.task_id)?;
    reject_reparse_points(&directory)?;
    fs::create_dir_all(&directory).map_err(|error| internal(error.to_string()))?;
    harden_operation_directory(&directory)?;
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| internal(error.to_string()))?;
    write_atomic(&directory.join("task.json"), &bytes).map_err(internal)
}

fn load(task_id: &str) -> Result<Journal, UninstallError> {
    let path = task_directory(task_id)?.join("task.json");
    reject_reparse_points(&path)?;
    let metadata = fs::metadata(&path).map_err(|error| internal(format!("无法读取维护任务：{error}")))?;
    if metadata.len() > 32 * 1024 * 1024 { return Err(invalid_request(task_id, "维护任务清单过大。")); }
    let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(|error| internal(error.to_string()))?)
        .map_err(|error| internal(format!("维护任务清单损坏，原位置和隔离副本已保留：{error}")))?;
    if journal.schema != 1 || journal.task_id != task_id || journal.sid != current_user_sid()? {
        return Err(invalid_request(task_id, "维护任务身份或账户不匹配。"));
    }
    if !matches!(journal.state, State::Completed | State::RolledBack) { validate_journal(&journal)?; }
    Ok(journal)
}

fn validate_journal(journal: &Journal) -> Result<(), UninstallError> {
    for root in &journal.roots {
        let original = NormalizedAbsolutePath::parse_target(&root.original)?;
        reject_reparse_points(original.as_path())?;
        let in_scope = journal.install_paths.iter().any(|path| paths_equal(&root.original, Path::new(path))
            || root.original.parent().is_some_and(|parent| paths_equal(parent, Path::new(path))))
            || journal.data_paths.iter().any(|path| paths_equal(&root.original, Path::new(path)));
        if !in_scope { return Err(invalid_request(&journal.task_id, "恢复条目超出已确认安装和数据范围。")); }
        if let Some(reason) = super::validate::protected_scope_reason(original.as_path()) { return Err(invalid_request(&journal.task_id, reason)); }
        let expected_prefix = format!(".SidekickAI-Uninstall-{}-", &format!("{:x}", Sha256::digest(journal.task_id.as_bytes()))[..16]);
        if root.original.parent() != root.container.parent() || root.isolated != root.container.join("content")
            || !root.container.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&expected_prefix)
                && name.len() == expected_prefix.len() + 32 && name[expected_prefix.len()..].bytes().all(|byte| byte.is_ascii_hexdigit())) {
            return Err(invalid_request(&journal.task_id, "隔离副本位置与原目录不匹配。"));
        }
        reject_reparse_points(&root.container)?;
        if root.original.parent().map(DirectoryIdentity::from_path).transpose()?.as_ref() != Some(&root.parent_identity) {
            return Err(invalid_request(&journal.task_id, "原位置的父目录身份已变化，已保留隔离副本。"));
        }
        if root.container.exists() && DirectoryIdentity::from_path(&root.container)? != root.container_identity {
            return Err(invalid_request(&journal.task_id, "隔离容器身份已变化，未处理其中内容。"));
        }
    }
    for registration in &journal.registrations {
        if !journal.install_paths.iter().any(|path| paths_equal(Path::new(path), Path::new(&registration.install))) {
            return Err(invalid_request(&journal.task_id, "卸载登记不属于任务确认范围。"));
        }
    }
    for snapshot in &journal.tasks {
        if let Some(executable) = &snapshot.executable {
            if !journal.install_paths.iter().any(|path| paths_equal(&Path::new(path).join("SidekickAI.exe"), Path::new(executable))) {
                return Err(invalid_request(&journal.task_id, "启动任务不属于确认范围。"));
            }
        }
    }
    Ok(())
}

fn failure(task_id: &str, message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::DeleteFailed, message, UninstallPhase::Commit, true, task_id)
        .with_detail("taskId", DetailValue::String(task_id.into()))
}

fn prepare(request: &WorkerRequest, targets: &[ResolvedTarget], data: &[(&WorkerDataRoot, NormalizedAbsolutePath)]) -> Result<Journal, UninstallError> {
    if task_directory(&request.request_id)?.join("task.json").exists() {
        let previous = load(&request.request_id)?;
        if !matches!(previous.state, State::RolledBack | State::Completed) {
            return Err(failure(&request.request_id, "该任务仍有待恢复内容，请先继续处理原任务。"));
        }
    }
    let mut journal = Journal { schema: 1, task_id: request.request_id.clone(), sid: current_user_sid()?, state: State::Prepared,
        elevated: super::process::is_process_elevated(), install_paths: targets.iter().map(|target| target.path.as_string()).collect(),
        data_paths: data.iter().map(|(_, path)| path.as_string()).collect(), roots: Vec::new(), registrations: Vec::new(),
        tasks: Vec::new(), shortcuts: Vec::new(), message: String::new(), backup_proofs: request.backup_proofs.clone() };
    for target in targets {
        for root in &target.target.registered_roots {
            journal.registrations.extend(registration_snapshot::capture(root, target.path.as_path()).map_err(|error| failure(&journal.task_id, error))?);
        }
        journal.tasks.push(startup_tasks::snapshot_installation(target.path.as_path()).map_err(|error| failure(&journal.task_id, error))?);
        for path in super::registry::owned_shortcuts(target.path.as_path(), target.target.scope == InstallScope::AllUsers, target.edition)
            .map_err(|error| failure(&journal.task_id, error))? {
            reject_reparse_points(&path)?;
            if fs::metadata(&path).map_err(|error| internal(error.to_string()))?.len() > 1024 * 1024 { return Err(failure(&journal.task_id, "快捷方式过大，未开始卸载。")); }
            let bytes = fs::read(&path).map_err(|error| internal(error.to_string()))?;
            journal.shortcuts.push(ShortcutSnapshot { path, sha256: format!("{:x}", Sha256::digest(&bytes)), bytes });
        }
    }
    let mut candidates = Vec::new();
    for target in targets {
        let preserved = if request.strategy == DataStrategy::Keep { crate::discovery::local_data_state_paths(target.path.as_path())? } else { Vec::new() };
        if preserved.is_empty() {
            candidates.push((target.path.as_path().to_owned(), target.identity.clone()));
        } else {
            for entry in fs::read_dir(target.path.as_path()).map_err(|error| internal(error.to_string()))? {
                let entry = entry.map_err(|error| internal(error.to_string()))?;
                if entry.file_name().to_string_lossy().eq_ignore_ascii_case("portable.txt") || preserved.iter().any(|path| paths_equal(path, &entry.path())) { continue; }
                candidates.push((entry.path(), DirectoryIdentity::from_path(&entry.path())?));
            }
        }
    }
    candidates.extend(data.iter().filter(|(_, path)| !targets.iter().any(|target| path.is_same_or_descendant_of(&target.path)))
        .map(|(data, path)| (path.as_path().to_owned(), data.identity.directory.clone())));
    save(&journal)?;
    for (original, identity) in candidates {
        let parent = original.parent().ok_or_else(|| failure(&journal.task_id, "隔离目标缺少父目录。"))?;
        let container = parent.join(format!(".SidekickAI-Uninstall-{}-{}", &format!("{:x}", Sha256::digest(journal.task_id.as_bytes()))[..16], super::prepare::random_nonce()?));
        fs::create_dir(&container).map_err(|error| failure(&journal.task_id, format!("无法准备同卷恢复位置 {}：{error}", container.display())))?;
        harden_operation_directory(&container)?;
        let container_identity = DirectoryIdentity::from_path(&container)?;
        let parent_identity = DirectoryIdentity::from_path(parent)?;
        journal.roots.push(IsolatedRoot { original, isolated: container.join("content"), container, identity, container_identity, parent_identity, moved: false, cleaned: false });
        save(&journal)?;
    }
    Ok(journal)
}

fn rollback(journal: &mut Journal) -> Result<(), UninstallError> {
    journal.state = State::RollingBack; save(journal)?;
    let mut errors = Vec::new();
    for root in journal.roots.iter().rev() {
        if root.isolated.exists() {
            if root.original.exists() { errors.push(format!("恢复位置已存在：{}", root.original.display())); continue; }
            if let Err(error) = rename_pinned(&root.isolated, &root.original, &root.identity) { errors.push(error); }
        } else if !root.original.exists() || DirectoryIdentity::from_path(&root.original).ok().as_ref() != Some(&root.identity) {
            errors.push(format!("原件或恢复副本无法确认：{}", root.original.display()));
        }
    }
    if errors.is_empty() {
        for registration in &journal.registrations { if let Err(error) = registration_snapshot::restore(registration) { errors.push(error); } }
        for snapshot in &journal.tasks { if let Err(error) = startup_tasks::restore_snapshot(snapshot) { errors.push(error); } }
        for snapshot in &journal.shortcuts {
            let result = if snapshot.path.exists() {
                sha256_file(&snapshot.path).and_then(|hash| if hash == snapshot.sha256 { Ok(()) } else { Err(format!("快捷方式恢复位置已有不同内容：{}", snapshot.path.display())) })
            } else {
                (|| { let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&snapshot.path).map_err(|error| error.to_string())?;
                    file.write_all(&snapshot.bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string()) })()
            };
            if let Err(error) = result { errors.push(error); }
        }
    }
    if errors.is_empty() {
        journal.state = State::RolledBack; journal.message = "已恢复原安装、数据与登记，可以重新尝试卸载。".into();
        for root in &journal.roots { let _ = fs::remove_dir(&root.container); }
    } else {
        journal.state = State::RecoveryRequired; journal.message = errors.join("；");
    }
    save(journal)?;
    if errors.is_empty() { Ok(()) } else { Err(failure(&journal.task_id, format!("自动恢复未完成，副本与清单已保留：{}", journal.message))) }
}

fn cleanup(journal: &mut Journal, outcome: &mut WorkerOutcome) -> Result<(), UninstallError> {
    journal.state = State::Cleaning; save(journal)?;
    outcome.removed_install_paths = journal.install_paths.clone(); outcome.removed_data_roots = journal.data_paths.clone();
    let mut residuals = Vec::new();
    for index in 0..journal.roots.len() {
        let root = &journal.roots[index];
        let result = if !root.cleaned && root.isolated.exists() {
            remove_item_pinned(&root.isolated, &root.identity, false).map_err(|error| error.message)
        } else { Ok(()) };
        match result {
            Ok(()) => {
                journal.roots[index].cleaned = true;
                save(journal)?;
                if let Err(error) = fs::remove_dir(&journal.roots[index].container) {
                    if error.kind() != std::io::ErrorKind::NotFound { residuals.push(format!("{}：{error}", journal.roots[index].container.display())); }
                }
            }
            Err(error) => residuals.push(format!("{}：{error}", root.isolated.display())),
        }
    }
    if residuals.is_empty() { journal.state = State::Completed; journal.message = "卸载与残留清理已完成。".into(); }
    else { journal.message = format!("程序已卸载，仍有隔离副本待清理：{}", residuals.join("；"));
        outcome.warnings.push(format!("CLEANUP_PENDING: {}", journal.message)); }
    save(journal)?;
    Ok(())
}

pub(super) fn execute(
    request: &WorkerRequest, targets: &[ResolvedTarget], data: &[(&WorkerDataRoot, NormalizedAbsolutePath)],
    outcome: &mut WorkerOutcome, cleanup_tasks: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), UninstallError> {
    let mut journal = prepare(request, targets, data)?;
    let paths = journal.roots.iter().flat_map(|root| [root.original.clone(), root.container.clone()]).collect::<Vec<_>>();
    let _pins = pin_external_ancestors(&paths)?;
    let result = (|| {
        journal.state = State::Isolating; save(&journal)?;
        for index in 0..journal.roots.len() {
            let root = &journal.roots[index];
            rename_pinned(&root.original, &root.isolated, &root.identity).map_err(|error| failure(&journal.task_id, error))?;
            journal.roots[index].moved = true; save(&journal)?;
        }
        journal.state = State::Registering; save(&journal)?;
        for registration in &journal.registrations { registration_snapshot::remove(registration).map_err(|error| failure(&journal.task_id, error))?; }
        for snapshot in &journal.tasks { startup_tasks::remove_snapshot(snapshot).map_err(|error| failure(&journal.task_id, error))?; }
        for target in targets { cleanup_tasks(target.path.as_path()).map_err(|error| UninstallError::new(
            UninstallErrorCode::RegistryFailed, error, UninstallPhase::RemovingRegistry, true, &request.operation_id))?; }
        for snapshot in &journal.shortcuts {
            reject_reparse_points(&snapshot.path)?;
            if sha256_file(&snapshot.path).map_err(internal)? != snapshot.sha256 { return Err(failure(&journal.task_id, "快捷方式已由外部修改，未覆盖。")); }
            fs::remove_file(&snapshot.path).map_err(|error| failure(&journal.task_id, error.to_string()))?;
        }
        journal.state = State::Committed; save(&journal)?;
        Ok(())
    })();
    if let Err(mut error) = result {
        match rollback(&mut journal) {
            Ok(()) => error.message.push_str("；已恢复原安装、数据和登记。"),
            Err(restore) => { error.message.push_str(&format!("；{}", restore.message)); outcome.warnings.push(format!("RECOVERY_REQUIRED: {}", journal.message)); }
        }
        return Err(error.with_detail("taskId", DetailValue::String(journal.task_id)));
    }
    cleanup(&mut journal, outcome)
}

pub(crate) fn discover() -> Result<Vec<UninstallRecoveryTask>, UninstallError> {
    let directory = journal_root()?;
    if !directory.exists() { return Ok(Vec::new()); }
    reject_reparse_points(&directory)?;
    let mut tasks = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| internal(error.to_string()))? {
        let entry = entry.map_err(|error| internal(error.to_string()))?;
        let path = entry.path().join("task.json");
        if !path.is_file() { continue; }
        reject_reparse_points(&path)?;
        let raw: ValueEnvelope = serde_json::from_slice(&fs::read(&path).map_err(|error| internal(error.to_string()))?)
            .map_err(|error| internal(format!("维护任务清单无法识别：{}：{error}", path.display())))?;
        let journal = load(&raw.task_id)?;
        if matches!(journal.state, State::Completed | State::RolledBack) { continue; }
        let backups = journal.backup_proofs.iter().map(|proof| BackupResult { path: proof.path.clone(),
            format: if proof.path.to_lowercase().ends_with(".sabackup") { BackupFormat::Sabackup } else { BackupFormat::Zip },
            categories: Vec::new(), verified: sha256_file(Path::new(&proof.path)).is_ok_and(|hash| hash == proof.archive_sha256),
            entry_count: Some(proof.entry_hashes.len() as u64) }).collect();
        tasks.push(UninstallRecoveryTask { task_id: journal.task_id, state: format!("{:?}", journal.state).to_lowercase(), backups,
            install_paths: journal.install_paths, data_paths: journal.data_paths,
            residual_paths: journal.roots.iter().filter(|root| root.container.exists()).map(|root| root.isolated.to_string_lossy().into_owned()).collect(),
            requires_elevation: journal.elevated, message: if journal.message.is_empty() { "发现尚未结束的卸载任务，继续时先恢复或完成原任务。".into() } else { journal.message } });
    }
    Ok(tasks)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValueEnvelope { task_id: String }

pub(super) fn resume(request: &WorkerRequest, outcome: &mut WorkerOutcome) -> Result<(), UninstallError> {
    super::validate::validate_worker_request(request)?;
    super::prepare::assert_trusted_caller(request)?;
    let task_id = request.resume_task_id.as_deref().ok_or_else(|| invalid_request(&request.operation_id, "缺少恢复任务身份。"))?;
    let mut journal = load(task_id)?;
    if journal.state == State::Completed {
        outcome.removed_install_paths = journal.install_paths;
        outcome.removed_data_roots = journal.data_paths;
        return Ok(());
    }
    if journal.state == State::RolledBack { return Err(failure(task_id, journal.message)); }
    let paths = journal.roots.iter().flat_map(|root| [root.original.clone(), root.container.clone()]).collect::<Vec<_>>();
    let _locks = PathLocks::acquire(&paths, "worker")?;
    let _pins = pin_external_ancestors(&paths)?;
    if matches!(journal.state, State::Committed | State::Cleaning) {
        cleanup(&mut journal, outcome)
    } else {
        rollback(&mut journal)?;
        outcome.warnings.push("UNINSTALL_ROLLED_BACK: 原安装和数据已恢复，请重新扫描后选择卸载。".into());
        Err(failure(task_id, journal.message))
    }
}

#[cfg(test)]
mod tests;
