// pipeline —— 安装/修复编排、staging、备份提交与回滚
use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest::{self, InstallMode, InstallRequest};

use super::config::{flush_install_config_with, write_install_config, write_plugins_manifest};
use super::deploy::{
    commit_staged, program_items, remove_path, remove_path_checked,
    replace_from_sources, unique_sibling_path, UNINSTALLER_PAIR,
};
use super::payload::{clear_readonly_attributes, extract_to_staging, locate_payload};
use super::registry::{
    register_uninstall, remove_uninstall_entry_if_matches, restore_registration,
    snapshot_registration, uninstall_registration_key,
};
use super::scan::stop_processes_in_targets;
use super::scope::{acquire_operation_locks, move_portable_state, portable_user_data, prepare_operation_scope_with_hooks};
use super::shortcuts::{create_shortcuts, desktop_dir, migrate_legacy_shortcuts, prepare_legacy_alias, remove_shortcuts, start_menu_dir};
use super::validate::{
    core_payload_matches, uninstaller_payload_matches, validate_application, validate_core,
    validate_core_payload, validate_uninstaller,
};
use super::{product_version, progress, status, write_log};

/// Create a directory that is guaranteed to be new for this process. Unlike a
/// PID-named directory it can never collide with a concurrent process (or a
/// reused PID), so no existing contents are ever wiped.
pub(crate) fn unique_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let base = std::env::temp_dir();
    for attempt in 0..16u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let candidate = base.join(format!("{prefix}-{}-{nanos}-{attempt}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建临时目录 {}：{}", candidate.display(), error)),
        }
    }
    Err(format!("无法分配唯一的临时目录（{prefix}）"))
}

/// Test seams for the full install/repair sequence. Production always uses
/// `EngineHooks::default()`: the bundled payload is extracted and the real
/// desktop, Start Menu and uninstall registration locations are used. Tests use
/// a pre-extracted payload fixture plus dedicated registry and shortcut
/// directories so the complete sequencing never touches a real installation or
/// user profile.
#[derive(Default)]
pub(crate) struct EngineHooks {
    /// A pre-extracted, architecture-specific payload directory.
    pub(crate) extracted: Option<PathBuf>,
    pub(crate) desktop: Option<PathBuf>,
    pub(crate) start_menu: Option<PathBuf>,
    /// Registration key override, so the registration contract is exercised
    /// against a dedicated test subkey.
    pub(crate) registration_key: Option<String>,
    /// Roaming base for the shared data-root probes.
    pub(crate) roaming: Option<PathBuf>,
    #[cfg(test)]
    pub(crate) fail_after_registration: bool,
    #[cfg(test)]
    pub(crate) fail_after_receipt: bool,
}

impl EngineHooks {
    pub(crate) fn desktop_dir(&self, for_all_users: bool) -> PathBuf {
        self.desktop.clone().unwrap_or_else(|| desktop_dir(for_all_users))
    }

    pub(crate) fn start_menu_dir(&self, for_all_users: bool) -> PathBuf {
        self.start_menu.clone().unwrap_or_else(|| start_menu_dir(for_all_users))
    }

    pub(crate) fn registration_key(&self, root: &str) -> String {
        self.registration_key
            .clone()
            .unwrap_or_else(|| uninstall_registration_key(root))
    }

    /// Roaming base for the shared data-root probes: an explicit test override
    /// or the real `%APPDATA%` of the user running the installer.
    pub(crate) fn roaming_base(&self) -> Option<PathBuf> {
        self.roaming
            .clone()
            .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
    }
}

/// Fault injection point for the rollback contract. Production builds have no
/// hook and never fail here.
#[cfg(test)]
pub(crate) fn injected_tail_failure(hooks: &EngineHooks) -> Result<(), String> {
    if hooks.fail_after_registration {
        return Err("注入的安装后置失败（测试）".into());
    }
    Ok(())
}

#[cfg(not(test))]
fn injected_tail_failure(_hooks: &EngineHooks) -> Result<(), String> {
    Ok(())
}

/// The opposite-hive registration key. A test override disables the cross-scope
/// cleanup so tests never read or write the real hives.
pub(crate) fn other_registration_key(hooks: &EngineHooks, req: &InstallRequest) -> Option<String> {
    if hooks.registration_key.is_some() {
        return None;
    }
    Some(uninstall_registration_key(if req.for_all_users { "HKCU" } else { "HKLM" }))
}

