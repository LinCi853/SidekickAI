// directory —— 每次操作的私有目录
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::manifest::InstallRequest;

use super::envelope::{random_hex, sha256_file, OperationRequest};
use super::{NONCE_HEX_LEN, OPERATION_PROTOCOL_VERSION, OPERATION_ROOT_NAME, REQUEST_FILE, RESULT_FILE};

// ---------------------------------------------------------------------------
// Private operation directory
// ---------------------------------------------------------------------------

/// Root of all installer operation directories below the user's temp directory.
pub fn operation_root() -> PathBuf {
    let name = if cfg!(test) {
        // Keep test fixtures away from a real wizard's directories.
        format!("{OPERATION_ROOT_NAME}-test-{}", std::process::id())
    } else {
        OPERATION_ROOT_NAME.to_string()
    };
    std::env::temp_dir().join(name)
}

/// One private, unpredictable directory for exactly one operation. The name is
/// `{operationId}-{nonce}` and the directory carries a protected DACL applied
/// through its inheritable ACEs, so another interactive user cannot read or
/// replace the request or the result inside it.
pub struct OperationDirectory {
    path: PathBuf,
    operation_id: String,
    nonce: String,
}

impl OperationDirectory {
    pub fn create(kind: &str) -> Result<Self, String> {
        let root = operation_root();
        fs::create_dir_all(&root).map_err(|error| format!("无法创建安装操作根目录：{error}"))?;
        for _ in 0..16 {
            let operation_id =
                sidekickai_uninstall_core::random_id(kind).map_err(|error| error.message)?;
            let nonce = random_hex()?;
            let path = root.join(format!("{operation_id}-{nonce}"));
            match fs::create_dir(&path) {
                Ok(()) => {
                    if let Err(error) = harden_private_directory(&path) {
                        let _ = fs::remove_dir(&path);
                        return Err(error);
                    }
                    return Ok(Self { path, operation_id, nonce });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建安装操作目录：{error}")),
            }
        }
        Err("无法分配私有的安装操作目录。".into())
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn nonce(&self) -> &str {
        &self.nonce
    }
    pub fn request_path(&self) -> PathBuf {
        self.path.join(REQUEST_FILE)
    }
    pub fn result_path(&self) -> PathBuf {
        self.path.join(RESULT_FILE)
    }
    pub fn log_path(&self) -> PathBuf {
        self.path.join("install.log")
    }

    /// Write the request atomically. The directory is removed again by `Drop`
    /// when the operation finishes, so no request is ever reused.
    pub fn write_request(&self, request: &OperationRequest) -> Result<(), String> {
        let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
        sidekickai_uninstall_core::write_private_file(&self.request_path(), &bytes)
            .map_err(|error| error.message)
    }

    /// Build and persist the invocation envelope for this directory, binding the
    /// invocation user, the controller process and the running image.
    pub fn write_envelope(
        &self,
        action: &str,
        request: &InstallRequest,
    ) -> Result<OperationRequest, String> {
        let source_exe =
            std::env::current_exe().map_err(|error| format!("无法定位安装程序：{error}"))?;
        let envelope = OperationRequest {
            protocol_version: OPERATION_PROTOCOL_VERSION,
            operation_id: self.operation_id().to_string(),
            nonce: self.nonce().to_string(),
            action: action.to_string(),
            controller_pid: std::process::id(),
            caller_user_sid: current_user_sid()?,
            source_sha256: sha256_file(&source_exe)?,
            request: request.clone(),
        };
        self.write_request(&envelope)?;
        Ok(envelope)
    }

    /// Turn this directory into a prepared operation whose paths are bound to it.
    pub fn into_prepared(self) -> PreparedOperation {
        PreparedOperation {
            request_path: self.request_path(),
            result_path: self.result_path(),
            log_path: self.log_path(),
            operation_id: self.operation_id().to_string(),
            nonce: self.nonce().to_string(),
            _directory: self,
        }
    }
}

impl Drop for OperationDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Paths bound to one prepared operation. Holding this value keeps the private
/// directory alive; dropping it removes the directory.
pub struct PreparedOperation {
    _directory: OperationDirectory,
    pub request_path: PathBuf,
    pub result_path: PathBuf,
    pub log_path: PathBuf,
    pub operation_id: String,
    pub nonce: String,
}

/// Prepare one operation: create the private directory and write a request that
/// binds the invocation user, the controller process and the running image.
pub fn prepare_operation(
    kind: &str,
    action: &str,
    request: &InstallRequest,
) -> Result<PreparedOperation, String> {
    let directory = OperationDirectory::create(kind)?;
    directory.write_envelope(action, request)?;
    Ok(directory.into_prepared())
}

/// Confirm the directory is one this protocol created, not an arbitrary folder
/// that happens to hold a `request.json`. A hardened operation directory is
/// owned by the controller's user, replaces ACL inheritance and carries exactly
/// the user / SYSTEM / Administrators ACEs. This is a source-identity check, not
/// authentication: a same-user process can recreate such a directory, as the
/// module header documents.
#[cfg(windows)]
pub(super) fn verify_private_directory(directory: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
    };

    let expected_owner = current_user_sid()?;
    let wide: Vec<u16> = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut owner = PSID::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        );
        if status.0 != 0 {
            return Err(format!("无法读取安装请求目录的安全信息（错误码 {}）。", status.0));
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        let control_read =
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision).is_ok();
        let protected = control_read && (control & SE_DACL_PROTECTED.0) != 0;
        let ace_count = if dacl.is_null() { 0 } else { (*dacl).AceCount };
        let owner_text = sid_to_string(owner);
        let _ = LocalFree(HLOCAL(descriptor.0));
        if !protected || ace_count != 3 {
            return Err("安装请求目录不是本安装器创建的私有目录；已拒绝。".into());
        }
        match owner_text {
            Some(owner) if owner.eq_ignore_ascii_case(&expected_owner) => Ok(()),
            Some(_) => Err("安装请求目录不属于当前用户账户；已拒绝。".into()),
            None => Err("无法确认安装请求目录的所有者；已拒绝。".into()),
        }
    }
}

