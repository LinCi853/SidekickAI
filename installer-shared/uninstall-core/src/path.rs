//! Path normalization and scope checks shared by scan, plan, and delete.
//!
//! This module intentionally does not canonicalize paths.  Canonicalization can
//! follow a junction between validation and deletion.  Instead, callers receive
//! a lexical absolute path and every existing component is inspected with
//! `symlink_metadata` (and Windows reparse attributes when available).

use crate::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NormalizedAbsolutePath(PathBuf);

impl NormalizedAbsolutePath {
    pub fn parse(path: impl AsRef<Path>) -> Result<Self, UninstallError> {
        normalize(path.as_ref(), false)
    }

    pub fn parse_target(path: impl AsRef<Path>) -> Result<Self, UninstallError> {
        normalize(path.as_ref(), true)
    }

    pub fn parse_existing_target(path: impl AsRef<Path>) -> Result<Self, UninstallError> {
        let normalized = Self::parse_target(path)?;
        let metadata = fs::symlink_metadata(normalized.as_path()).map_err(|error| {
            path_error(
                UninstallErrorCode::TargetNotDirectory,
                format!("无法检查目标：{error}"),
            )
        })?;
        if !metadata.is_dir() {
            return Err(path_error(
                UninstallErrorCode::TargetNotDirectory,
                "卸载目标不是目录",
            ));
        }
        reject_reparse_points(normalized.as_path())?;
        Ok(normalized)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn as_string(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    pub fn parent(&self) -> Option<Self> {
        self.0.parent().and_then(|parent| Self::parse(parent).ok())
    }

    pub fn is_same_or_descendant_of(&self, ancestor: &Self) -> bool {
        path_is_same_or_descendant(self.as_path(), ancestor.as_path())
    }

    pub fn is_descendant_of(&self, ancestor: &Self) -> bool {
        self.is_same_or_descendant_of(ancestor)
            && !paths_equal(self.as_path(), ancestor.as_path())
    }

    pub fn components(&self) -> impl Iterator<Item = Component<'_>> {
        self.0.components()
    }
}

impl AsRef<Path> for NormalizedAbsolutePath {
    fn as_ref(&self) -> &Path {
        self.as_path()
    }
}

/// Parse an absolute Windows path without following links.  `reject_root`
/// protects deletion scopes from accidentally receiving `C:\\` or a UNC share
/// root; output files use `parse` and may therefore have a root parent.
pub fn normalize_absolute_path(
    path: impl AsRef<Path>,
) -> Result<NormalizedAbsolutePath, UninstallError> {
    NormalizedAbsolutePath::parse(path)
}

pub fn normalize_target_path(
    path: impl AsRef<Path>,
) -> Result<NormalizedAbsolutePath, UninstallError> {
    NormalizedAbsolutePath::parse_existing_target(path)
}

pub fn reject_reparse_points(path: &Path) -> Result<(), UninstallError> {
    let absolute = normalize_lexically(path, false)?;
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(path_error(
                    UninstallErrorCode::UnsafePath,
                    format!("无法检查路径组件：{error}"),
                ));
            }
        };
        if metadata.file_type().is_symlink() || metadata_has_reparse_point(&metadata) {
            return Err(path_error(
                UninstallErrorCode::PathReparsePoint,
                format!("路径包含重解析点：{}", current.display()),
            ));
        }
    }
    Ok(())
}

/// Inspect the entire proposed scope without following links. This preflight
/// does not replace the native worker's handle-bound checks before each delete.
pub fn validate_tree(path: &Path) -> Result<(), UninstallError> {
    normalize_target_path(path)?;
    let mut pending = vec![path.to_owned()];
    while let Some(current) = pending.pop() {
        let metadata = fs::symlink_metadata(&current).map_err(|e| path_error(UninstallErrorCode::UnsafePath, e.to_string()))?;
        if metadata.file_type().is_symlink() || metadata_has_reparse_point(&metadata) {
            return Err(path_error(UninstallErrorCode::PathReparsePoint, format!("范围包含重解析点：{}", current.display())));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&current).map_err(|e| path_error(UninstallErrorCode::UnsafePath, e.to_string()))? {
                pending.push(entry.map_err(|e| path_error(UninstallErrorCode::UnsafePath, e.to_string()))?.path());
            }
        } else if !metadata.is_file() {
            return Err(path_error(UninstallErrorCode::UnsafePath, "范围包含非常规文件"));
        }
    }
    Ok(())
}

