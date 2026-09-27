// shortcuts —— 桌面/开始菜单快捷方式创建与按目标删除
use std::fs;
use std::path::{Path, PathBuf};

use sidekickai_uninstall_core::path::paths_equal;

use crate::elevate;

use super::pipeline::EngineHooks;
use super::write_log;

pub(crate) fn desktop_dir(for_all_users: bool) -> PathBuf {
    let key = if for_all_users { "PUBLIC" } else { "USERPROFILE" };
    let base = std::env::var(key).unwrap_or_else(|_| "C:\\Users\\Public".into());
    PathBuf::from(base).join("Desktop")
}

pub(crate) fn start_menu_dir(for_all_users: bool) -> PathBuf {
    let key = if for_all_users { "ProgramData" } else { "APPDATA" };
    let base = std::env::var(key).unwrap_or_default();
    PathBuf::from(base)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("SidekickAI")
}

pub(crate) fn create_shortcuts(hooks: &EngineHooks, for_all_users: bool, dir: &Path) {
    let exe = dir.join("SidekickAI.exe");
    let target = exe.to_string_lossy().into_owned();
    let workdir = dir.to_string_lossy().into_owned();
    let directories = [hooks.desktop_dir(for_all_users), hooks.start_menu_dir(for_all_users)];
    let links: Vec<PathBuf> = directories.iter().filter_map(|directory| {
        sidekickai_uninstall_core::product::shortcut_names().into_iter().map(|name| directory.join(name))
            .find(|link| !link.exists() || shortcut_points_to(link, &exe))
    }).collect();
    for link in &links {
        if let Some(p) = link.parent() {
            let _ = fs::create_dir_all(p);
        }
        let _ = create_shortcut(link, &target, &workdir);
    }
}

fn owned_shortcut_directories(hooks: &EngineHooks, for_all_users: bool) -> Vec<PathBuf> {
    let start_menu = hooks.start_menu_dir(for_all_users);
    let mut directories = vec![hooks.desktop_dir(for_all_users), start_menu.clone()];
    if hooks.start_menu.is_none() && sidekickai_uninstall_core::product::edition_id() == "concept" {
        if let Some(parent) = start_menu.parent() {
            directories.extend(sidekickai_uninstall_core::product::edition().install_directories().map(|name| parent.join(name)));
        }
    }
    directories
}

/// Keep historical executable paths runnable until shortcut migration succeeds.
pub(crate) fn prepare_legacy_alias(backup: Option<&Path>, dir: &Path) -> Result<(), String> {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable
        || !backup.is_some_and(|backup| backup.join(&edition.legacy_executable).is_file()) { return Ok(()); }
    super::validate::validate_core(dir)?;
    let current = dir.join(&product.executable);
    let legacy = dir.join(&edition.legacy_executable);
    sidekickai_uninstall_core::path::reject_reparse_points(&legacy).map_err(|error| error.message)?;
    if !legacy.exists() {
        let mut input = fs::File::open(&current).map_err(|error| error.to_string())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&legacy).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|error| format!("无法保留历史程序入口：{error}"))?;
        output.sync_all().map_err(|error| format!("无法保存历史程序入口：{error}"))?;
    }
    if !super::validate::paths_have_same_content(&current, &legacy) {
        return Err("历史程序入口与当前完整运行库不一致。".into());
    }
    Ok(())
}

