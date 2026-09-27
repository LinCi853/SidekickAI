//! One worker authorization covers process shutdown and verified deletion.

use super::deletion::{resolve_worker_targets, run_worker_deletion};
use super::prepare::{assert_trusted_caller, capture_worker_scopes, cleanup_directory, prepare_worker_request};
use super::process::{process_is_alive, spawn_worker, stop_worker_processes, wait_for_outcome, wait_for_worker_exit, WorkerProcess};
use super::types::{BackupProof, WorkerOutcome, WorkerPreparation, WorkerRequest, WorkerTarget};
use super::validate::{validate_operation_directory_name, validate_worker_request};
use super::super::hashing::write_atomic;
use super::super::{internal, invalid_request, WORKER_TIMEOUT};
use sidekickai_uninstall_core::lock::PathLocks;
use sidekickai_uninstall_core::path::{paths_equal, reject_reparse_points};
use sidekickai_uninstall_core::protocol::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "../../../../test-fixtures.rs"]
mod edition_fixtures;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerReady {
    protocol_version: u32,
    operation_id: String,
    nonce: String,
    worker_pid: u32,
}

pub(crate) struct WorkerSession {
    directory: PathBuf,
    request: WorkerRequest,
    process: WorkerProcess,
    committed: bool,
}

impl WorkerSession {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        source_exe: &Path, operation_id: &str, request_id: &str,
        targets: &[WorkerTarget], strategy: &DataStrategy, data_roots: &[String],
        elevate: bool, cancelled: impl Fn() -> bool,
    ) -> Result<Self, UninstallError> {
        let preparation = WorkerPreparation { strategy: strategy.clone(), data_roots: data_roots.to_vec() };
        let (directory, request_path, _) = prepare_worker_request(
            source_exe, operation_id, request_id, &DataStrategy::Keep, targets, &[], None, None, Some(preparation),
        )?;
        let request: WorkerRequest = serde_json::from_slice(&fs::read(&request_path).map_err(|e| internal(e.to_string()))?)
            .map_err(|e| internal(e.to_string()))?;
        let process = match spawn_worker(&directory.join("worker.exe"), &request_path, elevate) {
            Ok(process) => process,
            Err(error) => { cleanup_directory(&directory); return Err(error); }
        };
        let session = Self { directory, request, process, committed: false };
        session.wait_ready(cancelled)?;
        Ok(session)
    }

    fn wait_ready(&self, cancelled: impl Fn() -> bool) -> Result<(), UninstallError> {
        let started = Instant::now();
        loop {
            if cancelled() { return Err(aborted(&self.request, "卸载已取消，尚未删除内容。")); }
            if self.directory.join("result.json").exists() || self.process.exit_code().is_some() {
                let outcome = wait_for_outcome(&self.directory, &self.request.nonce, &self.request.operation_id,
                    Arc::new(AtomicBool::new(false)), &self.process)?;
                return Err(outcome.error.unwrap_or_else(|| aborted(&self.request, "工作进程在准备删除前退出，尚未删除内容。")));
            }
            let ready = self.directory.join("ready.json");
            if ready.exists() {
                reject_reparse_points(&ready)?;
                let value: WorkerReady = serde_json::from_slice(&fs::read(&ready).map_err(|e| internal(e.to_string()))?)
                    .map_err(|e| internal(e.to_string()))?;
                if value.protocol_version != UNINSTALL_PROTOCOL_VERSION || value.operation_id != self.request.operation_id
                    || value.nonce != self.request.nonce || value.worker_pid != self.process.pid() {
                    return Err(invalid_request(&self.request.operation_id, "进程关闭确认与当前操作不匹配。"));
                }
                return Ok(());
            }
            if started.elapsed() >= WORKER_TIMEOUT { return Err(aborted(&self.request, "等待关闭程序超时，尚未删除内容。")); }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub(crate) fn commit(
        mut self, strategy: &DataStrategy, data_roots: &[String],
        backup_path: Option<&str>, proof: Option<&BackupProof>,
    ) -> Result<WorkerOutcome, UninstallError> {
        let (data, identities) = capture_worker_scopes(&self.request.operation_id, strategy,
            &self.request.targets, data_roots, backup_path, proof, false)?;
        let mut request = self.request.clone();
        request.preparation = None;
        request.strategy = strategy.clone();
        request.target_identities = identities;
        request.data_roots = data;
        request.backup_path = backup_path.map(str::to_string);
        request.backup_sha256 = proof.map(|proof| proof.archive_sha256.clone());
        validate_commit(&self.request, &request)?;
        let bytes = serde_json::to_vec(&request).map_err(|e| internal(e.to_string()))?;
        write_atomic(&self.directory.join("commit.json"), &bytes).map_err(internal)?;
        self.committed = true;
        let result = wait_for_outcome(&self.directory, &request.nonce, &request.operation_id,
            Arc::new(AtomicBool::new(false)), &self.process);
        match result {
            Ok(mut outcome) => {
                if let Some(error) = outcome.error.take() {
                    outcome.error = Some(error.with_detail("workerPid", DetailValue::Number(self.process.pid() as i64)));
                }
                cleanup_directory(&self.directory);
                Ok(outcome)
            }
            Err(error) => Err(error.with_detail("workerPid", DetailValue::Number(self.process.pid() as i64))
                .with_detail("operationDirectory", DetailValue::String(self.directory.to_string_lossy().into_owned()))),
        }
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        if !self.committed {
            let _ = write_atomic(&self.directory.join("abort.json"), self.request.nonce.as_bytes());
            wait_for_worker_exit(&self.process, &mut false);
            cleanup_directory(&self.directory);
        }
    }
}

fn aborted(request: &WorkerRequest, message: &str) -> UninstallError {
    UninstallError::new(UninstallErrorCode::Internal, message, UninstallPhase::Stopping, true, &request.operation_id)
}

pub(super) fn validate_commit(initial: &WorkerRequest, commit: &WorkerRequest) -> Result<(), UninstallError> {
    let policy = initial.preparation.as_ref().ok_or_else(|| invalid_request(&initial.operation_id, "缺少删除前确认范围。"))?;
    validate_worker_request(commit)?;
    let same_targets = serde_json::to_value(&initial.targets).map_err(|e| internal(e.to_string()))?
        == serde_json::to_value(&commit.targets).map_err(|e| internal(e.to_string()))?;
    let same_data = policy.data_roots.len() == commit.data_roots.len()
        && policy.data_roots.iter().all(|path| commit.data_roots.iter()
            .filter(|root| paths_equal(Path::new(path), Path::new(&root.path))).count() == 1);
    if commit.preparation.is_some() || initial.operation_id != commit.operation_id || initial.request_id != commit.request_id
        || initial.nonce != commit.nonce || initial.controller_pid != commit.controller_pid
        || initial.caller_user_sid != commit.caller_user_sid || initial.worker_sha256 != commit.worker_sha256
        || initial.target_identities != commit.target_identities || !same_targets
        || policy.strategy != commit.strategy || !same_data {
        return Err(invalid_request(&initial.operation_id, "删除确认改变了原操作身份或已确认范围，未删除内容。"));
    }
    Ok(())
}

pub(super) fn run_worker_session(
    request: &WorkerRequest, directory: &Path, outcome: &mut WorkerOutcome,
) -> Result<(), UninstallError> {
    validate_worker_request(request)?;
    validate_operation_directory_name(directory, &request.operation_id)?;
    assert_trusted_caller(request)?;
    if request.strategy != DataStrategy::Keep || !request.data_roots.is_empty() {
        return Err(invalid_request(&request.operation_id, "准备操作不能携带删除指令。"));
    }
    let resolved = resolve_worker_targets(request)?;
    let paths = resolved.iter().map(|target| target.path.as_path().to_owned()).collect::<Vec<_>>();
    let scopes = resolved.iter().map(|target| target.path.clone()).collect::<Vec<_>>();
    let locks = PathLocks::acquire(&paths, "worker")?;
    stop_worker_processes(request, &scopes)?;
    let ready = WorkerReady { protocol_version: UNINSTALL_PROTOCOL_VERSION, operation_id: request.operation_id.clone(),
        nonce: request.nonce.clone(), worker_pid: std::process::id() };
    write_atomic(&directory.join("ready.json"), &serde_json::to_vec(&ready).map_err(|e| internal(e.to_string()))?).map_err(internal)?;
    let started = Instant::now();
    loop {
        if directory.join("abort.json").exists() || !process_is_alive(request.controller_pid) || started.elapsed() >= WORKER_TIMEOUT {
            return Err(aborted(request, "删除确认未完成，已退出且未删除内容。"));
        }
        let path = directory.join("commit.json");
        if path.exists() {
            reject_reparse_points(&path)?;
            let commit: WorkerRequest = serde_json::from_slice(&fs::read(&path).map_err(|e| internal(e.to_string()))?)
                .map_err(|e| invalid_request(&request.operation_id, e.to_string()))?;
            validate_commit(request, &commit)?;
            assert_trusted_caller(&commit)?;
            outcome.warnings = if commit.strategy == DataStrategy::Keep { vec!["USER_DATA_PRESERVED".into()] } else { Vec::new() };
            drop(locks);
            return run_worker_deletion(&commit, directory, outcome);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::prepare::random_nonce;
    use super::super::tests::standalone_artifact;
    use sidekickai_uninstall_core::scan::FileFingerprint;
    use std::os::windows::process::CommandExt;

    fn installation(root: &Path) -> WorkerTarget {
        fs::create_dir_all(root.join("resources")).unwrap();
        let ping = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/ping.exe");
        fs::copy(ping, root.join("SidekickAI.exe")).unwrap();
        fs::write(root.join("resources/app.asar"), edition_fixtures::app_archive(b"fixture")).unwrap();
        fs::write(root.join("uninstall.exe"), b"fixture").unwrap();
        WorkerTarget { path: root.to_string_lossy().into_owned(), scope: InstallScope::PerUser,
            fingerprint: FileFingerprint::from_path(root).unwrap(), registered_roots: vec![] }
    }

    #[test]
    fn authorized_worker_stops_then_waits_for_commit() {
        let Some(artifact) = standalone_artifact() else { return; };
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("selected");
        let target = installation(&install);
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data/sentinel"), b"keep").unwrap();
        let mut child = std::process::Command::new(install.join("SidekickAI.exe"))
            .args(["-n", "60", "127.0.0.1"]).creation_flags(0x08000000)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let session = WorkerSession::start(&artifact, "stop-commit", "request", &[target], &DataStrategy::Keep, &[], false, || false).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        assert!(install.join("SidekickAI.exe").exists(), "shutdown must not delete");
        assert!(session.process.exit_code().is_none(), "the authorized process must stay alive");
        let process = WorkerProcess::open_for_test(session.process.pid()).unwrap();
        let outcome = session.commit(&DataStrategy::Keep, &[], None, None).unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert!(process.exit_code().is_some());
        assert!(!install.exists());
        assert_eq!(fs::read(root.join("data/sentinel")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abandoned_preparation_exits_without_deleting() {
        let Some(artifact) = standalone_artifact() else { return; };
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = installation(&root);
        let session = WorkerSession::start(&artifact, "stop-abandon", "request", &[target], &DataStrategy::Keep, &[], false, || false).unwrap();
        let process = WorkerProcess::open_for_test(session.process.pid()).unwrap();
        drop(session);
        assert!(process.exit_code().is_some());
        assert!(root.join("SidekickAI.exe").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_cannot_change_the_confirmed_scope_or_identity() {
        let Some(artifact) = standalone_artifact() else { return; };
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = installation(&root);
        let session = WorkerSession::start(&artifact, "stop-bound", "request", &[target], &DataStrategy::Keep, &[], false, || false).unwrap();
        let mut valid = session.request.clone();
        valid.preparation = None;
        validate_commit(&session.request, &valid).unwrap();
        let mut changed = valid.clone();
        changed.nonce = "00000000000000000000000000000000".into();
        assert!(validate_commit(&session.request, &changed).is_err());
        changed = valid.clone();
        changed.strategy = DataStrategy::Delete;
        assert!(validate_commit(&session.request, &changed).is_err());
        changed = valid.clone();
        changed.target_identities[0].directory.file_index_low ^= 1;
        assert!(validate_commit(&session.request, &changed).is_err());
        changed = valid;
        changed.targets[0].path.push_str("-other");
        assert!(validate_commit(&session.request, &changed).is_err());
        drop(session);
        assert!(root.join("SidekickAI.exe").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
