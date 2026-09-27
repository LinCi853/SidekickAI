use std::path::Path;
use sidekickai_uninstall_core::path::{normalize_target_path, paths_equal};

pub(super) fn verified(roaming: Option<&Path>) -> bool {
    let Some(roaming) = roaming.filter(|path| normalize_target_path(path).is_ok()) else { return false; };
    let known = known_roaming();
    let process_sid = crate::execute::current_user_sid().ok();
    let elevated = crate::execute::is_process_elevated();
    let shell_sid = if elevated { shell_user_sid() } else { None };
    owns_profile(elevated, process_sid.as_deref(), shell_sid.as_deref(), Some(roaming), known.as_deref())
}

fn owns_profile(
    elevated: bool,
    process_sid: Option<&str>,
    shell_sid: Option<&str>,
    roaming: Option<&Path>,
    known_roaming: Option<&Path>,
) -> bool {
    let (Some(process_sid), Some(roaming), Some(known_roaming)) = (process_sid, roaming, known_roaming) else { return false; };
    !process_sid.is_empty() && paths_equal(roaming, known_roaming)
        && (!elevated || shell_sid == Some(process_sid))
}

#[cfg(windows)]
fn known_roaming() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_RoamingAppData, KF_FLAG_DONT_VERIFY};
    unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DONT_VERIFY, None).ok()?;
        let path = raw.to_string().ok().map(std::path::PathBuf::from);
        CoTaskMemFree(Some(raw.0.cast()));
        path
    }
}

#[cfg(windows)]
fn shell_user_sid() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};
    unsafe {
        let shell = GetShellWindow();
        if shell.0.is_null() { return None; }
        let mut pid = 0;
        GetWindowThreadProcessId(shell, Some(&mut pid));
        if pid == 0 { return None; }
        crate::execute::process_user_sid(pid).ok()
    }
}

#[cfg(not(windows))]
fn known_roaming() -> Option<std::path::PathBuf> { None }

#[cfg(not(windows))]
fn shell_user_sid() -> Option<String> { None }

#[cfg(test)]
pub(super) fn verified_fixture(elevated: bool, process_sid: &str, shell_sid: &str, roaming: &Path) -> bool {
    owns_profile(elevated, Some(process_sid), Some(shell_sid), Some(roaming), Some(roaming))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_account_elevation_preserves_profile_ownership() {
        let roaming = Path::new(r"C:\Users\Owner\AppData\Roaming");
        assert!(owns_profile(true, Some("owner"), Some("owner"), Some(roaming), Some(roaming)));
    }

    #[test]
    fn unknown_or_different_accounts_and_profiles_are_untrusted() {
        let roaming = Path::new(r"C:\Users\Owner\AppData\Roaming");
        let foreign = Path::new(r"C:\Users\Other\AppData\Roaming");
        assert!(!owns_profile(true, Some("admin"), Some("owner"), Some(roaming), Some(roaming)));
        assert!(!owns_profile(true, Some("owner"), None, Some(roaming), Some(roaming)));
        assert!(!owns_profile(false, None, None, Some(roaming), Some(roaming)));
        assert!(!owns_profile(false, Some("owner"), None, Some(foreign), Some(roaming)));
        assert!(!owns_profile(false, Some("owner"), None, None, Some(roaming)));
        assert!(!owns_profile(false, Some("owner"), None, Some(roaming), None));
        assert!(owns_profile(false, Some("owner"), None, Some(roaming), Some(roaming)));
    }

    #[cfg(windows)]
    #[test]
    fn windows_profile_probe_matches_the_process_account() {
        let known = known_roaming().expect("Windows must resolve this test account's roaming directory");
        let roaming = std::env::var_os("APPDATA").map(std::path::PathBuf::from).unwrap();
        assert!(paths_equal(&known, &roaming));
        let sid = crate::execute::current_user_sid().unwrap();
        let expected = !crate::execute::is_process_elevated() || shell_user_sid().as_deref() == Some(sid.as_str());
        assert_eq!(verified(Some(&roaming)), expected);
        assert!(!verified(Some(&std::env::temp_dir())));
    }
}
