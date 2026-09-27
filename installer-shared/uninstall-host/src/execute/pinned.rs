//! Handle-pinned, no-reparse removal (Windows) and ancestor pinning.
use super::identity::DirectoryIdentity;
use super::tree::metadata_is_reparse;
use super::unsafe_path;
use sidekickai_uninstall_core::path::{path_is_same_or_descendant, paths_equal};
use sidekickai_uninstall_core::protocol::UninstallError;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Handle-pinned, no-reparse removal (Windows)
// ---------------------------------------------------------------------------

/// A path that was deleted only in part. `removed_entries` counts the children
/// that were actually deleted, so the caller can tell "nothing happened" from
/// "the scope is half gone".
#[derive(Debug)]
pub(super) struct RemovalFailure {
    pub(super) path: PathBuf,
    pub(super) message: String,
    pub(super) removed_entries: usize,
}

/// An open directory handle that pins the object against rename or reparse
/// replacement: it is opened with `FILE_FLAG_OPEN_REPARSE_POINT` and without
/// `FILE_SHARE_DELETE`, so no other opener can rename or swap the object while
/// the handle is alive.
#[cfg(windows)]
pub(super) struct PinnedHandle {
    handle: windows::Win32::Foundation::HANDLE,
    pub(super) path: PathBuf,
    is_directory: bool,
    pub(super) identity: DirectoryIdentity,
}

#[cfg(windows)]
impl PinnedHandle {
    /// Close the handle explicitly and surface a failure, instead of relying on
    /// `Drop`, which cannot report anything.
    fn close(mut self) -> Result<(), String> {
        let handle = std::mem::replace(&mut self.handle, windows::Win32::Foundation::HANDLE::default());
        unsafe { windows::Win32::Foundation::CloseHandle(handle) }.map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
impl Drop for PinnedHandle {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
pub(super) fn open_pinned_handle(path: &Path, delete_access: bool) -> Result<PinnedHandle, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, SYNCHRONIZE,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut access: FILE_ACCESS_RIGHTS = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if delete_access {
        access |= DELETE;
    }
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            access.0,
            // Deliberately no FILE_SHARE_DELETE: this handle is the rename and
            // replacement guard for the object.
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .map_err(|e| format!("无法安全打开 {}：{e}", path.display()))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) }.is_err() {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
        return Err(format!("无法读取 {} 的标识", path.display()));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
        return Err(format!("路径是重解析点：{}", path.display()));
    }
    Ok(PinnedHandle {
        handle,
        path: path.to_path_buf(),
        is_directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
        identity: DirectoryIdentity {
            volume_serial: info.dwVolumeSerialNumber,
            file_index_high: info.nFileIndexHigh,
            file_index_low: info.nFileIndexLow,
        },
    })
}

/// Mark an open object for deletion. The delete itself is committed when the
/// handle is closed, while the handle still pins the object identity.
#[cfg(windows)]
fn mark_for_deletion(entry: &PinnedHandle) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };
    let info = FILE_DISPOSITION_INFO {
        DeleteFile: windows::Win32::Foundation::BOOLEAN(1),
    };
    unsafe {
        SetFileInformationByHandle(
            entry.handle,
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|e| format!("无法将 {} 加入删除队列：{e}", entry.path.display()))
}

#[cfg(windows)]
fn clear_directory_handles(directory: &PinnedHandle, removed: &mut usize) -> Result<(), RemovalFailure> {
    let entries = fs::read_dir(&directory.path).map_err(|e| RemovalFailure {
        path: directory.path.clone(),
        message: format!("无法枚举 {}：{e}", directory.path.display()),
        removed_entries: *removed,
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| RemovalFailure {
            path: directory.path.clone(),
            message: format!("无法枚举 {}：{e}", directory.path.display()),
            removed_entries: *removed,
        })?;
        let path = entry.path();
        let child = open_pinned_handle(&path, true).map_err(|message| RemovalFailure {
            path: path.clone(),
            message,
            removed_entries: *removed,
        })?;
        if child.is_directory {
            clear_directory_handles(&child, removed)?;
        }
        mark_for_deletion(&child).map_err(|message| RemovalFailure {
            path: path.clone(),
            message,
            removed_entries: *removed,
        })?;
        // Counted as removed once the disposition is set. A pre-existing opener
        // that shared delete can keep the file pending for a moment, so the
        // count is best-effort; the post-removal root revalidation below is what
        // decides whether the scope really disappeared, and a survivor is
        // reported as a partial removal rather than a clean success.
        *removed += 1;
        // Closing the handle commits the deletion of this child.
        child.close().map_err(|message| RemovalFailure {
            path: path.clone(),
            message,
            removed_entries: *removed,
        })?;
    }
    Ok(())
}

