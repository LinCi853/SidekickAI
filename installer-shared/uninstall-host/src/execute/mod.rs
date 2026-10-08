//! Native execution: a controller process prepares an operation, an external
//! temporary worker performs the irreversible deletion, and the controller
//! reports the worker's verified result. No deletion happens in-process while
//! the executable sits inside the directory being removed.
//!
//! Trust boundary: a request file is data, not authorization. The worker only
//! acts on a request that sits next to the relocated worker image inside a
//! per-operation directory whose name embeds the request operation id and an
//! unpredictable nonce, that has no reparse-point ancestor, and that was
//! prepared by a live controller process belonging to the same Windows user as
//! the worker. Elevation of the *same* account keeps the user SID, so UAC works;
//! alternate administrator credentials change the SID and are refused before a
//! single file is deleted. This deliberately does not claim to authenticate a
//! malicious process that already runs as the same user.

mod hashing;
mod identity;
mod pinned;
mod tree;
mod worker;

use sidekickai_uninstall_core::protocol::{
    UninstallError, UninstallErrorCode, UninstallPhase,
};
use std::time::Duration;

pub use hashing::sha256_file;
pub(crate) use hashing::write_atomic;
#[cfg(windows)]
pub use worker::target_processes;
pub use worker::{
    cleanup_directory, create_operation_dir, is_process_elevated, read_relocation_bootstrap,
    relocate_ui, run_worker, spawn_detached,
    stop_target_processes, BackupProof, WorkerTarget,
};

pub(crate) use identity::{current_user_sid, harden_operation_directory, process_user_sid};
pub(crate) use tree::export_tree_digest;
pub(crate) use worker::{WorkerSession, processes_require_elevation};
#[cfg(test)]
pub(crate) use worker::assert_save_without_data_locks;
pub(crate) use worker::transaction::discover as pending_uninstall_tasks;

pub const WORKER_ROOT: &str = "SidekickAI-Uninstall";

const WORKER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// After a verified result the worker still has to exit: on Windows its own
/// image stays open until the process is gone, so the operation directory (and
/// any file inside the deletion scope) cannot be cleaned up before that.
const WORKER_EXIT_GRACE: Duration = Duration::from_secs(30);
const REQUEST_NONCE_LEN: usize = 32;
const SHA256_HEX_LEN: usize = 64;
/// A relocation directory is only reclaimed by PID after this grace period, so a
/// relocated UI that is still reading its own bootstrap is never swept.
const RELOCATION_SWEEP_GRACE: Duration = Duration::from_secs(60);
const RELOCATION_ORPHAN_AGE: Duration = Duration::from_secs(3600);

fn internal(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::Internal, message, UninstallPhase::Failed, false, "")
}

fn worker_failure(operation_id: &str, message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::Internal, message, UninstallPhase::Failed, true, operation_id)
}

fn invalid_request(operation_id: &str, message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::InvalidRequest, message, UninstallPhase::Validating, false, operation_id)
}

fn unsafe_path(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::UnsafePath, message, UninstallPhase::Validating, false, "")
}