/// Locate the payload architecture directory: either the injected fixture or a
/// freshly extracted staging directory owned by this call.
pub(crate) fn stage_payload(hooks: &EngineHooks) -> Result<(PathBuf, PathBuf, bool), String> {
    if let Some(extracted) = &hooks.extracted {
        return Ok((PathBuf::new(), extracted.clone(), false));
    }
    let files = locate_payload().ok_or_else(|| {
        let message = "未找到安装载荷 payload.7z / 7zr.exe（需与安装器同目录或内嵌于单文件）";
        write_log(&format!("E|{}", message));
        message
    })?;
    let staging = unique_temp_dir("SidekickAI-Extract")?;
    let extracted = match extract_to_staging(&files.payload, &files.sevenz, &staging) {
        Ok(extracted) => extracted,
        Err(error) => { cleanup_staging(&staging, true); return Err(error); }
    };
    Ok((staging, extracted, true))
}

pub(crate) fn cleanup_staging(staging: &Path, owns_staging: bool) {
    if owns_staging && !staging.as_os_str().is_empty() {
        let _ = fs::remove_dir_all(staging);
    }
}

/// Put the same-volume backup back and remove the partial new copy first, since
/// a rename cannot replace an existing directory. Every failure is reported
/// instead of being ignored.
pub(crate) fn restore_install_dir(install_dir: &Path, backup: Option<&Path>) -> Result<(), String> {
    if let Some(backup) = backup {
        move_portable_state(install_dir, backup)?;
    }
    remove_path_checked(install_dir)?;
    match backup {
        Some(backup) => fs::rename(backup, install_dir)
            .map_err(|error| format!("无法恢复旧安装目录 {}：{}", backup.display(), error)),
        None => Ok(()),
    }
}

pub(crate) fn install_rollback_message(
    action: &str,
    error: &str,
    restore: Result<(), String>,
    backup: Option<&Path>,
) -> String {
    match (restore, backup) {
        (Ok(()), Some(_)) => format!("{action}：{error}（已恢复旧版本）"),
        (Ok(()), None) => format!("{action}：{error}（未改动系统，已清理部分写入的文件）"),
        (Err(restore_error), Some(backup)) => format!(
            "{action}：{error}（恢复旧版本失败：{restore_error}；备份保留在 {}）",
            backup.display()
        ),
        (Err(restore_error), None) => {
            format!("{action}：{error}（清理部分写入的文件失败：{restore_error}）")
        }
    }
}

pub fn run(req: &InstallRequest) -> Result<(), String> {
    run_with(req, &EngineHooks::default())
}

pub(crate) fn run_with(req: &InstallRequest, hooks: &EngineHooks) -> Result<(), String> {
    if matches!(req.mode, InstallMode::Uninstall) {
        return Err("旧卸载请求已停用：卸载必须通过共享卸载器（扫描确认 + 临时 worker）。".into());
    }
    // 轻量子任务：仅在用户点击完成/关闭向导时写入最终配置
    if req.action == "flush-config" {
        return flush_install_config_with(req, hooks);
    }
    match req.mode {
        InstallMode::Repair => run_repair(req, hooks),
        InstallMode::Uninstall => unreachable!("uninstall was rejected above"),
        InstallMode::Install => run_install(req, hooks),
    }
}

