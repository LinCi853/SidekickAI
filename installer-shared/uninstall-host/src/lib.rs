//! Shared uninstall-only Tauri adapter. Neither installer payloads nor launch
//! configuration are dependencies of this crate.

mod backup_export;
mod control;
mod discovery;
pub mod wizard_instance;
pub mod diagnostics;
mod events;
mod execute;
mod plan;

use events::{emit, run_operation, terminal_status, EventSink, TauriSink};

use control::OperationControl;
pub use discovery::data_paths_for;
pub fn installed_locations() -> Result<Vec<UninstallLocation>, UninstallError> {
    discovery::inspect_candidates(discovery::collect_candidates(None)?, None)
}
pub use execute::stop_target_processes;
#[cfg(windows)]
pub use execute::target_processes;

/// Windows identity and private-directory policy shared by both native hosts.
pub fn current_user_sid() -> Result<String, UninstallError> { execute::current_user_sid() }
pub fn process_user_sid(pid: u32) -> Result<String, UninstallError> { execute::process_user_sid(pid) }
pub fn harden_private_directory(directory: &Path) -> Result<(), UninstallError> { execute::harden_operation_directory(directory) }

use sidekickai_uninstall_core::protocol::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, Window};

static ALLOW_CLOSE: AtomicBool = AtomicBool::new(false);

pub fn close_confirmed_window(window: &Window) -> Result<(), tauri::Error> {
    ALLOW_CLOSE.store(true, Ordering::SeqCst);
    window.close().map_err(|error| {
        ALLOW_CLOSE.store(false, Ordering::SeqCst);
        error
    })
}

pub struct Host {
    entry: UninstallEntryMode,
    source: Option<PathBuf>,
    gate: Mutex<()>,
    /// At most one operation may be running in this process.
    active: Mutex<Option<ActiveOperation>>,
    /// requestId -> operationId, so a replayed request returns the original
    /// operation instead of starting a second deletion.
    requests: Mutex<HashMap<String, String>>,
}

/// IPC and the operation thread share one atomic cancellation/commit decision.
pub(crate) struct ActiveOperation {
    operation_id: String,
    control: Arc<OperationControl>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    /// A new operation was admitted for this request.
    Accepted(String),
    /// The same request was already accepted; the original operation is returned.
    Replay(String),
    /// Another operation is still running.
    AlreadyRunning,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CancelDecision {
    NotFound,
    TooLate,
    Requested,
}

/// Single admission point: enforces one running operation and request-level
/// idempotency. Split out so the concurrency contract is directly testable.
pub(crate) fn admit(
    active: &mut Option<ActiveOperation>,
    requests: &mut HashMap<String, String>,
    request_id: &str,
    new_operation_id: &str,
    control: Arc<OperationControl>,
) -> Admission {
    if let Some(existing) = requests.get(request_id) {
        return Admission::Replay(existing.clone());
    }
    if active.is_some() {
        return Admission::AlreadyRunning;
    }
    requests.insert(request_id.to_string(), new_operation_id.to_string());
    *active = Some(ActiveOperation {
        operation_id: new_operation_id.to_string(),
        control,
    });
    Admission::Accepted(new_operation_id.to_string())
}

/// Single place that decides what a cancel request means, so "too late" is tied
/// to the irreversible point instead of to a repeated click.
pub(crate) fn decide_cancel(active: &Mutex<Option<ActiveOperation>>, operation_id: &str) -> CancelDecision {
    let Ok(active) = active.lock() else {
        return CancelDecision::NotFound;
    };
    match active.as_ref() {
        Some(state) if state.operation_id != operation_id => CancelDecision::NotFound,
        None => CancelDecision::NotFound,
        Some(state) if state.control.request_cancel() => CancelDecision::Requested,
        Some(_) => CancelDecision::TooLate,
    }
}

impl Host {
    pub fn is_running(&self) -> bool {
        self.active.lock().map(|active| active.is_some()).unwrap_or(true)
    }

    pub fn standalone() -> Self {
        Self {
            entry: UninstallEntryMode::Standalone,
            source: std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_owned())),
            gate: Mutex::new(()),
            active: Mutex::new(None),
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// Standalone run from the relocated copy: the launcher's original directory
    /// is the installation the user actually started, so that is what gets
    /// recommended instead of the temporary operation root.
    pub fn standalone_relocated(origin: PathBuf) -> Self {
        Self { entry: UninstallEntryMode::Standalone, source: Some(origin), ..Self::standalone() }
    }

