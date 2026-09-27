//! Uninstall registration and shortcut cleanup.

use sidekickai_uninstall_core::path::paths_equal;
use std::fs;
use std::path::{Path, PathBuf};

/// Compare a registry `InstallLocation` with the removed installation. A
/// trailing separator is normalized (Windows treats `C:\Apps\X\` and `C:\Apps\X`
/// as one directory) and the comparison uses the same ordinal, whole-Unicode
/// path identity as the rest of the worker, but surrounding whitespace is never
/// silently trimmed: a padded value does not prove ownership and is therefore
/// not a match.
#[cfg(windows)]
pub(super) fn install_location_matches(registered: &str, install: &Path) -> bool {
    if registered.is_empty() || registered.trim() != registered {
        return false;
    }
    let registered = registered.trim_end_matches(['\\', '/']);
    let install = install.to_string_lossy();
    let install = install.trim_end_matches(['\\', '/']);
    !registered.is_empty() && paths_equal(Path::new(registered), Path::new(install))
}

#[cfg(windows)]
pub(super) fn remove_registration(root: &str, install: &Path) -> Result<bool, String> {
    use winreg::{RegKey, enums::*};
    let hive = match root {
        "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        _ => return Err(format!("不支持清理的注册表根：{root}")),
    };
    let mut removed = false;
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let parent = match hive.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ | KEY_WRITE | view) {
            Ok(parent) => parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        removed |= remove_matching_registrations(&parent, install, view)?;
    }
    Ok(removed)
}

#[cfg(windows)]
pub(super) fn remove_matching_registrations(parent: &winreg::RegKey, install: &Path, view: u32) -> Result<bool, String> {
    use winreg::enums::KEY_READ;
    let keys = parent.enum_keys().collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut removed = false;
    for name in keys {
        let key = match parent.open_subkey_with_flags(&name, KEY_READ | view) { Ok(key) => key, Err(_) => continue };
        let location: String = key.get_value("InstallLocation").unwrap_or_default();
        let command: String = key.get_value("UninstallString").unwrap_or_default();
        if !install_location_matches(&location, install)
            || !crate::discovery::uninstall_command_matches(&command, &install.join("uninstall.exe")) { continue; }
        drop(key);
        parent.delete_subkey_all(&name).map_err(|error| error.to_string())?;
        removed = true;
    }
    Ok(removed)
}

#[cfg(not(windows))]
pub(super) fn remove_registration(_root: &str, _install: &Path) -> Result<bool, String> {
    Err("注册表清理仅在 Windows 上实现。".into())
}

/// Remove a registration only when the stored `InstallLocation` is present and
/// explicitly matches the installation that was just removed. A missing value
/// means the key does not prove ownership and is left intact; a permission or
/// hives error is reported instead of being mistaken for "not found".
///
/// The key name is a parameter so tests can exercise the destructive logic
/// against a dedicated fixture key instead of the production registration.
#[cfg(all(windows, test))]
pub(super) fn remove_registration_key(root: &str, key_name: &str, install: &Path) -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hive = match root {
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
        other => return Err(format!("不支持清理的注册表根：{other}")),
    };
    let mut removed = false;
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let parent = match hive.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ | KEY_WRITE | view) {
            Ok(parent) => parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法打开 {root} 卸载注册列表：{error}")),
        };
        let key = match parent.open_subkey_with_flags(key_name, KEY_READ | KEY_WRITE | view) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法打开 {root} 卸载注册项：{error}")),
        };
        let registered: String = match key.get_value("InstallLocation") {
            Ok(value) => value,
            // No explicit location: the key does not prove ownership of this
            // installation, so it is never deleted on a name match alone.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                drop(key);
                continue;
            }
            Err(error) => return Err(format!("无法读取 {root} InstallLocation：{error}")),
        };
        drop(key);
        if registered.trim().is_empty() {
            continue;
        }
        // Trailing separators and case are normalized; surrounding whitespace is
        // not silently trimmed, since a padded value does not prove ownership.
        if !install_location_matches(&registered, install) {
            // The key belongs to another installation; leave it intact.
            continue;
        }
        parent.delete_subkey_all(key_name).map_err(|error| format!("无法删除 {root} 卸载注册项：{error}"))?;
        removed = true;
    }
    Ok(removed)
}

#[cfg(all(not(windows), test))]
fn remove_registration_key(_root: &str, _key_name: &str, _install: &Path) -> Result<bool, String> {
    Err("注册表清理仅在 Windows 上实现。".into())
}

/// Cleanup uses the identity captured before the installation was removed.
#[cfg(windows)]
pub(crate) fn remove_shortcuts_for(install: &Path, all_users: bool, edition: &sidekickai_uninstall_core::product::Edition) -> Result<(), String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    let targets = [install.join("SidekickAI.exe"), install.join(&edition.legacy_executable)];
    let mut candidates = Vec::new();
    // The worker runs as the same user as the caller (enforced above), so its
    // APPDATA/USERPROFILE describe the account that owned the per-user install.
    let (desktop, start_menu) = if all_users {
        (std::env::var("PUBLIC").map(|p| PathBuf::from(p).join("Desktop")), std::env::var("ProgramData").map(|p| PathBuf::from(p).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("SidekickAI")))
    } else {
        (std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Desktop")), std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("SidekickAI")))
    };
    if let Ok(desktop) = desktop {
        candidates.extend(sidekickai_uninstall_core::product::shortcut_names_for(edition).into_iter().map(|name| desktop.join(name)));
    }
    if let Ok(start_menu) = start_menu {
        candidates.extend(sidekickai_uninstall_core::product::shortcut_names_for(edition).into_iter().map(|name| start_menu.join(name)));
        if let Some(parent) = start_menu.parent() {
            for directory in edition.install_directories() {
                let legacy_menu = parent.join(directory);
                candidates.extend(sidekickai_uninstall_core::product::shortcut_names_for(edition).into_iter().map(|name| legacy_menu.join(name)));
            }
        }
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    for link_path in candidates {
        if !link_path.is_file() {
            continue;
        }
        // Never delete by file name alone: the shortcut must resolve to this
        // installation's executable.
        if !targets.iter().any(|target| shortcut_points_to(&link_path, target)) {
            continue;
        }
        fs::remove_file(&link_path).map_err(|e| format!("无法删除 {}：{e}", link_path.display()))?;
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn shortcut_points_to(link_path: &Path, expected: &Path) -> bool {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IPersistFile, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let wide: Vec<u16> = link_path.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return false;
        }
        let Ok(link) = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER) else {
            return false;
        };
        let Ok(persist) = link.cast::<IPersistFile>() else {
            return false;
        };
        if persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).is_err() {
            return false;
        }
        let mut buffer = [0u16; 1024];
        if link.GetPath(&mut buffer, std::ptr::null_mut(), 0).is_err() {
            return false;
        }
        let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        let resolved = String::from_utf16_lossy(&buffer[..length]);
        paths_equal(Path::new(&resolved), expected)
    }
}

#[cfg(not(windows))]
pub(crate) fn remove_shortcuts_for(_install: &Path, _all_users: bool, _edition: &sidekickai_uninstall_core::product::Edition) -> Result<(), String> {
    Err("快捷方式清理仅在 Windows 上实现。".into())
}