pub(crate) fn run_install(req: &InstallRequest, hooks: &EngineHooks) -> Result<(), String> {
    let roaming = hooks.roaming_base();
    let scope = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
    let _locks = acquire_operation_locks(&scope.lock_paths)?;
    write_log(&format!("I|安装引擎启动，模式 install，目标目录：{}", scope.install_dir.display()));
    progress(3);
    status("正在准备安装…");

    let install_dir = scope.install_dir.clone();
    let parent = install_dir.parent().ok_or("无效的安装目录")?.to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| format!("无法创建目录 {}：{}", parent.display(), e))?;

    // The registration this install may overwrite is read before any file is
    // touched, so a later failure can restore the previous values exactly
    // instead of deleting a key this installation did not create.
    let own_root = if req.for_all_users { "HKLM" } else { "HKCU" };
    let own_key = hooks.registration_key(own_root);
    let previous_registration = snapshot_registration(&own_key)?;

    // ---- staging 解压 + 校验（不动旧安装）----
    let (staging, extracted, owns_staging) = stage_payload(hooks)?;
    if let Err(e) = validate_core(&extracted).and_then(|_| program_items(&extracted).map(|_| ())) {
        cleanup_staging(&staging, owns_staging);
        return Err(e);
    }
    if extracted.join("data").exists() {
        cleanup_staging(&staging, owns_staging);
        return Err("应用载荷不得包含用户数据目录。".into());
    }

    // ---- 关闭旧进程（共享实现只结束目标目录内的进程，避免误停同名程序）----
    status("正在关闭旧版本进程…");
    if let Err(error) = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks) {
        cleanup_staging(&staging, owns_staging);
        return Err(error);
    }
    let mut stop_targets = vec![install_dir.clone()];
    stop_targets.extend(scope.cleanup_dirs.iter().cloned());
    if let Err(e) = stop_processes_in_targets(&stop_targets) {
        cleanup_staging(&staging, owns_staging);
        return Err(e);
    }

    // ---- backup：同卷同父目录 rename 暂存；失败即中止，绝不做破坏性回退 ----
    let mut backup: Option<PathBuf> = None;
    if install_dir.exists() {
        status("正在备份旧版本…");
        let candidate = unique_sibling_path(&parent, "SidekickAI-Backup")?;
        match fs::rename(&install_dir, &candidate) {
            Ok(()) => backup = Some(candidate),
            Err(error) => {
                cleanup_staging(&staging, owns_staging);
                return Err(format!(
                    "无法在同一磁盘上暂存旧安装目录（{}），已中止且旧版本未受影响：{}",
                    candidate.display(),
                    error
                ));
            }
        }
    }

    // ---- commit：staging → 目标 ----
    progress(84);
    status("正在写入安装文件…");
    if let Err(error) = commit_staged(&extracted, &install_dir) {
        write_log(&format!("E|提交安装失败：{}，开始回滚", error));
        let restore = restore_install_dir(&install_dir, backup.as_deref());
        cleanup_staging(&staging, owns_staging);
        return Err(install_rollback_message("安装失败", &error, restore, backup.as_deref()));
    }
    cleanup_staging(&staging, owns_staging);

    // ---- 配置 / 快捷方式 / 注册表 / 云端资源（任一失败 → 回滚文件与旧注册项）----
    let tail = (|| -> Result<(), String> {
        if let Some(backup) = &backup {
            move_portable_state(backup, &install_dir)?;
        }
        prepare_legacy_alias(backup.as_deref(), &install_dir)?;
        progress(90);
        status("正在写入配置…");
        write_install_config(req, &install_dir)?;
        write_plugins_manifest(req, &install_dir)?;
        let trust = crate::cloud::trusted_resource_keys()?;
        fs::write(install_dir.join("resources/resource-trust.json"), serde_json::to_vec(&trust).map_err(|error| error.to_string())?)
            .map_err(|error| format!("无法写入公开资源信任配置：{error}"))?;
        let hosts: Vec<String> = serde_json::from_str(env!("SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON"))
            .map_err(|error| format!("资源主机配置无效：{error}"))?;
        fs::write(install_dir.join("resources/resource-hosts.json"), serde_json::to_vec(&hosts).map_err(|error| error.to_string())?)
            .map_err(|error| format!("无法写入资源主机配置：{error}"))?;
        let origin = env!("SIDEKICK_OXY_ORIGIN");
        if !origin.is_empty() {
            fs::write(install_dir.join("oxy-service.json"), serde_json::to_vec(&serde_json::json!({ "origin": origin })).map_err(|error| error.to_string())?)
                .map_err(|error| format!("无法写入资源来源：{error}"))?;
        }

        // Cloud assets land only after the core tree and config are in place.
        // A cloud failure is a tail failure: the whole install rolls back so
        // the machine returns to its pre-install state.
        if !req.cloud_assets.is_empty() {
            progress(92);
            crate::cloud::land_cloud_assets(&install_dir, &req.cloud_assets, &status)?;
        }

        progress(94);
        status("正在创建快捷方式…");
        if req.create_desktop_shortcut {
            create_shortcuts(hooks, req.for_all_users, &install_dir);
        }

        progress(97);
        status("正在写入卸载信息…");
        register_uninstall(hooks, req, &install_dir)?;
        injected_tail_failure(hooks)?;
        copy_uninstaller(&install_dir)?;
        Ok(())
    })();

    if let Err(error) = tail {
        write_log(&format!("E|安装后置步骤失败：{}，开始回滚", error));
        let restore = restore_install_dir(&install_dir, backup.as_deref());
        let registration = restore_registration(&own_key, &previous_registration);
        if let Err(registry_error) = &registration {
            write_log(&format!("W|回滚时恢复卸载注册失败：{}", registry_error));
        }
        let mut message = install_rollback_message("安装失败", &error, restore, backup.as_deref());
        if let Err(registry_error) = registration {
            message.push_str(&format!("；恢复原卸载注册失败：{registry_error}"));
        }
        return Err(message);
    }

    if let Err(error) = migrate_legacy_shortcuts(hooks, req.for_all_users, &install_dir) {
        let retained = backup.as_ref().map(|path| path.display().to_string()).unwrap_or_default();
        let message = format!("安装尚未完成：历史快捷方式迁移失败（{error}）。已保留可运行的历史入口和原安装备份：{retained}");
        write_log(&format!("E|{message}"));
        return Err(message);
    }

    // ---- 成功：删除 backup、清理用户确认的其他位置 ----
    if let Some(backup) = &backup {
        status("正在清理备份…");
        clear_readonly_attributes(backup);
        if let Err(error) = remove_path(backup) {
            write_log(&format!("W|清理备份 {} 失败：{}", backup.display(), error));
        }
    }
    for extra in &scope.cleanup_dirs {
        if extra.exists() {
            if portable_user_data(extra).is_some() {
                write_log(&format!("W|保留了包含便携数据的安装：{}", extra.display()));
                continue;
            }
            status(&format!("正在清理其他安装位置 {}…", extra.display()));
            clear_readonly_attributes(extra);
            if let Err(e) = remove_path(extra) {
                write_log(&format!("W|清理 {} 失败：{}（将在完成页提示）", extra.display(), e));
            }
        }
    }
    // Remove another scope's registration and shortcuts only when its recorded
    // InstallLocation is exactly this installation. A different installation's
    // entry is never removed just because it shares the product name.
    if let Some(other_key) = other_registration_key(hooks, req) {
        match remove_uninstall_entry_if_matches(&other_key, &install_dir) {
            Ok(true) => remove_shortcuts(hooks, !req.for_all_users, &install_dir),
            Ok(false) => {}
            Err(error) => write_log(&format!("W|检查另一范围的卸载注册失败：{}", error)),
        }
    }

    progress(100);
    status("安装完成");
    Ok(())
}

