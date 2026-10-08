//! Unit and fixture tests for the worker protocol.

mod deletion;
mod process;
mod registry;
mod relocation;
mod validation;

/// A process that has certainly exited, used by tests to exercise dead-owner
/// liveness without guessing at a reserved PID.
pub(super) fn spawn_and_reap_process() -> u32 {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit", "0"])
        .spawn()
        .expect("cmd.exe should start");
    let pid = child.id();
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(150));
    pid
}

/// The current caller identity that a well-formed worker request must carry.
pub(super) fn caller_identity() -> String {
    current_user_sid().expect("the test process must have a user SID")
}

/// A minimal well-formed request for the isolated deletion tests.
pub(super) fn fixture_request(
    operation_id: &str,
    strategy: DataStrategy,
    targets: Vec<WorkerTarget>,
    data_roots: Vec<WorkerDataRoot>,
    backup_path: Option<String>,
) -> WorkerRequest {
    let target_identities = fixture_target_identities(&targets);
    WorkerRequest {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        operation_id: operation_id.to_string(),
        request_id: format!("{operation_id}-request"),
        nonce: "00112233445566778899aabbccddeeff".to_string(),
        controller_pid: std::process::id(),
        caller_user_sid: caller_identity(),
        // Fixture tests copy the current test executable to `worker.exe`, so
        // the request must bind exactly that hash.
        worker_sha256: sha256_file(&std::env::current_exe().unwrap()).unwrap(),
        strategy,
        targets,
        target_identities,
        data_roots,
        backup_path,
        backup_sha256: None, backup_proofs: Vec::new(), resume_task_id: None,
        preparation: None,
    }
}

/// The controller-captured directory identity for each fixture target. A
/// path that does not exist (only used by purely syntactic tests) gets a
/// placeholder identity; the deletion path re-checks it.
pub(super) fn fixture_target_identities(targets: &[WorkerTarget]) -> Vec<TargetDirectoryProof> {
    targets
        .iter()
        .map(|target| TargetDirectoryProof {
            path: target.path.clone(),
            directory: DirectoryIdentity::from_path(Path::new(&target.path)).unwrap_or(DirectoryIdentity {
                volume_serial: 0,
                file_index_high: 0,
                file_index_low: 0,
            }),
        })
        .collect()
}

/// A strong data-root identity for a fixture directory.
pub(super) fn fixture_data_root(path: &Path) -> WorkerDataRoot {
    WorkerDataRoot {
        path: path.to_string_lossy().into_owned(),
        fingerprint: FileFingerprint::from_path(path).unwrap(),
        identity: DataRootIdentity::capture(path).unwrap(),
        verified_source_hashes: BTreeMap::new(),
        verified_tree_sha256: None,
    }
}

/// A `WorkerDataRoot` with a verified backup inventory: the tree identity is
/// still captured from the live directory, every listed source file must hash
/// to the value the strict receipt recorded, and the complete exporter-time
/// tree digest binds every unselected entry too.
pub(super) fn fixture_verified_data_root(path: &Path, entries: &[(String, String)]) -> WorkerDataRoot {
    WorkerDataRoot {
        path: path.to_string_lossy().into_owned(),
        fingerprint: FileFingerprint::from_path(path).unwrap(),
        identity: DataRootIdentity::capture(path).unwrap(),
        verified_source_hashes: entries.iter().cloned().collect(),
        verified_tree_sha256: Some(export_tree_digest(path).unwrap()),
    }
}

pub(super) fn write_fixture_request(directory: &Path, request: &WorkerRequest) -> PathBuf {
    let request_path = directory.join("request.json");
    write_atomic(&request_path, &serde_json::to_vec(request).unwrap()).unwrap();
    request_path
}

