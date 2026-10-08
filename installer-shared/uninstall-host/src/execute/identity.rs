//! Directory-object identity and Windows user SID helpers.
#[cfg(windows)]
use super::pinned::open_pinned_handle;
use super::tree::tree_digest;
use super::{internal, unsafe_path};
use serde::{Deserialize, Serialize};
use sidekickai_uninstall_core::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use std::path::Path;

/// Handle-derived identity of a directory object: the volume serial number plus
/// the 64-bit file index. This names the directory *object*, so replacing the
/// directory at the same path (which need not change the root mtime or any
/// `FileFingerprint` field) is still detected.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryIdentity {
    pub volume_serial: u32,
    pub file_index_high: u32,
    pub file_index_low: u32,
}

/// Strong identity for a user-data root: the directory object plus a digest of
/// the complete tree (every relative path, entry kind, length and file bytes).
///
/// The controller captures this after the export has been verified, so for an
/// `Export` run the digest is a post-backup snapshot; the worker recomputes and
/// compares it immediately before the irreversible deletion.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataRootIdentity {
    pub directory: DirectoryIdentity,
    pub tree_sha256: String,
}

/// Bind ownership to the current user and apply a protected DACL granting full control to that user,
/// SYSTEM and the built-in Administrators group. Inheritance is replaced rather
/// than extended, so a permissive parent (for example `%TEMP%`) cannot hand the
/// directory to another account.
#[cfg(windows)]
pub(crate) fn harden_operation_directory(directory: &Path) -> Result<(), UninstallError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{SetFileSecurityW, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    let sid = current_user_sid()?;
    // Never interpolate an unexpected SID into an SDDL string.
    if !sid.starts_with("S-1-") || sid.chars().any(|c| c.is_whitespace() || matches!(c, '(' | ')' | ';')) {
        return Err(internal("无法从有效的用户 SID 推导操作目录 ACL。"));
    }
    let sddl = format!("O:{sid}D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;{sid})");
    let wide_sddl: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let wide_path: Vec<u16> = directory.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(wide_sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|e| internal(format!("无法构建操作目录 ACL：{e}")))?;
        let applied = SetFileSecurityW(PCWSTR(wide_path.as_ptr()), DACL_SECURITY_INFORMATION, descriptor);
        let applied = if applied.as_bool() {
            SetFileSecurityW(PCWSTR(wide_path.as_ptr()), OWNER_SECURITY_INFORMATION, descriptor)
        } else { applied };
        let error = (!applied.as_bool()).then(std::io::Error::last_os_error);
        let _ = LocalFree(HLOCAL(descriptor.0));
        if let Some(error) = error {
            return Err(internal(format!("无法设置安装维护私有目录权限 {}：{error}", directory.display())));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn harden_operation_directory(_directory: &Path) -> Result<(), UninstallError> {
    Ok(())
}

#[cfg(windows)]
fn read_directory_identity(path: &Path) -> Result<DirectoryIdentity, String> {
    let entry = open_pinned_handle(path, false)?;
    Ok(entry.identity.clone())
}

#[cfg(not(windows))]
fn read_directory_identity(_path: &Path) -> Result<DirectoryIdentity, String> {
    Ok(DirectoryIdentity { volume_serial: 0, file_index_high: 0, file_index_low: 0 })
}

impl DirectoryIdentity {
    pub(super) fn from_path(path: &Path) -> Result<Self, UninstallError> {
        read_directory_identity(path).map_err(unsafe_path)
    }
}

impl DataRootIdentity {
    /// Capture the directory object identity plus a complete tree digest. The
    /// caller must run this after any verified export, so the snapshot it
    /// protects is the post-backup state.
    pub(super) fn capture(path: &Path) -> Result<Self, UninstallError> {
        Ok(Self {
            directory: DirectoryIdentity::from_path(path)?,
            tree_sha256: tree_digest(path)?,
        })
    }

    pub(super) fn verify(&self, path: &Path) -> Result<(), UninstallError> {
        let current = Self::capture(path)?;
        if &current != self {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                format!("用户数据在扫描后已变化：{}", path.display()),
                UninstallPhase::Validating,
                false,
                "",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Caller identity (Windows token SID)
// ---------------------------------------------------------------------------

/// The SID of the user that owns the current process token. UAC elevation keeps
/// the same user SID, while alternate administrator credentials change it.
///
/// `pub(crate)` so the host library can re-export it for installer sharing; the
/// host owns the public wrapper.
#[cfg(windows)]
pub(crate) fn current_user_sid() -> Result<String, UninstallError> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| internal(format!("无法检查进程令牌：{e}")))?;
        let sid = token_user_sid(token);
        let _ = CloseHandle(token);
        sid
    }
}

/// Read the user SID from an already-open token handle.
#[cfg(windows)]
unsafe fn token_user_sid(token: windows::Win32::Foundation::HANDLE) -> Result<String, UninstallError> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_USER};
    let mut size = 0u32;
    // The first call only reports the required buffer size.
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
    if size == 0 {
        return Err(internal("无法获取进程令牌用户信息大小。"));
    }
    // TOKEN_USER contains a pointer, so keep the buffer pointer-aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(std::mem::size_of::<u64>())];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buffer.as_mut_ptr().cast()),
        size,
        &mut size,
    )
    .map_err(|e| internal(format!("无法读取进程令牌用户：{e}")))?;
    let user = &*(buffer.as_ptr() as *const TOKEN_USER);
    let mut raw = windows::core::PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut raw)
        .map_err(|e| internal(format!("无法格式化进程用户 SID：{e}")))?;
    let mut length = 0usize;
    while *raw.0.add(length) != 0 {
        length += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(raw.0, length));
    let _ = LocalFree(HLOCAL(raw.0.cast()));
    Ok(text)
}

/// The user SID of an arbitrary process, used to bind a worker request to the
/// controller that produced it. `pub(crate)` for the host library wrapper.
#[cfg(windows)]
pub(crate) fn process_user_sid(pid: u32) -> Result<String, UninstallError> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| internal(format!("无法打开控制进程 {pid}：{e}")))?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        let _ = CloseHandle(process);
        opened.map_err(|e| internal(format!("无法打开控制进程令牌：{e}")))?;
        let sid = token_user_sid(token);
        let _ = CloseHandle(token);
        sid
    }
}

#[cfg(not(windows))]
pub(crate) fn current_user_sid() -> Result<String, UninstallError> {
    Err(internal("用户身份校验仅在 Windows 上实现。"))
}

#[cfg(not(windows))]
pub(crate) fn process_user_sid(_pid: u32) -> Result<String, UninstallError> {
    Err(internal("进程身份校验仅在 Windows 上实现。"))
}
