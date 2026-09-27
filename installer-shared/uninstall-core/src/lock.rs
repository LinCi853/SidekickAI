use crate::path::normalize_absolute_path;
use crate::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

pub struct PathLocks(Vec<HANDLE>);

/// Canonical Windows identity for a path string: invariant-locale uppercase.
///
/// Windows resolves file names with ordinal, case-insensitive comparisons that
/// cover the whole Unicode range, so folding with `to_ascii_lowercase` (which
/// leaves `é`, `Δ` or `д` untouched) can map two spellings of one directory to
/// different lock names. This returns the invariant-uppercase form used for the
/// lock name; equality between two paths is decided by `path::paths_equal`, which
/// uses `CompareStringOrdinal`.
///
/// This is a *canonicalization*, not an equality test, and it is deliberately
/// fail-closed: when the API cannot produce a mapping the call is an error
/// rather than the original string. Returning the input unchanged would let two
/// spellings of one directory hash to different lock names and split the lock.
pub fn windows_ordinal_upper(value: &str) -> Result<String, UninstallError> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Globalization::{LCMapStringEx, LCMAP_UPPERCASE, LOCALE_NAME_INVARIANT};
    let source: Vec<u16> = value.encode_utf16().collect();
    if source.is_empty() {
        return Ok(String::new());
    }
    unsafe {
        // A zero destination size only asks for the required buffer length.
        let required = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, &source, None, None, None, LPARAM(0));
        if required <= 0 {
            return Err(identity_error("无法推导路径的 Windows 大小写标识。"));
        }
        let mut destination = vec![0u16; required as usize];
        let written = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, &source, Some(&mut destination), None, None, LPARAM(0));
        if written <= 0 {
            return Err(identity_error("无法推导路径的 Windows 大小写标识。"));
        }
        Ok(String::from_utf16_lossy(&destination[..written as usize]))
    }
}

impl PathLocks {
    /// Acquire one named mutex per normalized path. Windows path identity is
    /// ordinal and case-insensitive across the whole Unicode range, so the lock
    /// name hashes the invariant uppercase form of the normalized path. All
    /// handles are held until the value is dropped.
    pub fn acquire(paths: &[PathBuf], role: &str) -> Result<Self, UninstallError> {
        let mut names = paths.iter().map(|path| {
            normalize_absolute_path(path).and_then(|path| {
                let identity = windows_ordinal_upper(&path.as_string())?;
                let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
                Ok(format!("Global\\SidekickAI-{role}-{hash}"))
            })
        }).collect::<Result<Vec<_>, _>>()?;
        names.sort();
        names.dedup();
        let mut locks = Self(Vec::new());
        for name in names {
            let wide = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
            unsafe {
                let handle = CreateMutexW(None, false, PCWSTR(wide.as_ptr())).map_err(|error| busy(error.to_string()))?;
                let existing = GetLastError() == ERROR_ALREADY_EXISTS;
                locks.0.push(handle);
                if existing { return Err(busy("另一项安装或卸载正在使用此目标。")); }
            }
        }
        Ok(locks)
    }
}

impl Drop for PathLocks {
    fn drop(&mut self) {
        for handle in self.0.drain(..) { unsafe { let _ = CloseHandle(handle); } }
    }
}

fn busy(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::AlreadyRunning, message, UninstallPhase::Validating, true, "")
}

/// An identity the OS could not derive is an internal failure; it must never be
/// downgraded into a weaker (or original-text) lock name.
fn identity_error(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::Internal, message, UninstallPhase::Validating, false, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_locks_exclude_repeated_operations_and_release_on_drop() {
        let target = std::env::temp_dir().join(crate::random_id("sidekick-lock-test").unwrap());
        let paths = vec![target];
        let owner = PathLocks::acquire(&paths, "test").unwrap();
        assert!(PathLocks::acquire(&paths, "test").is_err());
        let other = vec![std::env::temp_dir().join(crate::random_id("sidekick-other-lock").unwrap())];
        assert!(PathLocks::acquire(&other, "test").is_ok());
        drop(owner);
        assert!(PathLocks::acquire(&paths, "test").is_ok());
    }

    /// A differently-cased spelling of the same Windows path must map to the
    /// same lock, otherwise two processes could delete one target concurrently.
    #[test]
    fn target_locks_normalize_windows_path_case() {
        let target = std::env::temp_dir().join(crate::random_id("sidekick-lock-case").unwrap());
        let upper = PathBuf::from(target.to_string_lossy().to_ascii_uppercase());
        let owner = PathLocks::acquire(&[target], "case-test").unwrap();
        assert!(PathLocks::acquire(&[upper], "case-test").is_err());
        drop(owner);
    }

    /// Windows case-insensitivity is Unicode-wide, not ASCII-only. Two
    /// spellings that differ only by non-ASCII case must share one lock.
    #[test]
    fn target_locks_normalize_unicode_path_case() {
        let target = std::env::temp_dir().join(crate::random_id("sidekick-lock-é-Δ").unwrap());
        let upper = PathBuf::from(target.to_string_lossy().to_uppercase());
        // Guard the regression itself: ASCII-only folding leaves these distinct.
        assert_ne!(target.to_string_lossy().to_ascii_lowercase(), upper.to_string_lossy().to_ascii_lowercase());
        let owner = PathLocks::acquire(&[target], "unicode-case-test").unwrap();
        assert!(PathLocks::acquire(&[upper], "unicode-case-test").is_err());
        drop(owner);
    }

    #[test]
    fn ordinal_upper_folds_non_ascii_case_pairs() {
        assert_eq!(windows_ordinal_upper("café-δ").unwrap(), windows_ordinal_upper("CAFÉ-Δ").unwrap());
        assert_eq!(windows_ordinal_upper("C:\\\\Apps\\\\SidekickAI").unwrap(), windows_ordinal_upper("c:\\\\apps\\\\sidekickai").unwrap());
    }

    /// An empty path has no case identity to derive and is accepted as empty;
    /// every nonempty path either maps or fails, never silently keeps its text.
    #[test]
    fn ordinal_upper_never_falls_back_to_the_original_text() {
        assert_eq!(windows_ordinal_upper("").unwrap(), "");
        let identity = windows_ordinal_upper("C:\\ä").unwrap();
        assert_ne!(identity, "C:\\ä");
    }
}