/// The worker source used by the process-boundary tests must be an explicit,
/// hash-verified artifact. An absent artifact is a hard failure unless the
/// caller opted out with `SIDEKICK_SKIP_PROCESS_E2E=1`.
pub(super) fn standalone_artifact() -> Option<PathBuf> {
    if std::env::var("SIDEKICK_SKIP_PROCESS_E2E").map(|value| value == "1").unwrap_or(false) {
        eprintln!("notice: SIDEKICK_SKIP_PROCESS_E2E=1; process boundary tests skipped");
        return None;
    }
    let artifact = std::env::var_os("SIDEKICK_UNINSTALLER_ARTIFACT")
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("set SIDEKICK_UNINSTALLER_ARTIFACT and SIDEKICK_UNINSTALLER_SHA256 to run the process tests, or SIDEKICK_SKIP_PROCESS_E2E=1 to skip them explicitly"));
    let expected = std::env::var("SIDEKICK_UNINSTALLER_SHA256")
        .unwrap_or_else(|_| panic!("SIDEKICK_UNINSTALLER_SHA256 is required together with SIDEKICK_UNINSTALLER_ARTIFACT"));
    assert!(artifact.is_file(), "SIDEKICK_UNINSTALLER_ARTIFACT is not a file: {}", artifact.display());
    let actual = sha256_file(&artifact).expect("the artifact must be hashable");
    assert!(
        actual.eq_ignore_ascii_case(expected.trim()),
        "artifact hash mismatch for {}: expected {}, actual {}",
        artifact.display(),
        expected.trim(),
        actual
    );
    Some(artifact)
}

/// Removes the dedicated fixture key even if an assertion panics, so a test
/// never leaves an entry in the real per-user uninstall list.
#[cfg(windows)]
pub(super) struct FixtureRegistration(pub(super) String);

#[cfg(windows)]
impl Drop for FixtureRegistration {
    fn drop(&mut self) {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
            self.0
        ));
    }
}

// Shared prelude for every suite: protocol types, std helpers, and the
// worker-internal items the original single-file tests reached via `super::*`.
pub(super) use super::super::hashing::{sha256_file, write_atomic};
pub(super) use super::super::identity::{current_user_sid, DataRootIdentity, DirectoryIdentity};
pub(super) use super::super::pinned::{pin_external_ancestors, remove_tree_pinned};
pub(super) use super::super::tree::export_tree_digest;
pub(super) use super::super::REQUEST_NONCE_LEN;
pub(super) use sidekickai_uninstall_core::lock::PathLocks;
pub(super) use sidekickai_uninstall_core::path::{
    path_is_same_or_descendant, paths_equal,
};
pub(super) use sidekickai_uninstall_core::protocol::*;
pub(super) use sidekickai_uninstall_core::scan::FileFingerprint;
pub(super) use std::collections::BTreeMap;
pub(super) use std::fs;
pub(super) use std::path::{Path, PathBuf};
pub(super) use std::sync::atomic::AtomicBool;
pub(super) use std::sync::Arc;
pub(super) use std::time::{Duration, Instant};

// Internal helpers exercised directly by the suites.
pub(super) use super::deletion::execute_worker_with;
pub(super) use super::validate::{
    protected_scope_reason_for, validate_request_location_for, validate_worker_request,
};
pub(super) use super::prepare::{
    cleanup_directory, create_operation_dir, operation_root, prepare_worker_from,
    prepare_worker_from_verified, random_nonce, read_outcome, run_worker_operation_with,
};
pub(super) use super::process::{
    process_is_alive, stop_target_processes, wait_for_outcome, worker_command_line, WorkerProcess,
};
pub(super) use super::registry::remove_registration_key;
pub(super) use super::relocation::{
    read_relocation_bootstrap, relocate_ui, resolve_relocation_origin, sweep_stale_relocations,
    RelocationBootstrap,
};
pub(super) use super::types::{
    BackupProof, TargetDirectoryProof, WorkerDataRoot, WorkerOutcome, WorkerRequest, WorkerTarget,
};
