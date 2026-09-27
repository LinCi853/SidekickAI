//! Backup-path and verification guards.
//!
//! The actual Electron export adapter lives in the host wrapper.  The shared
//! crate only validates the output boundary and verifies a wrapper-provided
//! export summary before deletion can be committed.

use crate::path::{ensure_not_in_scope, normalize_absolute_path, NormalizedAbsolutePath};
use crate::protocol::{
    validate_backup_shape, BackupFormat, BackupResult, BackupSelection, UninstallError,
    UninstallErrorCode, UninstallPhase,
};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedBackupPath {
    pub path: NormalizedAbsolutePath,
    pub format: BackupFormat,
    pub categories: Vec<String>,
}

impl ValidatedBackupPath {
    pub fn as_path(&self) -> &Path {
        self.path.as_path()
    }
}

/// Validate a backup output path against every selected install/data scope.
/// This function never creates or truncates the output file.
pub fn validate_backup_path(
    output_path: impl AsRef<Path>,
    format: &BackupFormat,
    encrypt: bool,
    scopes: &[NormalizedAbsolutePath],
) -> Result<NormalizedAbsolutePath, UninstallError> {
    let path = normalize_absolute_path(output_path)?;
    ensure_not_in_scope(&path, scopes).map_err(|error| {
        UninstallError::new(
            UninstallErrorCode::BackupPathInScope,
            error.message,
            UninstallPhase::Validating,
            false,
            "",
        )
    })?;

    let extension = path
        .as_path()
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let expected = match (format, encrypt) {
        (BackupFormat::Sabackup, true) => "sabackup",
        (BackupFormat::Zip, false) => "zip",
        (BackupFormat::Sabackup, false) | (BackupFormat::Zip, true) => {
            return Err(backup_path_error(
                UninstallErrorCode::BackupFormatInvalid,
                "备份格式与加密选项不匹配",
            ));
        }
    };
    if extension != expected {
        return Err(backup_path_error(
            UninstallErrorCode::BackupFormatInvalid,
            format!("备份输出必须使用 .{expected} 扩展名"),
        ));
    }

    let parent = path.as_path().parent().ok_or_else(|| {
        backup_path_error(
            UninstallErrorCode::BackupPathInvalid,
            "备份输出没有父目录",
        )
    })?;
    let metadata = fs::symlink_metadata(parent).map_err(|error| {
        backup_path_error(
            UninstallErrorCode::BackupPathUnwritable,
            format!("无法检查备份输出目录：{error}"),
        )
    })?;
    if !metadata.is_dir() {
        return Err(backup_path_error(
            UninstallErrorCode::BackupPathUnwritable,
            "备份输出父路径不是目录",
        ));
    }
    if path.as_path().exists() {
        let output_metadata = fs::symlink_metadata(path.as_path()).map_err(|error| {
            backup_path_error(
                UninstallErrorCode::BackupPathUnwritable,
                format!("无法检查备份输出：{error}"),
            )
        })?;
        if output_metadata.file_type().is_symlink() || !output_metadata.is_file() {
            return Err(backup_path_error(
                UninstallErrorCode::BackupPathUnwritable,
                "备份输出不是普通文件",
            ));
        }
    }
    Ok(path)
}

pub fn validate_backup_selection(
    selection: &BackupSelection,
    scopes: &[NormalizedAbsolutePath],
) -> Result<ValidatedBackupPath, UninstallError> {
    let categories = validate_backup_shape(selection)?;
    let path = validate_backup_path(
        &selection.output_path,
        &selection.format,
        selection.encrypt,
        scopes,
    )?;
    Ok(ValidatedBackupPath {
        path,
        format: selection.format.clone(),
        categories,
    })
}

/// Verify the wrapper's completed export summary before any delete helper is
/// allowed to run.  A false `verified` flag is never treated as success.
pub fn verify_backup(
    result: &BackupResult,
    expected: &ValidatedBackupPath,
) -> Result<(), UninstallError> {
    if !result.verified
        || result.path != expected.path.as_string()
        || result.format != expected.format
        || result.entry_count.is_none()
    {
        return Err(backup_path_error(
            UninstallErrorCode::BackupIncomplete,
            "备份导出未通过完整校验",
        ));
    }
    for category in &expected.categories {
        if !result.categories.iter().any(|actual| actual == category) {
            return Err(backup_path_error(
                UninstallErrorCode::BackupIncomplete,
                format!("备份缺少分类 {category}"),
            ));
        }
    }
    Ok(())
}

fn backup_path_error(code: UninstallErrorCode, message: impl Into<String>) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::Validating, false, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::normalize_target_path;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_output_inside_selected_install_scope() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sidekick-uninstall-backup-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        let scope = normalize_target_path(&root).unwrap();
        let output = root.join("backup.zip");
        let error = validate_backup_path(&output, &BackupFormat::Zip, false, &[scope]).unwrap_err();
        assert_eq!(error.code, UninstallErrorCode::BackupPathInScope);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validates_extension_and_writable_parent() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sidekick-uninstall-backup-parent-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        let output = root.join("backup.sabackup");
        let path = validate_backup_path(&output, &BackupFormat::Sabackup, true, &[]).unwrap();
        assert_eq!(path.as_string(), output.to_string_lossy());
        let wrong = root.join("backup.zip");
        let error = validate_backup_path(&wrong, &BackupFormat::Sabackup, true, &[]).unwrap_err();
        assert_eq!(error.code, UninstallErrorCode::BackupFormatInvalid);
        let _ = fs::remove_dir_all(root);
    }
}
