// deploy —— 同卷备份/提交/替换与回滚
use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest;

use super::payload::clear_readonly_attributes;
use super::validate::validate_uninstaller;
use super::product_version;

/// A same-volume sibling path used for staged backups. The path is not created:
/// a backup is produced by renaming the old directory onto it, which is atomic
/// within one volume and therefore can never leave a half-written backup.
pub(crate) fn unique_sibling_path(anchor: &Path, prefix: &str) -> Result<PathBuf, String> {
    for attempt in 0..64u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let candidate = anchor.join(format!("{prefix}-{}-{nanos}-{attempt}", std::process::id()));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("无法在安装目录所在磁盘上分配唯一的暂存目录（{prefix}）"))
}

/// Same-volume move: rename only. A failed rename leaves both sides untouched
/// and is reported, so a partial backup can never masquerade as a valid one.
pub(crate) fn move_within_volume(src: &Path, dst: &Path) -> Result<(), String> {
    fs::rename(src, dst).map_err(|e| format!("重命名 {} 到 {} 失败：{}", src.display(), dst.display(), e))
}

/// Move the already-verified staging directory into place. A cross-volume rename
/// falls back to a plain copy, and a failed copy removes the partial destination
/// so the caller only ever rolls back to the same-volume backup.
pub(crate) fn commit_staged(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            if let Err(error) = copy_dir(src, dst) {
                if !super::transaction::active() { let _ = fs::remove_dir_all(dst); }
                return Err(error);
            }
            remove_path(src).map_err(|e| format!("无法清理临时解压目录：{e}"))
        }
    }
}

/// 迭代复制目录，避免 Electron 目录层级较深时递归调用导致栈溢出。
pub(crate) fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let mut pending = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((current_src, current_dst)) = pending.pop() {
        fs::create_dir_all(&current_dst)
            .map_err(|e| format!("无法创建目录 {}：{}", current_dst.display(), e))?;
        for entry in fs::read_dir(&current_src)
            .map_err(|e| format!("无法读取目录 {}：{}", current_src.display(), e))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let ty = entry
                .file_type()
                .map_err(|e| format!("无法读取文件类型 {}：{}", entry.path().display(), e))?;
            let from = entry.path();
            let to = current_dst.join(entry.file_name());
            if ty.is_dir() {
                pending.push((from, to));
            } else {
                fs::copy(&from, &to)
                    .map_err(|e| format!("无法复制 {} 到 {}：{}", from.display(), to.display(), e))?;
            }
        }
    }
    Ok(())
}

pub(crate) const UNINSTALLER_PAIR: [&str; 2] = ["uninstall.exe", "uninstall-manifest.json"];
#[cfg(test)]
pub(crate) const CORE_ITEMS: [&str; 2] = ["SidekickAI.exe", "resources"];

/// The verified payload owns every program root and each resource child, while
/// downloaded cloud resources and local configuration remain installation state.
pub(crate) fn program_items(payload: &Path) -> Result<Vec<String>, String> {
    sidekickai_uninstall_core::path::validate_tree(payload).map_err(|error| error.message)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(payload).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().into_string().map_err(|_| "安装载荷名称无效")?;
        let lower = name.to_ascii_lowercase();
        if UNINSTALLER_PAIR.contains(&lower.as_str()) { continue; }
        if lower == "data" || lower.starts_with("data.") || matches!(lower.as_str(),
            "portable.txt" | "install-receipt.json" | "install-config.json" | "oxy-service.json" | "plugins-manifest.json") {
            return Err(format!("程序载荷包含本地状态：{name}"));
        }
        if lower == "resources" {
            for child in fs::read_dir(entry.path()).map_err(|error| error.to_string())? {
                let child = child.map_err(|error| error.to_string())?;
                let name = child.file_name().into_string().map_err(|_| "安装资源名称无效")?;
                if name.eq_ignore_ascii_case("cloud") { continue; }
                names.push(format!("resources/{name}"));
            }
        } else {
            if lower == "maintenance" && entry.path().join("distribution-receipt.json").exists() {
                return Err("程序载荷包含本地发行记录。".into());
            }
            names.push(name);
        }
    }
    names.sort();
    if !names.iter().any(|name| name == "SidekickAI.exe") || !names.iter().any(|name| name == "resources/app.asar") {
        return Err("程序载荷缺少主程序或应用资源".into());
    }
    Ok(names)
}

pub(crate) fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("无法删除目录 {}：{}", path.display(), e))
    } else {
        fs::remove_file(path).map_err(|e| format!("无法删除文件 {}：{}", path.display(), e))
    }
}

/// Remove a path (and its read-only attribute) checking the outcome, so a
/// failed cleanup is never reported as a successful rollback.
pub(crate) fn remove_path_checked(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    clear_readonly_attributes(path);
    remove_path(path)
}

/// Restore exactly the names that were moved into the backup. A name that was
/// never moved is left untouched, and every restore failure is returned so a
/// partial rollback is never described as a recovery.
pub(crate) fn restore_replaced(install_dir: &Path, backup_dir: &Path, moved: &[String]) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    for name in moved {
        let target = install_dir.join(name);
        let saved = backup_dir.join(name);
        if target.exists() {
            if let Err(error) = remove_path_checked(&target) {
                failures.push(format!("无法移除 {name} 的新副本：{error}"));
                continue;
            }
        }
        if let Err(error) = move_within_volume(&saved, &target) {
            failures.push(format!("无法恢复 {name}：{error}"));
        }
    }
    if failures.is_empty() { Ok(()) } else { Err(failures.join("；")) }
}

pub(crate) fn rollback_message(action: &str, error: &str, restore: Result<(), String>, backup_dir: &Path) -> String {
    match restore {
        Ok(()) => format!("{action}：{error}（已恢复原有文件）"),
        Err(restore_error) => format!(
            "{action}：{error}（恢复原有文件失败：{restore_error}；备份保留在 {}）",
            backup_dir.display()
        ),
    }
}

