#[cfg(test)]
#[path = "../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
// Progress sink and operation orchestration shared by the Tauri commands.
use super::backup_export::export_and_verify;
use super::control::OperationControl;
use super::plan;
use super::execute::{self, WorkerTarget};
use sidekickai_uninstall_core::path::NormalizedAbsolutePath;
use sidekickai_uninstall_core::protocol::*;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(crate) fn emit(app: &AppHandle, operation_id: &str, request_id: &str, sequence: u64, phase: UninstallPhase, progress: u8, message: &str, terminal: bool, result: Option<UninstallResult>) {
    let summary = result.as_ref().map(|value| serde_json::json!({
        "state": value.state, "phase": value.phase, "removedInstallPaths": value.removed_install_paths,
        "removedDataRoots": value.removed_data_roots, "backup": value.backup, "warnings": value.warnings,
        "error": value.error.as_ref().map(|error| serde_json::json!({ "code": error.code, "message": error.message, "phase": error.phase })),
    }));
    let record = serde_json::json!({ "sequence": sequence, "phase": phase, "progress": progress,
        "message": message, "terminal": terminal, "result": summary });
    let saved = super::diagnostics::append_operation_log(operation_id, &record.to_string());
    let (log_path, log_error) = match saved {
        Ok(path) => (Some(path), None),
        Err(error) => (None, Some(format!("操作日志未能保存：{error}"))),
    };
    let _ = app.emit(UNINSTALL_EVENT, UninstallEvent {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        operation_id: operation_id.to_string(),
        request_id: request_id.to_string(),
        sequence,
        phase,
        progress,
        message: message.to_string(),
        terminal,
        result,
        log_path,
        log_error,
    });
}

/// Progress sink. Decoupling the execution plan from Tauri is what lets the
/// "export must fail before any deletion" ordering be verified end to end.
pub trait EventSink {
    fn event(&self, phase: UninstallPhase, progress: u8, message: &str, terminal: bool, result: Option<UninstallResult>);
}

/// Emits protocol events to the calling window.
pub(crate) struct TauriSink {
    pub(crate) app: AppHandle,
    pub(crate) operation_id: String,
    pub(crate) request_id: String,
    pub(crate) sequence: AtomicU64,
}

impl EventSink for TauriSink {
    fn event(&self, phase: UninstallPhase, progress: u8, message: &str, terminal: bool, result: Option<UninstallResult>) {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        emit(&self.app, &self.operation_id, &self.request_id, sequence, phase, progress, message, terminal, result);
    }
}