/// Format a SID read from a security descriptor.
#[cfg(windows)]
unsafe fn sid_to_string(sid: windows::Win32::Security::PSID) -> Option<String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    let mut raw = windows::core::PWSTR::null();
    ConvertSidToStringSidW(sid, &mut raw).ok()?;
    let mut length = 0usize;
    while *raw.0.add(length) != 0 {
        length += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(raw.0, length));
    let _ = LocalFree(HLOCAL(raw.0.cast()));
    Some(text)
}

#[cfg(not(windows))]
fn verify_private_directory(_directory: &Path) -> Result<(), String> {
    Ok(())
}

/// The directory name is `{operationId}-{nonce}`; binding the request to it
/// keeps a stray request from being treated as this operation's work.
pub(super) fn validate_operation_directory_name(
    directory: &Path,
    operation_id: &str,
    nonce: &str,
) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.contains(['\\', '/', ':'])
        || nonce.len() != NONCE_HEX_LEN
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("安装请求缺少有效的操作标识。".into());
    }
    let expected = format!("{operation_id}-{nonce}");
    if directory.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
        return Err("安装请求不在本次操作的私有目录中。".into());
    }
    Ok(())
}

/// Apply a protected DACL that grants full control only to the current user,
/// SYSTEM and the built-in Administrators group. Inheritance is replaced rather
/// than extended, so a permissive parent such as `%TEMP%` cannot hand the
/// directory to another account.
pub(super) fn harden_private_directory(directory: &Path) -> Result<(), String> {
    sidekickai_uninstall_host::harden_private_directory(directory).map_err(|error| error.message)
}

pub(super) fn current_user_sid() -> Result<String, String> {
    sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)
}

pub(super) fn process_user_sid(pid: u32) -> Result<String, String> {
    sidekickai_uninstall_host::process_user_sid(pid).map_err(|error| error.message)
}
