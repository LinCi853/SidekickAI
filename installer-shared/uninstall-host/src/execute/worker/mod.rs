//! Worker protocol types, private operation directories, controller
//! preparation, worker deletion and process handoff.

pub(super) mod deletion;
pub(super) mod validate;
pub(super) mod prepare;
pub(super) mod process;
pub(super) mod registry;
mod registration_snapshot;
pub(crate) mod transaction;
pub(super) mod relocation;
pub(super) mod session;
pub(super) mod types;

#[cfg(test)]
mod tests;

use super::hashing::sha256_file;
use super::invalid_request;
use super::SHA256_HEX_LEN;
use sidekickai_uninstall_core::path::{normalize_absolute_path, NormalizedAbsolutePath};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::scan::FileFingerprint;
use std::collections::BTreeMap;

pub use deletion::run_worker;
pub use prepare::{
    cleanup_directory, create_operation_dir,
};
pub use process::{is_process_elevated, spawn_detached, stop_target_processes};
#[cfg(windows)]
pub use process::target_processes;
pub use relocation::{read_relocation_bootstrap, relocate_ui};
pub use types::{BackupProof, WorkerTarget};
pub(crate) use session::WorkerSession;
pub(crate) use process::processes_require_elevation;
#[cfg(test)]
pub(crate) use shutdown::assert_save_without_data_locks;

/// Program markers corroborate the separately verified signed installation.
/// Signed identity permits maintenance when the application archive is damaged.
pub(super) fn installation_markers_present(fingerprint: &FileFingerprint) -> bool {
    if !fingerprint.exists || !fingerprint.is_directory {
        return false;
    }
    let present = |relative: &str| {
        fingerprint.core_files.iter().any(|file| {
            file.relative_path.replace('/', "\\").eq_ignore_ascii_case(relative) && file.exists && file.is_file
        })
    };
    present("uninstall.exe") && (present("resources\\app.asar")
        || present("distribution-proof.json") && present("maintenance\\distribution-receipt.json"))
}

/// Re-hash the source files a verified backup actually contains. This is the
/// binding that makes the captured data-root snapshot trustworthy: the snapshot
/// may contain bytes added after the backup, but every byte the backup carries
/// must still be present and unchanged or the deletion is refused.
pub(super) fn verify_verified_source_hashes(
    root: &NormalizedAbsolutePath,
    hashes: &BTreeMap<String, String>,
    operation_id: &str,
) -> Result<(), UninstallError> {
    for (entry, expected) in hashes {
        let file = normalize_absolute_path(root.as_path().join(entry))?;
        if !file.is_descendant_of(root) {
            return Err(invalid_request(operation_id, "已确认源条目超出数据根范围。"));
        }
        let actual = sha256_file(file.as_path()).map_err(|error| {
            UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("备份后已确认源数据无法读取：{entry}：{error}"),
                UninstallPhase::Validating,
                false,
                operation_id,
            )
        })?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("已确认备份后所选源数据发生变更：{entry}"),
                UninstallPhase::Validating,
                false,
                operation_id,
            ));
        }
    }
    Ok(())
}

/// A selected source entry must be a safe relative path with a well-formed hash
/// before it is joined to a data root.
pub(super) fn verified_source_entry_is_safe(entry: &str, hash: &str) -> bool {
    !entry.is_empty()
        && !entry.contains('\\')
        && !entry.contains(':')
        && !entry.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        && hash.len() == SHA256_HEX_LEN
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(windows)]
mod shutdown;