    pub fn installer() -> Self {
        Self {
            entry: UninstallEntryMode::Installer,
            source: None,
            gate: Mutex::new(()),
            active: Mutex::new(None),
            requests: Mutex::new(HashMap::new()),
        }
    }
}

/// Scan registration is process-global (a new scan invalidates older tokens), so
/// tests that register a scan must not overlap. Production relies on the same
/// single-active-scan rule.
#[cfg(test)]
pub(crate) static SCAN_TEST_LOCK: Mutex<()> = Mutex::new(());

fn busy() -> UninstallError {
    UninstallError::new(UninstallErrorCode::AlreadyRunning, "另一个卸载操作正在进行。", UninstallPhase::Validating, true, "")
}

pub fn prevent_close_while_running(window: &Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if !ALLOW_CLOSE.load(Ordering::SeqCst) || window.try_state::<Host>().is_some_and(|host| host.active.lock().map(|active| active.is_some()).unwrap_or(true)) {
            api.prevent_close();
            let _ = window.emit("installer-close-requested", ());
        }
    }
}
pub mod commands {
use super::*;

#[tauri::command]
pub fn uninstall_get_info(host: State<'_, Host>) -> Result<UninstallInfo, UninstallError> {
    Ok(info_for(&host.entry))
}

/// Reported capabilities. Split from Tauri so the wire contract is testable.
pub(crate) fn info_for(entry: &UninstallEntryMode) -> UninstallInfo {
    UninstallInfo {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        uninstaller_version: env!("CARGO_PKG_VERSION").into(),
        host_arch: if cfg!(target_arch = "aarch64") { UninstallArch::Arm64 } else { UninstallArch::X64 },
        entry: entry.clone(),
        supports_elevation: cfg!(windows),
        supports_backup: true,
        // No silent uninstall exists, so this is a fixed capability, not a flag.
        supports_silent: false,
    }
}

#[tauri::command]
pub async fn uninstall_scan(host: State<'_, Host>, request: Option<UninstallScanRequest>) -> Result<UninstallScanResponse, UninstallError> {
    let _ = request;
    let source = host.source.clone();
    tauri::async_runtime::spawn_blocking(move || discovery::discover(source.as_deref()))
        .await.map_err(|e| UninstallError::invalid_request(e.to_string()))?
}

#[tauri::command]
pub fn uninstall_start(app: AppHandle, host: State<'_, Host>, request: UninstallRequest) -> Result<UninstallAccepted, UninstallError> {
    // Serialize validation and admission of one operation.
    let guard = host.gate.try_lock().map_err(|_| busy())?;
    let request_id = request.request_id.clone();
    let operation_id = sidekickai_uninstall_core::random_id("operation")?;
    let control = Arc::new(OperationControl::default());

    // Replayed requests short-circuit *before* validation: the operation already
    // exists, so the caller must receive its original identity, not a new plan.
    if let Some(existing) = host.requests.lock().map_err(|_| busy())?.get(&request_id).cloned() {
        drop(guard);
        return Ok(UninstallAccepted::new(request_id, existing));
    }
    let plan = plan::prepare(&request)?;
    let admitted = {
        let mut active = host.active.lock().map_err(|_| busy())?;
        let mut requests = host.requests.lock().map_err(|_| busy())?;
        admit(&mut active, &mut requests, &request_id, &operation_id, control.clone())
    };
    let operation_id = match admitted {
        Admission::Accepted(id) => id,
        Admission::Replay(existing) => {
            drop(guard);
            return Ok(UninstallAccepted::new(request_id, existing));
        }
        Admission::AlreadyRunning => return Err(busy()),
    };
    drop(guard);

    let strategy = request.strategy.clone();
    let backup_selection = request.backup.clone();
    let accepted = UninstallAccepted::new(request_id.clone(), operation_id.clone());
    let app_handle = app.clone();
    let worker_app = app.clone();

    emit(&app, &operation_id, &request_id, 1, UninstallPhase::Accepted, 0, "卸载请求已接受", false, None);

    let finish_operation = {
        let operation_id = operation_id.clone();
        move |app: &AppHandle| {
            if let Ok(mut active) = app.state::<Host>().active.lock() {
                if active.as_ref().is_some_and(|state| state.operation_id == operation_id) {
                    *active = None;
                }
            }
        }
    };

    std::thread::spawn(move || {
        let sink = TauriSink { app: worker_app, operation_id: operation_id.clone(), request_id: request_id.clone(), sequence: AtomicU64::new(1) };
        let source = match std::env::current_exe() {
            Ok(source) => source,
            Err(error) => {
                let failure = UninstallError::new(UninstallErrorCode::Internal, format!("无法定位卸载器可执行文件：{error}"), UninstallPhase::Failed, true, &operation_id);
                finish_operation(&app_handle);
                sink.event(UninstallPhase::Failed, 0, "卸载失败", true, Some(UninstallResult {
                    request_id: request_id.clone(), operation_id: operation_id.clone(),
                    state: UninstallTerminal::Failed, phase: UninstallPhase::Failed, target_ids: Vec::new(),
                    removed_install_paths: Vec::new(), removed_data_roots: Vec::new(), backup: None, warnings: Vec::new(), error: Some(failure),
                }));
                return;
            }
        };
        let outcome = run_operation(&sink, &source, &operation_id, &request_id, &strategy, backup_selection.as_ref(), plan, control.clone());
        let (state, phase, message) = terminal_status(&outcome);
        let mut result = outcome.unwrap_or_else(|error| UninstallResult {
            request_id: request_id.clone(), operation_id: operation_id.clone(), state, phase: phase.clone(),
            target_ids: Vec::new(), removed_install_paths: Vec::new(), removed_data_roots: Vec::new(),
            backup: None, warnings: Vec::new(), error: Some(error),
        });
        // Terminal envelope and result must agree; the precise failing stage is
        // preserved in result.error.phase for diagnostics.
        result.phase = phase.clone();
        finish_operation(&app_handle);
        sink.event(phase, if result.state == UninstallTerminal::Completed { 100 } else { 0 }, message, true, Some(result));
    });
    Ok(accepted)
}

#[tauri::command]
pub fn uninstall_cancel(host: State<'_, Host>, operation_id: String) -> Result<CancelResponse, UninstallError> {
    let (accepted, state) = match decide_cancel(&host.active, &operation_id) {
        CancelDecision::NotFound => (false, CancelState::NotFound),
        CancelDecision::TooLate => (false, CancelState::TooLate),
        CancelDecision::Requested => (true, CancelState::CancelRequested),
    };
    Ok(CancelResponse { operation_id, accepted, state })
}

#[tauri::command]
pub fn uninstall_close(window: Window) -> Result<(), UninstallError> {
    if window.state::<Host>().active.lock().map_err(|_| busy())?.is_some() { return Err(busy()); }
    close_confirmed_window(&window).map_err(|e| UninstallError::new(UninstallErrorCode::Internal, e.to_string(), UninstallPhase::Failed, true, ""))
}

#[tauri::command]
pub async fn uninstall_choose_backup_path(app: AppHandle, format: BackupFormat, suggested_name: String) -> Result<String, UninstallError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let extension = if format == BackupFormat::Zip { "zip" } else { "sabackup" };
        app.dialog().file().add_filter("SidekickAI 备份", &[extension])
            .set_file_name(&suggested_name).blocking_save_file()
            .map(|p| p.into_path().map(|p| p.to_string_lossy().into_owned()).map_err(|e| UninstallError::invalid_request(e.to_string())))
            .unwrap_or_else(|| Ok(String::new()))
    }).await.map_err(|e| UninstallError::invalid_request(e.to_string()))?
}
}

