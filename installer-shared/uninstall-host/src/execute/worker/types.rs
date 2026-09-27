//! Controller/worker protocol types.

use super::super::identity::{DataRootIdentity, DirectoryIdentity};
use serde::{Deserialize, Serialize};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::scan::FileFingerprint;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerTarget {
    pub path: String,
    pub scope: InstallScope,
    pub fingerprint: FileFingerprint,
    /// Every registry root that claims this installation. The worker deletes a
    /// registration only when the stored `InstallLocation` explicitly matches
    /// the target it just removed; unknown roots are refused before any change.
    pub registered_roots: Vec<String>,
}
/// A user-data directory with the identity captured when the request was
/// prepared, so the worker can refuse to delete anything that changed since.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerDataRoot {
    pub path: String,
    /// Advisory metadata only. For a data root the legacy `FileFingerprint` is
    /// just directory timestamps plus three application files that normally do
    /// not exist here; it is **not** a data identity and must never be treated
    /// as one. `identity` is the check that authorizes deletion.
    pub fingerprint: FileFingerprint,
    pub identity: DataRootIdentity,
    /// Selected source files from a controller-verified strict export receipt
    /// (safe relative path -> sha256 at export time). When present the worker
    /// re-hashes every listed file before deleting, so a data root captured
    /// after the backup can never authorize bytes that the backup omitted.
    #[serde(default)]
    pub verified_source_hashes: BTreeMap<String, String>,
    /// The exact exporter-time digest of the complete data tree (see
    /// [`export_tree_digest`]). The selected-source hashes only cover archived
    /// files, so a file added after the export to a *selected* directory would
    /// otherwise be blessed by a snapshot captured later. When present the worker
    /// recomputes the whole tree immediately before deletion and refuses any
    /// mismatch. `None` only for strategies with no verified export.
    #[serde(default)]
    pub verified_tree_sha256: Option<String>,
}

/// Controller-captured directory object identity for one installation target.
///
/// The worker must not derive the identity of the directory it is about to
/// delete: a same-user process can replace the directory and restore the
/// metadata `FileFingerprint` reads. The controller captures the volume/file-id
/// while it still holds the validated target, and the worker only compares.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetDirectoryProof {
    pub path: String,
    pub directory: DirectoryIdentity,
}

/// The controller-verified strict-export proof that authorizes an `Export`
/// deletion. It contains no password: only the archive path, the data root it
/// was bound to, the selected source inventory and the raw archive hash.
///
/// `entry_hashes` binds the bytes the backup actually contains; `archive_sha256`
/// binds the raw archive file itself (including an encrypted SABK container);
/// `tree_sha256` binds the exporter-time complete data tree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupProof {
    pub path: String,
    pub root: String,
    pub entry_hashes: BTreeMap<String, String>,
    pub archive_sha256: String,
    /// SHA-256 of the exporter's complete data-tree snapshot
    /// ([`export_tree_digest`]). Unlike `entry_hashes` it also covers files the
    /// selected categories omit, so a deletion can never remove a file that
    /// appeared after the export.
    pub tree_sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerPreparation {
    pub strategy: DataStrategy,
    pub data_roots: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerRequest {
    pub protocol_version: u32,
    pub operation_id: String,
    pub request_id: String,
    pub nonce: String,
    /// The controller process that prepared this request. The worker refuses a
    /// request whose controller is gone or belongs to another user.
    pub controller_pid: u32,
    /// User SID of the caller that launched the uninstaller. Alternate-admin
    /// elevation produces a different SID and is refused before deletion.
    pub caller_user_sid: String,
    /// SHA-256 of the relocated `worker.exe`. The worker hashes its own image
    /// and refuses to delete anything when the two do not match.
    pub worker_sha256: String,
    pub strategy: DataStrategy,
    pub targets: Vec<WorkerTarget>,
    /// Directory identity the controller captured for each target path.
    #[serde(default)]
    pub target_identities: Vec<TargetDirectoryProof>,
    pub data_roots: Vec<WorkerDataRoot>,
    /// Verified archive path. The worker never receives a password.
    pub backup_path: Option<String>,
    /// SHA-256 of the raw archive file recorded by the verified receipt. An
    /// `Export` request always carries it so the worker can prove the archive it
    /// deletes alongside is the one the receipt verified.
    #[serde(default)]
    pub backup_sha256: Option<String>,
    /// A preparation request can stop processes but cannot delete anything.
    #[serde(default)]
    pub preparation: Option<WorkerPreparation>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerOutcome {
    pub protocol_version: u32,
    pub operation_id: String,
    pub nonce: String,
    pub removed_install_paths: Vec<String>,
    pub removed_data_roots: Vec<String>,
    /// Scopes that were only partially removed. They are reported separately so
    /// a partial deletion is never presented as a clean, side-effect-free
    /// failure.
    pub partially_removed_paths: Vec<String>,
    pub warnings: Vec<String>,
    pub error: Option<UninstallError>,
}