/// Repair replaces a complete program payload while preserving local state.
pub(crate) fn run_repair(req: &InstallRequest, hooks: &EngineHooks) -> Result<(), String> {
    let roaming = hooks.roaming_base();
    let scope = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
    let _locks = acquire_operation_locks(&scope.lock_paths)?;
    write_log(&format!("I|安装引擎启动，模式 repair，目标目录：{}", scope.install_dir.display()));
    progress(5);
    status("正在校验现有安装…");
    let install_dir = scope.install_dir.clone();
    if !install_dir.exists() {
        return Err("修复目标目录不存在，请先执行正常安装。".into());
    }
    let mut repair_request = req.clone();
    repair_request.installation_id = super::config::repair_installation_id(&install_dir)?;
    let req = &repair_request;
    // Application-payload health is decided by structure and architecture only:
    // an outdated standalone uninstaller is repaired independently and must not
    // force a full core replacement.
    let application_healthy = validate_core_payload(&install_dir).is_ok();

    // The incoming payload must be extracted and validated before any skip
    // decision: an installer built for the same version can still carry a
    // rebuilt standalone uninstaller, and a manifest match alone cannot see it.
    let (staging, extracted, owns_staging) = stage_payload(hooks)?;
    // 校验待部署的卸载器与宿主架构一致，避免用错误架构覆盖有效文件。
    if let Err(e) = validate_uninstaller(&extracted, &manifest::host_arch(), &product_version()) {
        cleanup_staging(&staging, owns_staging);
        return Err(format!("待部署的独立卸载器校验失败：{}", e));
    }
    let uninstaller_current =
        uninstaller_payload_matches(&install_dir, &extracted, &manifest::host_arch());
    // Freshness of the core is decided by comparing the actual installed program
    // files with the verified payload, never by the uninstaller check.
    let core_current = application_healthy && core_payload_matches(&install_dir, &extracted);
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    let has_legacy_alias = edition.legacy_executable != product.executable && install_dir.join(&edition.legacy_executable).is_file();
    let legacy_current = !has_legacy_alias || super::validate::paths_have_same_content(
        &install_dir.join(&edition.legacy_executable), &extracted.join(&product.executable));
    write_log(&format!(
        "I|修复内容：核心与载荷一致={}，卸载器需更新={}",
        core_current,
        !uninstaller_current
    ));
    if !core_current {
        if let Err(e) = validate_core(&extracted) {
            cleanup_staging(&staging, owns_staging);
            return Err(format!("待部署的核心文件校验失败：{}", e));
        }
    }

    if core_current && uninstaller_current && legacy_current {
        // A healthy installation still gets its registration rebuilt, so the
        // uninstall entry always points at the deployed standalone uninstaller.
        cleanup_staging(&staging, owns_staging);
        progress(96);
        status("正在重建卸载入口…");
        register_uninstall(hooks, req, &install_dir)?;
        migrate_legacy_shortcuts(hooks, req.for_all_users, &install_dir)
            .map_err(|error| format!("修复尚未完成：历史快捷方式迁移失败（{error}）。已保留匹配当前运行库的历史入口。"))?;
        if req.create_desktop_shortcut {
            create_shortcuts(hooks, req.for_all_users, &install_dir);
        }
        progress(100);
        status("核心文件完整，无需修复");
        write_log("I|核心文件与载荷一致，独立卸载器为当前版本，仅重建注册项");
        return Ok(());
    }

    status("正在关闭运行中的进程…");
    if let Err(error) = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks) {
        cleanup_staging(&staging, owns_staging);
        return Err(error);
    }
    if let Err(e) = stop_processes_in_targets(&[install_dir.clone()]) {
        cleanup_staging(&staging, owns_staging);
        return Err(e);
    }

    progress(80);
    status("正在替换核心程序文件…");
    let mut replacements = Vec::new();
    if !core_current {
        replacements = program_items(&extracted)?;
    }
    if !uninstaller_current {
        replacements.extend(UNINSTALLER_PAIR.iter().map(|name| (*name).to_string()));
    }
    write_log(&format!("I|保留安装配置、已下载云资源及用户数据；替换 {} 项程序文件或目录", replacements.len()));
    for name in &replacements { write_log(&format!("I|待更新：{name}")); }
    let mut sources: Vec<(&str, &str)> = replacements.iter().map(|name| (name.as_str(), name.as_str())).collect();
    if has_legacy_alias { sources.push((&edition.legacy_executable, &product.executable)); }
    let replacement = replace_from_sources(&install_dir, &extracted, &sources, &|| {
        validate_core(&install_dir)?;
        if !core_payload_matches(&install_dir, &extracted) {
            return Err("程序运行库与待部署载荷不一致".into());
        }
        if has_legacy_alias && !super::validate::paths_have_same_content(
            &install_dir.join(&edition.legacy_executable), &install_dir.join(&product.executable)) {
            return Err("历史程序入口与当前完整运行库不一致。".into());
        }
        register_uninstall(hooks, req, &install_dir)?;
        Ok(())
    });
    if let Err(error) = replacement {
        cleanup_staging(&staging, owns_staging);
        return Err(error);
    }
    cleanup_staging(&staging, owns_staging);

    if let Err(e) = validate_core(&install_dir) {
        return Err(format!("修复后校验失败：{}", e));
    }
    migrate_legacy_shortcuts(hooks, req.for_all_users, &install_dir)
        .map_err(|error| format!("修复尚未完成：历史快捷方式迁移失败（{error}）。已保留匹配当前运行库的历史入口。"))?;
    // 修复不重写配置（保留用户设置），只确保卸载入口有效
    if req.create_desktop_shortcut {
        create_shortcuts(hooks, req.for_all_users, &install_dir);
    }
    progress(100);
    status("修复完成");
    Ok(())
}

/// 旧的直接删除卸载路径已移除：卸载只允许经过共享卸载器（扫描 token + 临时 worker）。
pub(crate) fn copy_uninstaller(dir: &Path) -> Result<(), String> {
    // The payload already deployed this pair. Never copy the running Setup.
    let arch = validate_application(dir)?;
    validate_uninstaller(dir, &arch, &product_version())?;
    Ok(())
}
