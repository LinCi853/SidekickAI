// scope —— 跨进程锁与显式清理目标
use std::path::{Path, PathBuf};

use sidekickai_uninstall_core::lock::PathLocks;
use sidekickai_uninstall_core::path::{
    normalize_absolute_path, path_is_same_or_descendant, paths_equal, validate_tree,
};
use sidekickai_uninstall_core::protocol::{UninstallError, UninstallErrorCode};
use sidekickai_uninstall_host::data_paths_for;

use crate::manifest::InstallRequest;

use super::scan::is_valid_install;

// ============================================================================
// Operation scope: cross-process locks and explicit cleanup targets
// ============================================================================

/// Paths one install, repair or configuration write owns. Cleanup directories
/// are only the explicit, independently confirmed SidekickAI installations the
/// caller asked to remove; nothing is inferred from a directory name.
#[derive(Debug)]
pub(crate) struct OperationScope {
    pub(crate) install_dir: PathBuf,
    pub(crate) lock_paths: Vec<PathBuf>,
    pub(crate) cleanup_dirs: Vec<PathBuf>,
    pub(crate) legacy_identity: Option<super::legacy::LegacyIdentity>,
}

/// Environment locations that must never be replaced or deleted wholesale.
pub(crate) const PROTECTED_LOCATIONS: [&str; 7] = [
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "SystemRoot",
];

/// Normalize a directory the engine may replace or delete: relative paths,
/// filesystem roots, reparse points and protected system/profile locations are
/// rejected. The install target is validated exactly like a cleanup path.
pub(crate) fn normalize_owned_dir(raw: &str, what: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("{what}必须是绝对路径：{raw}"));
    }
    let normalized = normalize_absolute_path(path)
        .map_err(|e| format!("{what}不安全（{raw}）：{}", e.message))?
        .as_path()
        .to_path_buf();
    if normalized.parent().is_none() {
        return Err(format!("拒绝使用磁盘根目录作为{what}：{}", normalized.display()));
    }
    for key in PROTECTED_LOCATIONS {
        if let Some(base) = std::env::var_os(key) {
            let base = Path::new(&base);
            // Equality protects the location itself; the ancestor check protects
            // a parent such as C:\Users that would contain the profile.
            if paths_equal(&normalized, base) || path_is_same_or_descendant(base, &normalized) {
                return Err(format!("拒绝使用受保护的系统位置作为{what}：{}", normalized.display()));
            }
        }
    }
    Ok(normalized)
}

/// A data directory is outside program cleanup regardless of its mode marker.
pub(crate) fn portable_user_data(dir: &Path) -> Option<PathBuf> {
    match portable_state_paths(dir) {
        Ok(paths) => paths.into_iter().find(|path| path.file_name().is_some_and(|name| name != "portable.txt")),
        Err(_) => Some(dir.to_path_buf()),
    }
}

/// Preserve unknown data sidecars conservatively; this is not deletion authority.
pub(crate) fn portable_state_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.exists() { return Ok(Vec::new()); }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| format!("无法检查用户数据：{error}"))? {
        let entry = entry.map_err(|error| format!("无法检查用户数据：{error}"))?;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name == "data" || name.starts_with("data.") || name == "portable.txt" { paths.push(entry.path()); }
    }
    Ok(paths)
}

pub(crate) fn acquired_resource_path(root: &Path) -> Result<Option<PathBuf>, String> {
    let mut path = root.to_path_buf();
    for name in ["resources", "cloud"] {
        let mut found = None;
        for entry in std::fs::read_dir(&path).map_err(|error| format!("无法检查已获取资源：{error}"))? {
            let entry = entry.map_err(|error| format!("无法检查已获取资源：{error}"))?;
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
                if found.replace(entry.path()).is_some() {
                    return Err("已获取资源路径存在重复名称，原内容已保留。".into());
                }
            }
        }
        let Some(next) = found else { return Ok(None); };
        let metadata = std::fs::symlink_metadata(&next).map_err(|error| format!("无法核验已获取资源：{error}"))?;
        if !metadata.is_dir() { return Err("已获取资源路径不是普通目录，原内容已保留。".into()); }
        sidekickai_uninstall_core::path::reject_reparse_points(&next).map_err(|error| error.message)?;
        path = next;
    }
    Ok(Some(path))
}

pub(crate) fn move_portable_state(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in portable_state_paths(source)? {
        let target = destination.join(entry.file_name().ok_or("用户数据路径无效")?);
        if target.exists() { return Err(format!("用户数据存在冲突，已保留原目录：{}", entry.display())); }
        std::fs::rename(&entry, &target).map_err(|error| format!("无法保留用户数据：{error}"))?;
    }
    Ok(())
}