/// Return whether `candidate` is the same as or below `ancestor`, comparing
/// Windows paths case-insensitively and using the normalized separators.
///
/// Windows compares file names with the ordinal, case-insensitive identity of
/// the whole Unicode range, not with ASCII folding. `to_ascii_lowercase` maps
/// `Δ` and `δ` (or `é` and `É`) to different names and can therefore treat one
/// directory as two; `CompareStringOrdinal` is the OS equality used here.
pub fn paths_equal(candidate: &Path, ancestor: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = path_components(candidate);
        let ancestor = path_components(ancestor);
        candidate.len() == ancestor.len()
            && candidate.iter().zip(&ancestor).all(|(left, right)| windows_component_equal(left, right))
    }
    #[cfg(not(windows))]
    {
        candidate == ancestor
    }
}

pub fn path_is_same_or_descendant(candidate: &Path, ancestor: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = path_components(candidate);
        let ancestor = path_components(ancestor);
        if ancestor.len() > candidate.len() {
            return false;
        }
        candidate.iter().zip(&ancestor).all(|(left, right)| windows_component_equal(left, right))
    }
    #[cfg(not(windows))]
    {
        if candidate == ancestor {
            return true;
        }
        let candidate = candidate.to_string_lossy().replace('/', "\\");
        let ancestor = ancestor.to_string_lossy().replace('/', "\\");
        candidate
            .strip_prefix(&ancestor)
            .is_some_and(|suffix| suffix.starts_with('\\'))
    }
}

/// One path as its individual components, so a prefix comparison cannot match a
/// sibling whose name merely starts with the ancestor's text (`C:\ab` vs
/// `C:\a`) and separators or a trailing separator never change the identity.
#[cfg(windows)]
fn path_components(path: &Path) -> Vec<std::ffi::OsString> {
    path.components().map(|component| component.as_os_str().to_owned()).collect()
}

/// Ordinal, case-insensitive comparison of one Windows path component.
///
/// `CompareStringOrdinal` returns 0 when it cannot compare (for example an
/// invalid argument), and a comparison that cannot be performed must not be
/// reported as equal: the exact text is then the only trusted match.
#[cfg(windows)]
fn windows_component_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    if left.is_empty() || right.is_empty() {
        return left == right;
    }
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    let result = unsafe { CompareStringOrdinal(&left, &right, true) };
    if result == CSTR_EQUAL {
        true
    } else if result.0 == 0 {
        left == right
    } else {
        false
    }
}

pub fn ensure_not_in_scope(
    candidate: &NormalizedAbsolutePath,
    scopes: &[NormalizedAbsolutePath],
) -> Result<(), UninstallError> {
    if scopes
        .iter()
        .any(|scope| path_is_same_or_descendant(candidate.as_path(), scope.as_path()))
    {
        return Err(path_error(
            UninstallErrorCode::BackupPathInScope,
            "备份输出位于所选卸载范围内",
        ));
    }
    Ok(())
}

fn normalize(path: &Path, reject_root: bool) -> Result<NormalizedAbsolutePath, UninstallError> {
    let normalized = normalize_lexically(path, reject_root)?;
    reject_reparse_points(&normalized)?;
    Ok(NormalizedAbsolutePath(normalized))
}