/// Remove a directory tree without ever following a reparse point. The root
/// handle pins the object identity; every descendant is opened and re-checked
/// the same way, so a name swap cannot redirect the delete outside the scope.
#[cfg(windows)]
pub(super) fn remove_tree_pinned(root: &Path, expected: &DirectoryIdentity) -> Result<(), RemovalFailure> {
    let root_handle = open_pinned_handle(root, true).map_err(|message| RemovalFailure {
        path: root.to_path_buf(),
        message,
        removed_entries: 0,
    })?;
    if !root_handle.is_directory {
        return Err(RemovalFailure {
            path: root.to_path_buf(),
            message: "移除范围不是目录".into(),
            removed_entries: 0,
        });
    }
    if &root_handle.identity != expected {
        return Err(RemovalFailure {
            path: root.to_path_buf(),
            message: "移除范围在删除前已被替换".into(),
            removed_entries: 0,
        });
    }
    let mut removed = 0usize;
    clear_directory_handles(&root_handle, &mut removed)?;
    mark_for_deletion(&root_handle).map_err(|message| RemovalFailure {
        path: root.to_path_buf(),
        message,
        removed_entries: removed,
    })?;
    root_handle.close().map_err(|message| RemovalFailure {
        path: root.to_path_buf(),
        message,
        removed_entries: removed,
    })?;
    // Revalidate after the final removal rather than trusting the close.
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(RemovalFailure {
            path: root.to_path_buf(),
            message: "删除后范围内仍存在文件".into(),
            removed_entries: removed,
        }),
        Err(error) => Err(RemovalFailure {
            path: root.to_path_buf(),
            message: format!("删除后无法重新校验 {}：{error}", root.display()),
            removed_entries: removed,
        }),
    }
}

#[cfg(not(windows))]
pub(super) fn remove_tree_pinned(root: &Path, _expected: &DirectoryIdentity) -> Result<(), RemovalFailure> {
    fs::remove_dir_all(root).map_err(|e| RemovalFailure {
        path: root.to_path_buf(),
        message: e.to_string(),
        removed_entries: 0,
    })
}

/// Pin the ancestor chain of every removal scope, so the name chain cannot be
/// renamed or turned into a reparse point while the deletion runs.
///
/// Two rules matter:
/// - Only the ancestors *outside* every selected scope are pinned. A portable
///   data root lives inside its installation, and pinning the installation as an
///   ancestor would then hold a handle on the directory the worker later opens
///   for deletion, making every portable deletion fail.
/// - The chain is opened from the volume root downward, so an already-pinned
///   parent protects the name of each component before the next one is opened
///   (bottom-up opening leaves the upper path swappable while the lower is
///   opened).
///
/// On Windows a directory handle blocks a rename only when it was opened with
/// `DELETE` access, so that is tried first. Some ancestors (the volume root or a
/// profile directory held by the shell) never grant `DELETE`; those are held
/// open read-only instead of failing the whole uninstall, which means a rename of
/// such an ancestor is detected by the scope's identity revalidation rather than
/// prevented. A reparse-point ancestor always fails closed.
#[cfg(windows)]
pub(super) fn pin_external_ancestors(scopes: &[PathBuf]) -> Result<Vec<PinnedHandle>, UninstallError> {
    let mut ancestors: Vec<PathBuf> = Vec::new();
    for scope in scopes {
        let mut current = scope.parent();
        while let Some(ancestor) = current {
            let inside_a_scope = scopes
                .iter()
                .any(|candidate| path_is_same_or_descendant(ancestor, candidate));
            if !inside_a_scope && !ancestors.iter().any(|existing| paths_equal(existing, ancestor)) {
                ancestors.push(ancestor.to_path_buf());
            }
            current = ancestor.parent();
        }
    }
    // Root-first: a parent is always opened before any of its descendants.
    ancestors.sort_by_key(|path| path.components().count());
    let mut pins = Vec::with_capacity(ancestors.len());
    for ancestor in ancestors {
        match open_pinned_handle(&ancestor, true) {
            Ok(pin) => pins.push(pin),
            Err(_) => {
                // A link anywhere in the chain is refused, never followed; only a
                // sharing/permission conflict downgrades the rename guard.
                if ancestor_is_reparse_point(&ancestor) {
                    return Err(unsafe_path(format!("无法固定上级路径：路径是重解析点：{}", ancestor.display())));
                }
                let pin = open_pinned_handle(&ancestor, false)
                    .map_err(|message| unsafe_path(format!("无法固定上级路径：{message}")))?;
                pins.push(pin);
            }
        }
    }
    Ok(pins)
}

#[cfg(windows)]
fn ancestor_is_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|metadata| metadata.file_type().is_symlink() || metadata_is_reparse(&metadata)).unwrap_or(false)
}

#[cfg(not(windows))]
pub(super) fn pin_external_ancestors(_scopes: &[PathBuf]) -> Result<Vec<()>, UninstallError> {
    Ok(Vec::new())
}
