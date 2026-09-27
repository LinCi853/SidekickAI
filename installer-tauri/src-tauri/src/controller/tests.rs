#[cfg(test)]
use super::*;
use super::directory::{
    current_user_sid, harden_private_directory, operation_root, validate_operation_directory_name,
    PreparedOperation,
};
use super::envelope::{
    load_request, validate_request_location, verify_request, OperationRequest, OperationResult,
};
use super::state::operation_cancelled;
use crate::manifest::InstallRequest;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use sidekickai_uninstall_core::path::paths_equal;
use std::sync::Mutex;

/// Admission and cancellation share process-wide atomics, so the tests that
/// exercise them run one at a time instead of racing each other.
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

fn lifecycle_guard() -> std::sync::MutexGuard<'static, ()> {
    LIFECYCLE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn request(install_dir: &Path) -> InstallRequest {
    InstallRequest {
        installation_id: crate::manifest::new_installation_id(),
        resources: Vec::new(),
        action: String::new(),
        install_dir: install_dir.to_string_lossy().into_owned(),
        for_all_users: false,
        create_desktop_shortcut: false,
        launch_after_install: false,
        show_guide_after_install: false,
        features: serde_json::Map::new(),
        options: serde_json::Map::new(),
        mode: crate::manifest::InstallMode::Install,
        cleanup_paths: Vec::new(),
        delete_user_data: false,
        data_strategy: String::new(),
        backup_path: String::new(),
        backup_password: String::new(),
        backup_encrypt: true,
        backup_categories: Vec::new(),
        accepted_licenses: Vec::new(),
        cloud_enabled: false,
        cloud_assets: Vec::new(),
    }
}

fn fixture(kind: &str) -> PreparedOperation {
    prepare_operation(kind, ACTION_INSTALL, &request(&std::env::temp_dir())).unwrap()
}

fn envelope_for(operation_id: &str, nonce: &str) -> OperationRequest {
    OperationRequest {
        protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: operation_id.to_string(),
        nonce: nonce.to_string(),
        action: ACTION_INSTALL.to_string(),
        controller_pid: std::process::id(),
        caller_user_sid: current_user_sid().unwrap_or_default(),
        source_sha256: "0".repeat(SHA256_HEX_LEN),
        request: request(&std::env::temp_dir()),
    }
}

#[test]
fn admission_is_exclusive_and_released_on_drop() {
    let _guard = lifecycle_guard();
    let first = Admission::acquire().expect("first admission");
    assert!(Admission::acquire().is_none(), "a second operation must be refused");
    drop(first);
    assert!(Admission::acquire().is_some(), "admission must be reusable after drop");
}

/// Regression: `finish()` followed by `Drop` must not clobber a newer
/// admission. The old unconditional `RUNNING.store(false)` released the
/// second operation when the first guard finally dropped.
#[test]
fn a_late_release_never_clears_a_newer_admission() {
    let _guard = lifecycle_guard();
    let first = Admission::acquire().expect("first admission");
    first.finish();
    let second = Admission::acquire().expect("second admission must win after finish");
    drop(first);
    assert!(
        RUNNING.load(Ordering::SeqCst),
        "a stale guard must not release the newer operation"
    );
    assert_eq!(generation(), second.generation());
    second.finish();
    assert!(!RUNNING.load(Ordering::SeqCst), "the owner releases admission");
}

/// Exactly one of a cancel and an engine start may win before the engine is
/// entered; a cancellation can never be reported after the engine started.
#[test]
fn cancel_and_engine_start_have_exactly_one_winner() {
    let _guard = lifecycle_guard();
    use std::sync::{Arc, Barrier};
    for _ in 0..64 {
        let admission = Admission::acquire().expect("admission");
        let barrier = Arc::new(Barrier::new(2));
        let cancel_barrier = Arc::clone(&barrier);
        let cancel = std::thread::spawn(move || {
            cancel_barrier.wait();
            cancel_operation()
        });
        let begin_barrier = Arc::clone(&barrier);
        let begin = std::thread::spawn(move || {
            begin_barrier.wait();
            begin_engine()
        });
        let cancelled = cancel.join().unwrap();
        let started = begin.join().unwrap();
        assert_ne!(cancelled, started, "exactly one of cancel/begin may win");
        assert!(cancelled || started, "one of cancel/begin must win");
        admission.finish();
    }
    assert!(!RUNNING.load(Ordering::SeqCst));
}

#[test]
fn cancellation_is_refused_once_the_engine_started() {
    let _guard = lifecycle_guard();
    let admission = Admission::acquire().expect("admission");
    assert!(begin_engine(), "the engine enters from the admitted state");
    assert!(!cancel_operation(), "a running engine cannot be cancelled");
    assert!(!begin_engine(), "the engine can only be entered once");
    admission.finish();

    let admission = Admission::acquire().expect("admission");
    assert!(cancel_operation(), "a pre-engine cancel must win");
    assert!(!begin_engine(), "a cancelled operation must not enter the engine");
    assert!(operation_cancelled());
    admission.finish();
}