/// A historical entry is retired only after its replacement resolves correctly.
pub(crate) fn migrate_legacy_shortcuts(hooks: &EngineHooks, for_all_users: bool, dir: &Path) -> Result<(), String> {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable { return Ok(()); }
    let legacy = dir.join(&edition.legacy_executable);
    let current = dir.join(&product.executable);
    if !current.is_file() { return Err("新程序入口不可用，已保留历史入口。".into()); }
    let directories = owned_shortcut_directories(hooks, for_all_users);
    for directory in directories {
        let new_directory = if directory == hooks.desktop_dir(for_all_users) { directory.clone() } else { hooks.start_menu_dir(for_all_users) };
        for name in sidekickai_uninstall_core::product::owned_shortcut_names() {
            let old_link = directory.join(name);
            if !old_link.is_file() || !shortcut_points_to(&old_link, &legacy) { continue; }
            let new_link = sidekickai_uninstall_core::product::shortcut_names().into_iter()
                .map(|name| new_directory.join(name))
                .find(|link| !link.exists() || shortcut_points_to(link, &current))
                .ok_or("没有可用的快捷方式名称，已保留历史入口。")?;
            fs::create_dir_all(&new_directory).map_err(|error| format!("无法创建快捷方式目录：{error}"))?;
            create_shortcut(&new_link, &current.to_string_lossy(), &dir.to_string_lossy())?;
            if !shortcut_points_to(&new_link, &current) { return Err("新快捷方式校验失败，已保留历史入口。".into()); }
            fs::remove_file(&old_link).map_err(|error| format!("无法移除已迁移的快捷方式：{error}"))?;
        }
        if directory != new_directory { let _ = fs::remove_dir(&directory); }
    }
    if legacy.is_file() {
        sidekickai_uninstall_core::path::reject_reparse_points(&legacy).map_err(|error| error.message)?;
        fs::remove_file(&legacy).map_err(|error| format!("无法移除历史程序入口：{error}"))?;
    }
    Ok(())
}

pub(crate) fn create_shortcut(lnk: &Path, target: &str, workdir: &str) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let target_w = elevate::wide(target);
    let workdir_w = elevate::wide(workdir);
    let lnk_w = elevate::wide(&lnk.to_string_lossy());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建快捷方式失败：{}", e))?;
        link.SetPath(PCWSTR(target_w.as_ptr()))
            .map_err(|e| format!("SetPath 失败：{}", e))?;
        link.SetWorkingDirectory(PCWSTR(workdir_w.as_ptr())).ok();
        let pf: IPersistFile = link.cast().map_err(|e| format!("cast IPersistFile 失败：{}", e))?;
        pf.Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("保存快捷方式失败：{}", e))?;
    }
    Ok(())
}

/// Remove only the shortcuts whose recorded target is exactly this
/// installation's executable. The Start Menu folder is never removed
/// recursively, and no shortcut is ever deleted by file name alone.
pub(crate) fn remove_shortcuts(hooks: &EngineHooks, for_all_users: bool, install_dir: &Path) {
    let expected = [install_dir.join("SidekickAI.exe"), install_dir.join(&sidekickai_uninstall_core::product::edition().legacy_executable)];
    let directories = owned_shortcut_directories(hooks, for_all_users);
    for link in directories.iter().flat_map(|directory| sidekickai_uninstall_core::product::owned_shortcut_names().into_iter().map(move |name| directory.join(name))) {
        if !link.is_file() || !expected.iter().any(|target| shortcut_points_to(&link, target)) {
            continue;
        }
        if let Err(error) = fs::remove_file(&link) {
            write_log(&format!("W|无法删除快捷方式 {}：{}", link.display(), error));
        }
    }
}

/// Resolve a `.lnk` file's target with the Shell Link COM interface.
pub(crate) fn shortcut_target(link_path: &Path) -> Option<PathBuf> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let wide: Vec<u16> = link_path.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist = link.cast::<IPersistFile>().ok()?;
        persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let mut buffer = [0u16; 1024];
        link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;
        let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        if length == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
    }
}

/// Compare a shortcut's recorded target with the expected executable. The same
/// file can be spelled with its 8.3 short name or a different case, so a
/// canonical-path comparison is used when both sides exist.
pub(crate) fn shortcut_points_to(link_path: &Path, expected: &Path) -> bool {
    let Some(resolved) = shortcut_target(link_path) else {
        return false;
    };
    if paths_equal(&resolved, expected) {
        return true;
    }
    match (fs::canonicalize(&resolved), fs::canonicalize(expected)) {
        (Ok(resolved), Ok(expected)) => paths_equal(&resolved, &expected),
        _ => false,
    }
}
