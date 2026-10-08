#[path = "../../product.rs"]
pub mod product;

pub mod archive;
pub mod distribution;
pub mod architecture;
mod sabk_reader;
pub mod backup;
pub mod path;
pub mod protocol;
pub mod scan;
#[cfg(windows)]
pub mod lock;

pub use backup::{
    validate_backup_path, validate_backup_selection, verify_backup, ValidatedBackupPath,
};
pub use path::{
    ensure_not_in_scope, normalize_absolute_path, normalize_target_path, NormalizedAbsolutePath,
};
pub use protocol::*;
pub use scan::{
    current_scan, register_scan, resolve_target, resolve_targets, FileFingerprint, ScannedTarget,
    TargetIdentity,
};

use getrandom::getrandom;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Create a private per-operation directory below the user's temp directory.
/// The caller must still apply a Windows ACL when it runs elevated.  The
/// directory name is unpredictable and is never reused for another request.
pub fn create_operation_dir(operation_id: &str) -> Result<(PathBuf, File), UninstallError> {
    if operation_id.is_empty() || operation_id.contains(['\\', '/', ':']) {
        return Err(UninstallError::invalid_request("invalid operation id"));
    }
    let root = std::env::temp_dir().join("SidekickAI-Uninstall");
    fs::create_dir_all(&root)
        .map_err(|error| internal_error(format!("cannot create operation root: {error}")))?;
    for _ in 0..8 {
        let nonce = random_nonce()?;
        let dir = root.join(format!("{operation_id}-{nonce}"));
        match fs::create_dir(&dir) {
            Ok(()) => {
                let lock = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join("operation.lock"))
                    .map_err(|error| {
                        internal_error(format!("cannot create operation lock: {error}"))
                    })?;
                return Ok((dir, lock));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(internal_error(format!(
                    "cannot create operation directory: {error}"
                )))
            }
        }
    }
    Err(internal_error(
        "could not allocate a private operation directory",
    ))
}

/// Write a file atomically without following an existing reparse-point file.
pub fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), UninstallError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| internal_error(format!("cannot create private parent: {error}")))?;
    }
    let temp = path.with_extension("tmp");
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| internal_error(format!("cannot create private file: {error}")))?;
    use std::io::Write;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| internal_error(format!("cannot write private file: {error}")))?;
    drop(file);
    fs::rename(&temp, path)
        .map_err(|error| internal_error(format!("cannot commit private file: {error}")))
}

pub fn random_id(prefix: &str) -> Result<String, UninstallError> {
    Ok(format!("{prefix}-{}", random_nonce()?))
}

fn random_nonce() -> Result<String, UninstallError> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes)
        .map_err(|error| internal_error(format!("cannot create nonce: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn internal_error(message: impl Into<String>) -> UninstallError {
    UninstallError::new(
        UninstallErrorCode::Internal,
        message,
        UninstallPhase::Validating,
        true,
        "",
    )
}

pub fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_directories_are_unique() {
        let first = random_id("test").unwrap();
        let second = random_id("test").unwrap();
        assert_ne!(first, second);
    }
}