fn normalize_lexically(path: &Path, reject_root: bool) -> Result<PathBuf, UninstallError> {
    if !path.is_absolute() {
        return Err(path_error(
            UninstallErrorCode::UnsafePath,
            "路径必须是绝对路径",
        ));
    }

    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if text.starts_with("\\\\") || text.split(['\\', '/']).skip(1).any(|part| {
            part.contains(':') || (part != "." && part != ".." && part.ends_with('.')) || part.ends_with(' ')
                || part.chars().any(|c| c.is_control())
        }) {
            return Err(path_error(UninstallErrorCode::UnsafePath, "不接受设备路径、UNC 路径、数据流或歧义路径组件"));
        }
    }
    let mut normalized = PathBuf::new();
    let mut has_non_root_component = false;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {
                return Err(path_error(
                    UninstallErrorCode::UnsafePath,
                    "路径包含当前目录组件",
                ));
            }
            Component::ParentDir => {
                return Err(path_error(
                    UninstallErrorCode::TargetIsParent,
                    "路径包含上级目录组件",
                ));
            }
            Component::Normal(name) => {
                if name.is_empty() {
                    return Err(path_error(
                        UninstallErrorCode::UnsafePath,
                        "路径包含空组件",
                    ));
                }
                has_non_root_component = true;
                normalized.push(name);
            }
        }
    }

    if reject_root && !has_non_root_component {
        return Err(path_error(
            UninstallErrorCode::TargetIsRoot,
            "文件系统根目录不能作为卸载目标",
        ));
    }
    if normalized.as_os_str().is_empty() {
        return Err(path_error(
            UninstallErrorCode::UnsafePath,
            "规范化后路径为空",
        ));
    }
    Ok(normalized)
}

#[cfg(windows)]
fn metadata_has_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_has_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn path_error(code: UninstallErrorCode, message: impl Into<String>) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::Validating, false, "")
}

#[allow(dead_code)]
fn _keep_os_string_import(_: OsString) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("sidekick-uninstall-path-{name}-{nonce}"))
    }

    #[test]
    fn rejects_relative_parent_and_root_targets() {
        let relative = PathBuf::from("relative\\SidekickAI");
        assert_eq!(
            normalize_target_path(relative).unwrap_err().code,
            UninstallErrorCode::UnsafePath
        );

        let parent = if cfg!(windows) {
            PathBuf::from(r"C:\temp\..\SidekickAI")
        } else {
            PathBuf::from("/tmp/../SidekickAI")
        };
        assert_eq!(
            normalize_target_path(parent).unwrap_err().code,
            UninstallErrorCode::TargetIsParent
        );

        let root = if cfg!(windows) {
            PathBuf::from(r"C:\")
        } else {
            PathBuf::from("/")
        };
        assert_eq!(
            normalize_target_path(root).unwrap_err().code,
            UninstallErrorCode::TargetIsRoot
        );
    }

    #[test]
    fn rejects_symlink_target_when_fixture_supports_it() {
        let root = fixture_path("reparse");
        let target = root.join("target");
        let link = root.join("link");
        fs::create_dir_all(&target).expect("fixture");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&target, &link).expect("symlink");
        let result = normalize_target_path(&link);
        assert_eq!(
            result.unwrap_err().code,
            UninstallErrorCode::PathReparsePoint
        );
        let _ = fs::remove_dir_all(root);
    }

    /// Windows path identity is ordinal and case-insensitive across Unicode, and
    /// it is component-aware: a sibling whose name starts with an ancestor's
    /// text is not a descendant.
    #[cfg(windows)]
    #[test]
    fn compares_windows_paths_with_unicode_ordinal_identity() {
        let mixed = PathBuf::from("C:\\Äpp\\Éntry");
        let folded = PathBuf::from("c:\\äpp\\éntry");
        assert!(paths_equal(&mixed, &folded), "non-ASCII case must fold ordinally");
        assert!(path_is_same_or_descendant(&mixed.join("child"), &folded));
        assert!(path_is_same_or_descendant(&folded, &mixed), "equality is a descendant");

        // Separator spelling and a trailing separator do not change identity.
        assert!(paths_equal(Path::new("C:/Apps/SidekickAI/"), Path::new("c:\\apps\\sidekickai")));

        // A sibling that only shares a textual prefix is not a descendant.
        assert!(!path_is_same_or_descendant(Path::new("C:\\Apps\\SidekickAI-old"), Path::new("C:\\Apps\\SidekickAI")));
        assert!(!paths_equal(Path::new("C:\\Apps\\SidekickAI-old"), Path::new("C:\\Apps\\SidekickAI")));
    }
}