/// Worker entry point re-exported for the standalone binary.
pub fn run_worker(request_path: &str) -> i32 {
    execute::run_worker(request_path)
}

/// Prepare the UI relocation: copy this executable into the private operation
/// root and produce the argument string that starts the copy. The Tauri app
/// itself is built by each binary crate, because `generate_context!` reads that
/// binary's own configuration.
pub fn prepare_ui_relocation() -> Result<(PathBuf, String), UninstallError> {
    let (relocated, bootstrap, _nonce) = execute::relocate_ui()?;
    Ok((relocated.clone(), format!("--relocated \"{}\"", bootstrap.display())))
}

/// Read and validate a `--relocated` bootstrap, returning the directory the user
/// originally launched from.
pub fn read_relocation_origin(bootstrap: &Path) -> Result<PathBuf, UninstallError> {
    execute::read_relocation_bootstrap(bootstrap)
}

/// Start the relocated UI copy and let this process exit.
pub fn start_relocated_ui(relocated: &Path, arguments: &str) -> Result<(), UninstallError> {
    execute::spawn_detached(relocated, arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tooLate` must be tied to the irreversible point, and a repeated cancel
    /// while the operation is still cancellable stays idempotent.
    #[test]
    fn cancel_decision_is_idempotent_then_too_late_after_commit() {
        let active: Mutex<Option<ActiveOperation>> = Mutex::new(None);
        assert_eq!(decide_cancel(&active, "missing"), CancelDecision::NotFound);

        let control = Arc::new(OperationControl::default());
        *active.lock().unwrap() = Some(ActiveOperation {
            operation_id: "op".to_string(),
            control: control.clone(),
        });
        assert_eq!(decide_cancel(&active, "op"), CancelDecision::Requested);
        assert!(control.is_cancelled());
        // Clicking cancel twice must not be reported as "too late".
        assert_eq!(decide_cancel(&active, "op"), CancelDecision::Requested);
        // A cancel for a different operation must not touch this one.
        assert_eq!(decide_cancel(&active, "other"), CancelDecision::NotFound);

        assert!(!control.begin_commit(), "accepted cancellation cannot later commit");
        let committed = Arc::new(OperationControl::default());
        assert!(committed.begin_commit());
        *active.lock().unwrap() = Some(ActiveOperation { operation_id: "next".into(), control: committed });
        assert_eq!(decide_cancel(&active, "next"), CancelDecision::TooLate);
    }

    /// One running operation per process, plus request-level idempotency: a
    /// replayed request must return the original operation instead of starting a
    /// second deletion.
    #[test]
    fn admission_allows_one_operation_and_replays_the_same_request() {
        let mut active: Option<ActiveOperation> = None;
        let mut requests: HashMap<String, String> = HashMap::new();
        let flags = || Arc::new(OperationControl::default());

        let control = flags();
        assert_eq!(
            admit(&mut active, &mut requests, "request-a", "op-1", control),
            Admission::Accepted("op-1".into())
        );
        assert!(active.is_some());

        // Replaying the same request returns the original operation id.
        let control = flags();
        assert_eq!(
            admit(&mut active, &mut requests, "request-a", "op-2", control),
            Admission::Replay("op-1".into())
        );
        assert_eq!(active.as_ref().unwrap().operation_id, "op-1", "a replay must not replace the running operation");

        // A different request while one is running is refused.
        let control = flags();
        assert_eq!(
            admit(&mut active, &mut requests, "request-b", "op-3", control),
            Admission::AlreadyRunning
        );
        assert_eq!(requests.len(), 1, "a refused request must not be recorded");

        // After the operation finishes a new request is admitted...
        active = None;
        let control = flags();
        assert_eq!(
            admit(&mut active, &mut requests, "request-b", "op-4", control),
            Admission::Accepted("op-4".into())
        );
        // ...while the old request still replays its own operation.
        let control = flags();
        assert_eq!(
            admit(&mut active, &mut requests, "request-a", "op-5", control),
            Admission::Replay("op-1".into())
        );
    }

    /// Capabilities reported on the wire: fixed values, no silent uninstall.
    #[test]
    fn info_reports_fixed_capabilities_and_the_entry_mode() {
        let standalone = crate::commands::info_for(&UninstallEntryMode::Standalone);
        assert_eq!(standalone.protocol_version, 1);
        assert_eq!(standalone.entry, UninstallEntryMode::Standalone);
        assert!(!standalone.supports_silent, "silent uninstall is not implemented");
        assert!(standalone.supports_backup);
        assert!(!standalone.uninstaller_version.is_empty());

        let installer = crate::commands::info_for(&UninstallEntryMode::Installer);
        assert_eq!(installer.entry, UninstallEntryMode::Installer);
        assert_eq!(installer.protocol_version, standalone.protocol_version);
    }
}