pub(crate) fn prepare_operation_scope(
    req: &InstallRequest,
    roaming: Option<&Path>,
) -> Result<OperationScope, String> {
    prepare_operation_scope_with_hooks(req, roaming, &super::pipeline::EngineHooks::default())
}

pub(crate) fn prepare_operation_scope_with_hooks(
    req: &InstallRequest,
    roaming: Option<&Path>,
    hooks: &super::pipeline::EngineHooks,
) -> Result<OperationScope, String> {
    let install_dir = normalize_owned_dir(&req.install_dir, "安装目录")?;
    let root = if req.for_all_users { "HKLM" } else { "HKCU" };
    let registration = if install_dir.exists() && !sidekickai_uninstall_core::product::owns_installation(&install_dir) {
        super::registry::read_install_registration(&hooks.registration_key(root), root)?
    } else { None };
    sidekickai_uninstall_core::product::validate_destination_with_registration(&install_dir, registration.as_ref())?;
    let legacy_identity = if install_dir.is_dir() && std::fs::read_dir(&install_dir).map_err(|error| error.to_string())?.next().is_some() {
        super::legacy::admit(&install_dir, root, hooks)?
    } else { None };
    let mut cleanup_dirs: Vec<PathBuf> = Vec::new();
    for raw in &req.cleanup_paths {
        let dir = normalize_owned_dir(raw, "清理路径")?;
        if paths_equal(&dir, &install_dir)
            || path_is_same_or_descendant(&dir, &install_dir)
            || path_is_same_or_descendant(&install_dir, &dir)
        {
            return Err(format!("清理路径与安装目标重叠：{}", dir.display()));
        }
        // An explicit cleanup path is user-confirmed: a directory that is not a
        // genuine installation must be reported, never silently skipped.
        if !is_valid_install(&dir) {
            return Err(format!(
                "清理路径不是有效的 SidekickAI 安装，已中止安装：{}",
                dir.display()
            ));
        }
        // Validate the whole tree, not only the root: a reparse point anywhere
        // inside would make the removal leave its real target behind.
        validate_tree(&dir)
            .map_err(|e| format!("清理路径不安全（{}）：{}", dir.display(), e.message))?;
        sidekickai_uninstall_core::product::validate_legacy_recovery(&dir)?;
        sidekickai_uninstall_core::product::validate_installation_boundaries(&dir)?;
        sidekickai_uninstall_core::distribution::verify_installed_identity(&dir)?;
        if let Some(data) = portable_user_data(&dir) {
            super::write_log(&format!("W|保留了包含用户数据的安装：{}", data.display()));
            continue;
        }
        cleanup_dirs.push(dir);
    }
    // Shared data-root probes keep the installer and the uninstall worker on the
    // same lock names for the same user-data directories.
    let mut lock_paths = vec![install_dir.clone()];
    lock_paths.extend(cleanup_dirs.iter().cloned());
    lock_paths.extend(data_paths_for(&install_dir, roaming).map_err(|error| error.message)?);
    Ok(OperationScope { install_dir, lock_paths, cleanup_dirs, legacy_identity })
}

pub(crate) fn verify_legacy_unchanged(previous: &OperationScope, current: &OperationScope) -> Result<(), String> {
    if previous.legacy_identity.is_some() && previous.legacy_identity != current.legacy_identity {
        return Err("旧安装身份在维护期间发生变化，已中止替换。请检查原安装后重试。".into());
    }
    Ok(())
}

/// Acquire the controller lock first and then the worker lock, holding both for
/// the whole operation. Failure to acquire either role is propagated, never
/// swallowed: a lock that is not held must not look like protection.
pub(crate) fn acquire_operation_locks(paths: &[PathBuf]) -> Result<(PathLocks, PathLocks), String> {
    let controller = PathLocks::acquire(paths, "controller").map_err(lock_error_message)?;
    let worker = PathLocks::acquire(paths, "worker").map_err(lock_error_message)?;
    Ok((controller, worker))
}

pub(crate) fn lock_error_message(error: UninstallError) -> String {
    match error.code {
        UninstallErrorCode::AlreadyRunning => {
            "检测到另一个安装或卸载操作正在使用该安装位置，请等待其完成或关闭后重试。".to_string()
        }
        _ => format!("无法锁定安装位置：{}", error.message),
    }
}