/// After a released operation there is nothing to cancel or start, so a
/// late click cannot "accept" a cancellation for an operation that is gone.
#[test]
fn cancel_after_release_is_refused() {
    let _guard = lifecycle_guard();
    let admission = Admission::acquire().expect("admission");
    admission.finish();
    assert!(!cancel_operation(), "no admitted operation to cancel");
    assert!(!begin_engine(), "the engine needs an admitted operation");
}

#[test]
fn concurrent_admission_never_admits_two_operations() {
    let _guard = lifecycle_guard();
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Barrier};
    let concurrent = Arc::new(AtomicUsize::new(0));
    let max_seen = Arc::new(AtomicUsize::new(0));
    let admitted = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let concurrent = Arc::clone(&concurrent);
        let max_seen = Arc::clone(&max_seen);
        let admitted = Arc::clone(&admitted);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..64 {
                if let Some(admission) = Admission::acquire() {
                    admitted.fetch_add(1, Ordering::SeqCst);
                    let active = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(active, Ordering::SeqCst);
                    assert_eq!(active, 1, "two operations were admitted at the same time");
                    std::thread::yield_now();
                    concurrent.fetch_sub(1, Ordering::SeqCst);
                    drop(admission);
                }
                std::thread::yield_now();
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    assert!(admitted.load(Ordering::SeqCst) > 0, "at least one thread must win");
    assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    assert!(!RUNNING.load(Ordering::SeqCst), "admission must be clear after the race");
}

#[test]
fn operation_directories_are_unique_and_removed_on_drop() {
    let first = fixture("install-op");
    let second = fixture("install-op");
    assert_ne!(first.request_path, second.request_path);
    assert!(first.request_path.is_file());
    let directory = first.request_path.parent().unwrap().to_path_buf();
    assert!(directory.parent().is_some_and(|p| paths_equal(p, &operation_root())));
    let name = directory.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(name, format!("{}-{}", first.operation_id, first.nonce));
    drop(first);
    assert!(!directory.exists(), "the private directory must be cleaned up");
}

#[test]
fn request_location_rejects_a_shared_or_misnamed_file() {
    let stray = operation_root().join("SidekickAI-install-request.json");
    fs::create_dir_all(&stray.parent().unwrap()).unwrap();
    fs::write(&stray, b"{}").unwrap();
    assert!(validate_request_location(&stray).is_err());
    let _ = fs::remove_file(&stray);
}