pub(crate) fn run_operation(
    sink: &dyn EventSink,
    source_exe: &Path,
    operation_id: &str,
    request_id: &str,
    strategy: &DataStrategy,
    backup: Option<&BackupSelection>,
    plan: plan::Plan,
    control: Arc<OperationControl>,
) -> Result<UninstallResult, UninstallError> {
    let target_ids: Vec<UninstallTargetId> = plan.targets.iter().map(|t| t.id.clone()).collect();
    let scopes: Vec<NormalizedAbsolutePath> = plan.targets.iter().map(|t| t.identity.path.clone()).collect();
    let worker_targets: Vec<WorkerTarget> = plan.targets.iter().map(|target| WorkerTarget {
        path: target.identity.path.as_string(),
        scope: target.identity.scope.clone(),
        fingerprint: target.identity.fingerprint.clone(),
        registered_roots: target.identity.registered_roots.clone(),
    }).collect();
    for target in &worker_targets {
        sink.event(UninstallPhase::Validating, 5, &format!("已确认卸载位置：{}", target.path), false, None);
    }
    let policy = match strategy {
        DataStrategy::Keep => "保留用户数据",
        DataStrategy::Export => "导出并验证备份后移除用户数据",
        DataStrategy::Delete => "移除确认范围内的用户数据",
    };
    sink.event(UninstallPhase::Validating, 5, &format!("数据策略：{policy}"), false, None);

    let lock_paths = scopes.iter().map(|scope| scope.as_path().to_owned())
        .chain(plan.data_roots.iter().map(|root| PathBuf::from(&root.path))).collect::<Vec<_>>();
    let _controller_locks = sidekickai_uninstall_core::lock::PathLocks::acquire(&lock_paths, "controller")?;
    drop(sidekickai_uninstall_core::lock::PathLocks::acquire(&lock_paths, "worker")?);
    if control.is_cancelled() { return Ok(cancelled(request_id, operation_id, target_ids)); }
    if scopes.iter().any(|scope| sidekickai_uninstall_core::path::path_is_same_or_descendant(source_exe, scope.as_path())) {
        return Err(validation(UninstallErrorCode::ProcessRunning, "卸载器必须在所选安装目录之外运行。"));
    }

    let data_roots: Vec<String> = if *strategy == DataStrategy::Keep { Vec::new() } else { plan.data_roots.iter().map(|r| r.path.clone()).collect() };
    let needs_elevation = !execute::is_process_elevated()
        && (worker_targets.iter().any(|t| t.scope == InstallScope::AllUsers || t.registered_roots.iter().any(|root| root == "HKLM"))
            || execute::processes_require_elevation(&scopes)?);
    sink.event(UninstallPhase::Stopping, 10, "正在关闭 SidekickAI", false, None);
    let worker = match execute::WorkerSession::start(source_exe, operation_id, request_id,
        &worker_targets, strategy, &data_roots, needs_elevation, || control.is_cancelled()) {
        Ok(worker) => worker,
        Err(_) if control.is_cancelled() => return Ok(cancelled(request_id, operation_id, target_ids)),
        Err(error) => return Err(error),
    };
    if control.is_cancelled() {
        return Ok(cancelled(request_id, operation_id, target_ids));
    }

    // Export is completed and verified before the worker may delete anything.
    let verified_export = if *strategy == DataStrategy::Export {
        sink.event(UninstallPhase::BackingUp, 30, "正在导出并校验备份", false, None);
        let selection = backup.ok_or_else(|| validation(UninstallErrorCode::BackupPathInvalid, "导出需要备份设置。"))?;
        Some(export_and_verify(&plan, selection, operation_id)?)
    } else { None };
    let backup_result = verified_export.as_ref().map(|export| export.result.clone());

    let backup_path = plan.backup.as_ref().map(|b| b.path.as_string());

    if !control.begin_commit() {
        let mut result = cancelled(request_id, operation_id, target_ids);
        result.backup = backup_result;
        return Ok(result);
    }
    sink.event(UninstallPhase::Commit, 50, "正在移除安装文件", false, None);
    // Reuse the authorized worker after the caller has verified its export.
    let outcome = match worker.commit(
        strategy,
        &data_roots,
        backup_path.as_deref(),
        verified_export.as_ref().map(|export| &export.proof),
    ) {
        Ok(outcome) => outcome,
        Err(error) => return Ok(UninstallResult {
            request_id: request_id.to_string(), operation_id: operation_id.to_string(),
            state: UninstallTerminal::Failed, phase: error.phase.clone(), target_ids,
            removed_install_paths: Vec::new(), removed_data_roots: Vec::new(),
            backup: backup_result, warnings: vec!["WORKER_DID_NOT_CONFIRM_COMPLETION: 请先检查已报告路径再重试。".into()], error: Some(error),
        }),
    };
    if let Some(error) = outcome.error {
        return Ok(UninstallResult {
            request_id: request_id.to_string(), operation_id: operation_id.to_string(),
            state: UninstallTerminal::Failed, phase: error.phase.clone(), target_ids,
            removed_install_paths: outcome.removed_install_paths, removed_data_roots: outcome.removed_data_roots,
            backup: backup_result, warnings: outcome.warnings, error: Some(error),
        });
    }
    for path in &outcome.removed_install_paths {
        sink.event(UninstallPhase::Verifying, 95, &format!("已移除安装文件：{path}"), false, None);
    }
    for path in &outcome.removed_data_roots {
        sink.event(UninstallPhase::Verifying, 95, &format!("已移除用户数据：{path}"), false, None);
    }
    for warning in &outcome.warnings {
        sink.event(UninstallPhase::Verifying, 95, &format!("警告：{warning}"), false, None);
    }
    sink.event(UninstallPhase::Verifying, 95, "正在验证卸载结果", false, None);
    Ok(UninstallResult {
        request_id: request_id.to_string(), operation_id: operation_id.to_string(),
        state: UninstallTerminal::Completed, phase: UninstallPhase::Completed, target_ids,
        removed_install_paths: outcome.removed_install_paths, removed_data_roots: outcome.removed_data_roots,
        backup: backup_result, warnings: outcome.warnings, error: None,
    })
}