/// Replace `names` inside `install_dir` from `source_dir` in one recoverable
/// transaction: the previous copies move by rename into a same-volume sibling
/// backup, the new copies are written, and `verify` runs before the backup is
/// discarded. Only names whose previous copy was actually moved are restored, so
/// a failed move can never turn a partial backup into a "valid" recovery.
pub(crate) fn replace_from_payload(
    install_dir: &Path,
    source_dir: &Path,
    names: &[&str],
    verify: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let sources = names.iter().map(|name| (*name, *name)).collect::<Vec<_>>();
    replace_from_sources(install_dir, source_dir, &sources, verify)
}

/// Source mappings let executable aliases participate in the same rollback.
pub(crate) fn replace_from_sources(
    install_dir: &Path,
    source_dir: &Path,
    sources: &[(&str, &str)],
    verify: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut unique = std::collections::HashSet::new();
    for (name, source_name) in sources {
        for relative in [Path::new(name), Path::new(source_name)] {
            if relative.as_os_str().is_empty() || !relative.components().all(|part| matches!(part, std::path::Component::Normal(_))) {
                return Err("程序替换路径必须位于安装目录内".into());
            }
        }
        if !unique.insert(name.to_ascii_lowercase()) { return Err("程序替换目标重复。".into()); }
        let source = source_dir.join(source_name);
        let target = install_dir.join(name);
        sidekickai_uninstall_core::path::reject_reparse_points(&source).map_err(|error| error.message)?;
        sidekickai_uninstall_core::path::reject_reparse_points(&target).map_err(|error| error.message)?;
        if target.is_dir() {
            sidekickai_uninstall_core::path::validate_tree(&target).map_err(|error| error.message)?;
        }
    }
    let parent = install_dir.parent().ok_or("无效的安装目录")?;
    let backup_dir = unique_sibling_path(parent, "SidekickAI-Replace")?;
    super::transaction::retain(&backup_dir)?;
    fs::create_dir(&backup_dir)
        .map_err(|e| format!("无法创建暂存目录 {}：{}", backup_dir.display(), e))?;
    super::transaction::bind_retained(&backup_dir)?;

    let existed: Vec<(String, String, bool)> = sources
        .iter()
        .map(|(name, source)| ((*name).to_string(), (*source).to_string(), install_dir.join(name).exists()))
        .collect();
    let mut moved: Vec<String> = Vec::new();
    let mut planned = Vec::new();
    for (name, _, present) in &existed {
        if !present { continue; }
        if let Some(parent) = backup_dir.join(name).parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法准备程序备份：{error}"))?;
        }
        planned.push((install_dir.join(name), PathBuf::from(name)));
    }
    super::transaction::prepare_retained_moves(&backup_dir, &planned)?;

    let staged = (|| -> Result<(), String> {
        for (name, _, present) in &existed {
            if !*present {
                continue;
            }
            move_within_volume(&install_dir.join(name), &backup_dir.join(name))
                .map_err(|e| format!("无法备份 {name}：{e}"))?;
            moved.push(name.clone());
        }
        Ok(())
    })();
    if let Err(error) = staged {
        if super::transaction::active() { return Err(error); }
        let restore = restore_replaced(install_dir, &backup_dir, &moved);
        if restore.is_ok() {
            let _ = fs::remove_dir_all(&backup_dir);
        }
        return Err(rollback_message("替换文件失败", &error, restore, &backup_dir));
    }
    super::transaction::seal_retained(&backup_dir)?;

    let deploy = (|| -> Result<(), String> {
        for (name, source, _) in &existed {
            let src = source_dir.join(source);
            if !src.exists() {
                return Err(format!("安装载荷缺少 {name}"));
            }
            let target = install_dir.join(name);
            if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
            if let Err(error) = super::transaction::copy_durable(&src, &target) {
                // Only the new copy is affected; the previous copy is still in
                // the backup and is restored below.
                if !super::transaction::active() { let _ = remove_path_checked(&install_dir.join(name)); }
                return Err(format!("部署 {name} 失败：{error}"));
            }
        }
        verify()
    })();
    match deploy {
        Ok(()) => {
            if !super::transaction::active() { let _ = fs::remove_dir_all(&backup_dir); }
            Ok(())
        }
        Err(error) => {
            if super::transaction::active() { return Err(error); }
            let mut failures = Vec::new();
            for (name, _, present) in &existed {
                if !present {
                    if let Err(error) = remove_path_checked(&install_dir.join(name)) { failures.push(error); }
                }
            }
            if let Err(error) = restore_replaced(install_dir, &backup_dir, &moved) { failures.push(error); }
            let restore = if failures.is_empty() { Ok(()) } else { Err(failures.join("；")) };
            if restore.is_ok() {
                let _ = fs::remove_dir_all(&backup_dir);
            }
            Err(rollback_message("替换文件失败", &error, restore, &backup_dir))
        }
    }
}

/// Replace the deployed uninstaller pair from a freshly verified payload. Never
/// leaves a half deployment and never copies the running Setup as an uninstaller.
pub(crate) fn deploy_uninstaller_pair(install_dir: &Path, payload_dir: &Path) -> Result<(), String> {
    // The source must be valid before touching the installed copy.
    validate_uninstaller(payload_dir, &manifest::host_arch(), &product_version())?;
    replace_from_payload(install_dir, payload_dir, &UNINSTALLER_PAIR, &|| {
        validate_uninstaller(install_dir, &manifest::host_arch(), &product_version())
            .map(|_| ())
            .map_err(|e| format!("部署后的卸载器校验失败：{e}"))
    })
}