/// A private directory is accepted even when it is not under the child's own
/// re-derived temp root: the controller's root and the elevated child's
/// environment can differ under same-account UAC.
#[cfg(windows)]
#[test]
fn request_location_accepts_a_private_directory_outside_the_default_root() {
    let root = std::env::temp_dir().join(format!("sidekick-custom-root-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let nonce = "c".repeat(NONCE_HEX_LEN);
    let operation_id = "custom-op";
    let directory = root.join(format!("{operation_id}-{nonce}"));
    fs::create_dir_all(&directory).unwrap();
    harden_private_directory(&directory).unwrap();
    let path = directory.join(REQUEST_FILE);
    fs::write(&path, serde_json::to_vec(&envelope_for(operation_id, &nonce)).unwrap()).unwrap();

    let loaded = load_request(&path).expect("a structurally valid private request must load");
    assert_eq!(loaded.operation_id, operation_id);
    let _ = fs::remove_dir_all(&root);
}

/// A folder that merely holds a `request.json` is not an operation
/// directory: without the protected private ACL the child must not write a
/// result there.
#[cfg(windows)]
#[test]
fn request_location_rejects_a_directory_without_the_private_acl() {
    let nonce = "d".repeat(NONCE_HEX_LEN);
    let operation_id = "sidekick-controller";
    let directory = std::env::temp_dir().join(format!("{operation_id}-{nonce}"));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(REQUEST_FILE);
    fs::write(&path, serde_json::to_vec(&envelope_for(operation_id, &nonce)).unwrap()).unwrap();

    let error = validate_request_location(&path).unwrap_err();
    assert!(
        error.contains("私有") || error.contains("ACL") || error.contains("所有者"),
        "an unhardened directory must be rejected: {error}"
    );
    assert!(!directory.join(RESULT_FILE).exists());
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn operation_directory_name_must_match_the_recorded_identity() {
    let prepared = fixture("install-op");
    let directory = prepared.request_path.parent().unwrap();
    assert!(validate_operation_directory_name(directory, &prepared.operation_id, &prepared.nonce).is_ok());
    assert!(validate_operation_directory_name(directory, "other-operation", &prepared.nonce).is_err());
    assert!(validate_operation_directory_name(directory, &prepared.operation_id, "00").is_err());
}

#[test]
fn verify_request_accepts_the_prepared_identity() {
    let prepared = fixture("install-op");
    let worker = std::env::current_exe().unwrap();
    let envelope = load_request(&prepared.request_path).unwrap();
    assert!(verify_request(&envelope, &worker).is_ok());
}

#[test]
fn verify_request_rejects_a_foreign_user_sid() {
    let prepared = fixture("install-op");
    let worker = std::env::current_exe().unwrap();
    let raw = fs::read(&prepared.request_path).unwrap();
    let mut envelope: OperationRequest = serde_json::from_slice(&raw).unwrap();
    envelope.caller_user_sid = "S-1-5-21-0000000000-0000000000-0000000000-5000".into();
    let bytes = serde_json::to_vec(&envelope).unwrap();
    sidekickai_uninstall_core::write_private_file(&prepared.request_path, &bytes).unwrap();
    let error = verify_request(&envelope, &worker).unwrap_err();
    assert!(error.contains("不同用户账户") || error.contains("发起进程"), "{error}");
}

#[test]
fn verify_request_rejects_a_controller_pid_of_zero() {
    let prepared = fixture("install-op");
    let worker = std::env::current_exe().unwrap();
    let raw = fs::read(&prepared.request_path).unwrap();
    let mut envelope: OperationRequest = serde_json::from_slice(&raw).unwrap();
    envelope.controller_pid = 0;
    let bytes = serde_json::to_vec(&envelope).unwrap();
    sidekickai_uninstall_core::write_private_file(&prepared.request_path, &bytes).unwrap();
    assert!(verify_request(&envelope, &worker).is_err());
}

#[test]
fn verify_request_rejects_a_foreign_source_image() {
    let prepared = fixture("install-op");
    let worker = std::env::current_exe().unwrap();
    let raw = fs::read(&prepared.request_path).unwrap();
    let mut envelope: OperationRequest = serde_json::from_slice(&raw).unwrap();
    envelope.source_sha256 = "0".repeat(SHA256_HEX_LEN);
    let bytes = serde_json::to_vec(&envelope).unwrap();
    sidekickai_uninstall_core::write_private_file(&prepared.request_path, &bytes).unwrap();
    let error = verify_request(&envelope, &worker).unwrap_err();
    assert!(error.contains("镜像不一致"), "{error}");
}

#[test]
fn identity_refusal_writes_a_structured_failure_without_running_the_engine() {
    let prepared = fixture("install-op");
    let raw = fs::read(&prepared.request_path).unwrap();
    let mut envelope: OperationRequest = serde_json::from_slice(&raw).unwrap();
    envelope.caller_user_sid = "S-1-5-21-0000000000-0000000000-0000000000-5000".into();
    let bytes = serde_json::to_vec(&envelope).unwrap();
    sidekickai_uninstall_core::write_private_file(&prepared.request_path, &bytes).unwrap();

    let code = run_elevated_operation(&prepared.request_path.to_string_lossy());
    assert_eq!(code, 1);
    let result: OperationResult =
        serde_json::from_slice(&fs::read(&prepared.result_path).unwrap()).unwrap();
    assert!(!result.ok);
    assert_eq!(result.operation_id, prepared.operation_id);
    assert_eq!(result.nonce, prepared.nonce);
    assert!(result.error.is_some());
}

#[test]
fn an_untrusted_request_location_writes_no_result() {
    let prepared = fixture("install-op");
    sidekickai_uninstall_core::write_private_file(&prepared.request_path, b"not json").unwrap();
    let code = run_elevated_operation(&prepared.request_path.to_string_lossy());
    assert_eq!(code, 1);
    assert!(!prepared.result_path.is_file(), "an untrusted request must not produce a result");
}

#[test]
fn child_result_missing_is_reported_as_a_failure() {
    assert!(interpret_child_result(None, 0, "op", "00").is_err());
    assert!(interpret_child_result(None, 1, "op", "00").is_err());
    assert!(interpret_child_result(None, 1223, "op", "00")
        .unwrap_err()
        .contains("未授予管理员权限"));
}

#[test]
fn child_result_is_bound_to_the_operation() {
    let good = r#"{"protocolVersion":1,"operationId":"op","nonce":"00","ok":true}"#;
    assert!(interpret_child_result(Some(good), 0, "op", "00").is_ok());
    // A success result that does not belong to this operation must not pass.
    assert!(interpret_child_result(Some(good), 0, "other", "00").is_err());
    assert!(interpret_child_result(Some(good), 0, "op", "ff").is_err());
    // A claimed success with a nonzero exit code is still a failure.
    assert!(interpret_child_result(Some(good), 1, "op", "00").is_err());
}

#[test]
fn explicit_child_error_is_propagated() {
    let failed = r#"{"protocolVersion":1,"operationId":"op","nonce":"00","ok":false,"error":"磁盘空间不足"}"#;
    assert_eq!(
        interpret_child_result(Some(failed), 1, "op", "00").unwrap_err(),
        "磁盘空间不足"
    );
}

#[test]
fn malformed_child_result_is_a_failure() {
    assert!(interpret_child_result(Some("not json"), 1, "op", "00")
        .unwrap_err()
        .contains("读取安装结果失败"));
}

#[test]
fn operation_log_context_is_thread_local() {
    assert!(bound_log_path().is_none());
    let path = PathBuf::from("install.log");
    with_operation_context(path.clone(), || {
        assert_eq!(bound_log_path(), Some(path.clone()));
    });
    assert!(bound_log_path().is_none());
}