pub(crate) fn terminal_status(outcome: &Result<UninstallResult, UninstallError>) -> (UninstallTerminal, UninstallPhase, &'static str) {
    match outcome {
        Ok(result) if result.state == UninstallTerminal::Completed => (UninstallTerminal::Completed, UninstallPhase::Completed, "卸载完成"),
        Ok(result) if result.state == UninstallTerminal::Cancelled => (UninstallTerminal::Cancelled, UninstallPhase::Cancelled, "已取消卸载"),
        Err(error) if error.code == UninstallErrorCode::CancelTooLate => (UninstallTerminal::Failed, UninstallPhase::Failed, "删除已开始，无法取消"),
        _ => (UninstallTerminal::Failed, UninstallPhase::Failed, "卸载失败"),
    }
}

fn cancelled(request_id: &str, operation_id: &str, target_ids: Vec<UninstallTargetId>) -> UninstallResult {
    UninstallResult {
        request_id: request_id.to_string(), operation_id: operation_id.to_string(),
        state: UninstallTerminal::Cancelled, phase: UninstallPhase::Cancelled, target_ids,
        removed_install_paths: Vec::new(), removed_data_roots: Vec::new(), backup: None, warnings: Vec::new(), error: None,
    }
}

fn validation(code: UninstallErrorCode, message: &str) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::BackingUp, false, "")
}

#[allow(dead_code)]
fn _keep_imports(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use sidekickai_uninstall_core::scan::TargetIdentity;
    use sidekickai_uninstall_core::{random_id, validate_backup_selection};
    use std::sync::Mutex;

    #[test]
    fn failed_worker_result_is_never_reported_as_cancelled() {
        let mut failed = cancelled("request", "operation", Vec::new());
        failed.state = UninstallTerminal::Failed;
        failed.phase = UninstallPhase::RemovingRegistry;
        failed.removed_install_paths.push(r"C:\fixture\removed".into());
        let outcome = Ok(failed);
        let (state, phase, message) = terminal_status(&outcome);
        assert_eq!(state, UninstallTerminal::Failed);
        assert_eq!(phase, UninstallPhase::Failed);
        assert_eq!(message, "卸载失败");
        assert_eq!(outcome.unwrap().removed_install_paths.len(), 1);
        let (state, phase, _) = terminal_status(&Ok(cancelled("request", "operation", Vec::new())));
        assert_eq!(state, UninstallTerminal::Cancelled);
        assert_eq!(phase, UninstallPhase::Cancelled);
    }

    #[derive(Default)]
    struct RecordingSink {
        phases: Mutex<Vec<UninstallPhase>>,
        terminal: Mutex<Option<UninstallResult>>,
    }

    impl EventSink for RecordingSink {
        fn event(&self, phase: UninstallPhase, _progress: u8, _message: &str, terminal: bool, result: Option<UninstallResult>) {
            self.phases.lock().unwrap().push(phase);
            if terminal {
                *self.terminal.lock().unwrap() = result;
            }
        }
    }

    impl RecordingSink {
        fn phases(&self) -> Vec<UninstallPhase> {
            self.phases.lock().unwrap().clone()
        }
        fn reached(&self, phase: &UninstallPhase) -> bool {
            self.phases().iter().any(|p| p == phase)
        }
    }

    /// Process checks must bind the exact artifact built for this verification run.
    fn standalone_artifact() -> PathBuf {
        if std::env::var("SIDEKICK_SKIP_PROCESS_E2E").as_deref() == Ok("1") {
            eprintln!("notice: SIDEKICK_SKIP_PROCESS_E2E is set; run_operation tests skipped");
            return PathBuf::new();
        }
        let artifact = PathBuf::from(std::env::var("SIDEKICK_UNINSTALLER_ARTIFACT").expect("set the current SIDEKICK_UNINSTALLER_ARTIFACT"));
        let expected = std::env::var("SIDEKICK_UNINSTALLER_SHA256").expect("set SIDEKICK_UNINSTALLER_SHA256");
        assert!(artifact.is_absolute() && artifact.is_file());
        assert_eq!(execute::sha256_file(&artifact).unwrap(), expected.to_ascii_lowercase());
        artifact
    }

    struct Fixture {
        root: PathBuf,
        install: PathBuf,
        data: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(random_id(&format!("sidekick-op-{name}")).unwrap());
            let install = root.join("SidekickAI");
            let data = root.join("SidekickAI-data");
            fs::create_dir_all(install.join("resources")).unwrap();
            fs::write(install.join("SidekickAI.exe"), b"fixture executable").unwrap();
            fs::write(install.join("resources").join("app.asar"), app_archive(b"fixture asar")).unwrap();
            fs::write(install.join("uninstall.exe"), b"fixture uninstaller").unwrap();
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("settings.db"), b"fixture settings database").unwrap();
            assert!(root.is_absolute() && install.starts_with(&root) && data.starts_with(&root));
            Self { root, install, data }
        }

        fn location(&self, token: &str, arch: UninstallArch) -> UninstallLocation {
            UninstallLocation {
                edition: sidekickai_uninstall_core::product::edition_id().into(),
                id: UninstallTargetId { token: token.into() },
                path: self.install.to_string_lossy().into_owned(),
                display_path: self.install.to_string_lossy().into_owned(),
                source: vec![UninstallEntry::Installed],
                scope: InstallScope::PerUser,
                arch,
                version: Some("0.1.0-alpha".into()),
                registered: false,
                registered_roots: Vec::new(),
                executable_present: true,
                resources_present: true,
                identity_confidence: IdentityConfidence::Strong,
                running_pids: Vec::new(),
                removable: true,
                non_removable_reason: None,
                recommended: true,
            }
        }

        fn plan(&self, data_roots: Vec<DataRoot>, backup: Option<sidekickai_uninstall_core::ValidatedBackupPath>) -> plan::Plan {
            let location = self.location("fixture-token", UninstallArch::X64);
            let identity = TargetIdentity::from_location(&location).unwrap();
            plan::Plan {
                targets: vec![sidekickai_uninstall_core::ScannedTarget { id: location.id, identity }],
                data_roots,
                backup,
            }
        }
    }

    /// Standalone CLI contract, executed against the real built binary: silent
    /// and unknown arguments must be refused with the usage exit code instead of
    /// falling into any deletion path.
    #[test]
    fn standalone_cli_refuses_silent_and_unknown_arguments() {
        use std::process::Command;
        let artifact = standalone_artifact();
        if artifact.as_os_str().is_empty() {
            return;
        }
        for arguments in [
            vec!["--silent"],
            vec!["/S"],
            vec!["--quiet"],
            vec!["--delete"],
            vec!["--keep"],
            vec!["--elevated", "request.json"],
            vec![r"C:\"],
            vec!["--relocated", "bootstrap.json"],
            vec!["--uninstall", "--silent"],
        ] {
            let status = Command::new(&artifact).args(&arguments).status().expect("standalone binary should start");
            assert_eq!(status.code(), Some(64), "arguments {arguments:?} must be refused with EX_USAGE");
        }
    }

    /// `--version` and `--help` are informational and must not perform any work.
    #[test]
    fn standalone_cli_answers_version_and_help() {
        use std::process::Command;
        let artifact = standalone_artifact();
        if artifact.as_os_str().is_empty() {
            return;
        }
        for arguments in [vec!["--version"], vec!["--help"]] {
            let status = Command::new(&artifact).args(&arguments).status().expect("standalone binary should start");
            assert_eq!(status.code(), Some(0), "arguments {arguments:?} must exit 0");
        }
    }

    /// An unauthenticated `--worker` request must be refused before any deletion.
    #[test]
    fn worker_mode_refuses_an_unauthenticated_request() {
        use std::process::Command;
        let artifact = standalone_artifact();
        if artifact.as_os_str().is_empty() {
            return;
        }
        let root = std::env::temp_dir().join(random_id("sidekick-stray-worker").unwrap());
        fs::create_dir_all(&root).unwrap();
        let victim = root.join("SidekickAI");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("SidekickAI.exe"), b"must survive").unwrap();
        let request = root.join("request.json");
        fs::write(&request, format!(
            r#"{{"protocolVersion":1,"operationId":"stray","requestId":"stray","nonce":"00","strategy":"delete","targets":[{{"path":{},"scope":"perUser","fingerprint":{{"exists":true,"isDirectory":true,"len":0,"modified":null,"coreFiles":[]}},"registeredRoot":null}}],"dataRoots":[],"backupPath":null}}"#,
            serde_json::to_string(&victim.to_string_lossy()).unwrap()
        )).unwrap();

        let status = Command::new(&artifact).args(["--worker", &request.to_string_lossy()]).status().expect("standalone binary should start");
        assert_eq!(status.code(), Some(30), "an unauthenticated worker request must be rejected");

        assert!(victim.join("SidekickAI.exe").is_file(), "a rejected worker request must not delete anything");
        assert_eq!(fs::read(victim.join("SidekickAI.exe")).unwrap(), b"must survive");
        let _ = fs::remove_dir_all(&root);
    }

    /// Default strategy: the installation is removed and only then is completion
    /// reported, while user data is never touched.
    #[test]
    fn keep_operation_removes_the_installation_and_preserves_user_data() {
        let source = standalone_artifact();
        if source.as_os_str().is_empty() {
            return;
        }
        let fixture = Fixture::new("keep");
        let sink = RecordingSink::default();

        let result = run_operation(
            &sink, &source, "lib-keep", "lib-keep-request", &DataStrategy::Keep, None,
            fixture.plan(Vec::new(), None), Arc::new(OperationControl::default()),
        )
        .unwrap();

        assert_eq!(result.state, UninstallTerminal::Completed);
        assert_eq!(result.removed_install_paths.len(), 1);
        assert!(result.removed_data_roots.is_empty(), "keep must not touch user data");
        assert!(!fixture.install.exists());
        assert!(fixture.data.join("settings.db").is_file(), "user data must survive keep");
        assert!(sink.reached(&UninstallPhase::Commit), "commit phase should have been reported");
        // The terminal event is emitted by the command layer after this returns;
        // run_operation's last own phase is verification.
        assert_eq!(sink.phases().last(), Some(&UninstallPhase::Verifying));

        let _ = fs::remove_dir_all(&fixture.root);
    }

    /// A successful run must mark the irreversible point, which is what makes a
    /// later cancel request report `tooLate` instead of pretending to work.
    #[test]
    fn successful_operation_marks_the_irreversible_point() {
        let source = standalone_artifact();
        if source.as_os_str().is_empty() {
            return;
        }
        let fixture = Fixture::new("commit-mark");
        let sink = RecordingSink::default();
        let control = Arc::new(OperationControl::default());

        run_operation(
            &sink, &source, "lib-commit", "lib-commit-request", &DataStrategy::Keep, None,
            fixture.plan(Vec::new(), None), control.clone(),
        )
        .unwrap();

        assert!(control.is_committed(), "commit must be recorded as started");
        let _ = fs::remove_dir_all(&fixture.root);
    }

    /// Cancelling before the irreversible point must leave every file in place.
    #[test]
    fn cancel_before_commit_reports_cancelled_and_deletes_nothing() {
        let source = standalone_artifact();
        if source.as_os_str().is_empty() {
            return;
        }
        let fixture = Fixture::new("cancel-safe");
        let sink = RecordingSink::default();
        let control = Arc::new(OperationControl::default());
        assert!(control.request_cancel());

        let result = run_operation(
            &sink, &source, "lib-cancel", "lib-cancel-request", &DataStrategy::Keep, None,
            fixture.plan(Vec::new(), None), control.clone(),
        )
        .unwrap();

        assert_eq!(result.state, UninstallTerminal::Cancelled);
        assert!(result.removed_install_paths.is_empty());
        assert!(fixture.install.join("SidekickAI.exe").is_file(), "a cancelled operation must not delete anything");
        assert!(fixture.data.join("settings.db").is_file());
        assert!(!control.is_committed(), "the irreversible point must not have been reached");
        assert!(!sink.reached(&UninstallPhase::Commit));
        let _ = fs::remove_dir_all(&fixture.root);
    }

    /// Export failure must abort before the commit phase: nothing is deleted and
    /// no backup file is presented as valid.
    #[test]
    fn export_failure_aborts_before_any_deletion() {
        let source = standalone_artifact();
        if source.as_os_str().is_empty() {
            return;
        }
        let fixture = Fixture::new("export-fail");
        // A main executable that rejects the export CLI contract, so the export
        // step fails deterministically. Unknown arguments exit non-zero.
        fs::copy(&source, fixture.install.join("SidekickAI.exe")).unwrap();
        // Refresh the identity so the changed executable is part of the fingerprint.
        let sink = RecordingSink::default();

        let backup_path = fixture.root.join("backup.zip");
        let selection = BackupSelection {
            format: BackupFormat::Zip,
            output_path: backup_path.to_string_lossy().into_owned(),
            encrypt: false,
            password: None,
            categories: vec!["basicData".into()],
        };
        let install_scope = sidekickai_uninstall_core::normalize_target_path(&fixture.install).unwrap();
        let validated = validate_backup_selection(&selection, &[install_scope]).unwrap();
        let data_roots = vec![DataRoot {
            path: fixture.data.to_string_lossy().into_owned(),
            source: "fixture".into(),
            removable: true,
            associated_target_ids: vec![UninstallTargetId { token: "fixture-token".into() }],
        }];

        let failure = run_operation(
            &sink, &source, "lib-export-fail", "lib-export-fail-request", &DataStrategy::Export,
            Some(&selection), fixture.plan(data_roots, Some(validated)), Arc::new(OperationControl::default()),
        )
        .unwrap_err();

        assert_eq!(failure.code, UninstallErrorCode::BackupExportFailed);
        assert!(!sink.reached(&UninstallPhase::Commit), "commit must not be reached when export fails");
        assert!(fixture.install.join("SidekickAI.exe").is_file(), "installation must survive a failed export");
        assert!(fixture.install.join("uninstall.exe").is_file());
        assert_eq!(fs::read(fixture.data.join("settings.db")).unwrap(), b"fixture settings database");
        assert!(!backup_path.exists(), "a failed export must not leave a plausible backup file");

        let _ = fs::remove_dir_all(&fixture.root);
    }
}
