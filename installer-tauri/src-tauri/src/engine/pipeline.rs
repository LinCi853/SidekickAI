// pipeline —— 安装/修复编排、staging、备份提交与回滚
use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest::{self, InstallMode, InstallRequest};

use super::config::{flush_install_config_with, write_install_config, write_plugins_manifest};
use super::deploy::{
    commit_staged, program_items, remove_path, remove_path_checked,
    replace_from_sources, unique_sibling_path, UNINSTALLER_PAIR,
};
use super::payload::clear_readonly_attributes;
use super::registry::{
    register_uninstall, remove_uninstall_entry_if_matches, restore_registration,
    snapshot_registration, uninstall_registration_key,
};
use super::scan::stop_processes_in_targets;
use super::scope::{acquire_operation_locks, move_portable_state, portable_user_data, prepare_operation_scope_with_hooks, OperationScope};
use super::shortcuts::{create_shortcuts, desktop_dir, migrate_legacy_shortcuts, prepare_legacy_alias, remove_shortcuts, start_menu_dir};
use super::validate::{
    core_payload_matches, uninstaller_payload_matches, validate_application, validate_core,
    validate_core_payload, validate_uninstaller,
};
use super::{product_version, progress, status, write_log};

/// Create a directory that is guaranteed to be new for this process. Unlike a
/// PID-named directory it can never collide with a concurrent process (or a
/// reused PID), so no existing contents are ever wiped.
pub(crate) fn unique_temp_dir_at(base: &Path, prefix: &str) -> Result<PathBuf, String> {
    for attempt in 0..16u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let candidate = base.join(format!("{prefix}-{}-{nanos}-{attempt}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => {
                sidekickai_uninstall_host::harden_private_directory(&candidate).map_err(|error| error.message)?;
                return Ok(candidate);
            }
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
#[derive(Default, Clone)]
pub(crate) struct EngineHooks {
    /// A pre-extracted, architecture-specific payload directory.
    pub(crate) extracted: Option<PathBuf>,
    pub(crate) staging_base: Option<PathBuf>,
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
    #[cfg(test)]
    pub(crate) fail_startup_maintenance: bool,
    #[cfg(test)]
    pub(crate) configuration_change_after_prepare: Option<PathBuf>,
}

impl EngineHooks {
    pub(crate) fn checkpoint(&self, name: &str) -> Result<(), String> {
        #[cfg(test)]
        if name == "prepared" {
            if let Some(path) = &self.configuration_change_after_prepare {
                let mut config: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
                config["options"]["autoStart"] = (!config["options"]["autoStart"].as_bool().unwrap_or(false)).into();
                fs::write(path, serde_json::to_vec(&config).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            }
        }
        #[cfg(test)]
        if self.registration_key.is_some() && self.extracted.is_some() && std::env::var("SIDEKICK_INSTALL_INTERRUPT_AT").as_deref() == Ok(name) {
            if let Ok(marker) = std::env::var("SIDEKICK_INSTALL_INTERRUPT_MARKER") {
                let mut file = fs::OpenOptions::new().write(true).create_new(true).open(marker).map_err(|error| error.to_string())?;
                use std::io::Write;
                file.write_all(name.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
                loop { std::thread::sleep(std::time::Duration::from_millis(100)); }
            }
        }
        let _ = name;
        Ok(())
    }
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

    pub(crate) fn maintain_startup_tasks(&self, directory: &Path) -> Result<(), String> {
        #[cfg(test)]
        {
            if self.fail_startup_maintenance { return Err("管理员启动任务校验失败（测试）。".into()); }
            if self.extracted.is_some() { return Ok(()); }
        }
        sidekickai_uninstall_host::startup_tasks::maintain_installation(directory)
    }

    fn remove_startup_tasks(&self, directory: &Path) -> Result<(), String> {
        #[cfg(test)]
        if self.extracted.is_some() { return Ok(()); }
        sidekickai_uninstall_host::startup_tasks::remove_installation(directory)
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
        super::validate::validate_payload_identity(extracted)?;
        return Ok((PathBuf::new(), extracted.clone(), false));
    }
    let base = hooks.staging_base.clone().unwrap_or_else(std::env::temp_dir);
    let prepared = crate::distribution::ready()?.ok_or("尚未准备已签名应用本体。")?;
    let body = crate::distribution::body()?;
    let archive = body.archive.as_ref().ok_or("应用归档描述缺失。")?;
    sidekickai_uninstall_core::distribution::verify_file(Path::new(&prepared.source_path), archive.size_bytes, &archive.sha256)?;
    let staging = unique_temp_dir_at(&base, "SidekickAI-Extract")?;
    if let Err(error) = super::preflight::check_space(&[(staging.clone(), archive.expanded_bytes)]) {
        cleanup_staging(&staging, true);
        return Err(error);
    }
    let extracted = staging.clone();
    if let Err(error) = sidekickai_uninstall_core::distribution::extract_verified_zip(Path::new(&prepared.source_path), &body.files, &extracted) {
        cleanup_staging(&staging, true); return Err(error);
    }
    fs::write(extracted.join("distribution-proof.json"), &prepared.body_proof).map_err(|error| error.to_string())?;
    if let Err(error) = super::validate::validate_payload_identity(&extracted) {
        cleanup_staging(&staging, true);
        return Err(error);
    }
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
    crate::setup_metadata::current()?;
    if req.action != "flush-config" && !super::transaction::root_for(Path::new(&req.install_dir))?.exists() {
        let body = crate::distribution::apply_request(req)?;
        let prepared = crate::distribution::PreparedDistribution {
            source_path: req.distribution_source_path.clone(), body_proof: req.distribution_body_proof.clone(),
            product_version: body.product_version.clone(), native_architecture: manifest::host_arch().into(),
            release_id: req.distribution_release_id.clone(), release_sha256: req.distribution_release_sha256.clone(), release_proof: req.distribution_release_proof.clone(),
        };
        crate::distribution::adopt_prepared(prepared)?;
    }
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
    let target = super::scope::normalize_owned_dir(&req.install_dir, "安装目录")?;
    let mut paths = vec![target.clone()];
    for path in &req.cleanup_paths { paths.push(super::scope::normalize_owned_dir(path, "清理目录")?); }
    if hooks.registration_key.is_none() {
        for task in sidekickai_uninstall_host::pending_uninstall_tasks().map_err(|error| error.message)? {
            if task.install_paths.iter().any(|path| paths.iter().any(|target| sidekickai_uninstall_core::path::paths_equal(Path::new(path), target))) {
                return Err("此位置有未完成的卸载任务，请返回卸载页面先恢复或完成清理，再安装或修复。".into());
            }
        }
    }
    let recovery_targets = paths.clone();
    let _path_locks = acquire_operation_locks(&paths)?;
    let admitted = if !super::transaction::authorize_recovery(req, hooks)? {
        Some(prepare_operation_scope_with_hooks(req, hooks.roaming_base().as_deref(), hooks)?)
    } else { None };
    stop_processes_in_targets(&recovery_targets)?;
    let data_paths = sidekickai_uninstall_host::data_paths_for(&target, hooks.roaming_base().as_deref()).map_err(|error| error.message)?;
    let _data_locks = acquire_operation_locks(&data_paths)?;
    if super::transaction::root_for(&target)?.exists() {
        let committed = super::transaction::committed(&target)?;
        if !committed { stop_processes_in_targets(&recovery_targets)?; }
        status("正在恢复上次中断的安装…");
        super::transaction::recover(req, hooks)?;
        if committed { progress(100); status("安装已完成，恢复副本清理完成"); return Ok(()); }
        return Err("已恢复上次中断的安装，原版本和冲突副本已保留。请检查后再次点击重试。".into());
    }
    let scope = prepare_operation_scope_with_hooks(req, hooks.roaming_base().as_deref(), hooks)?;
    if let Some(admitted) = &admitted { super::scope::verify_legacy_unchanged(admitted, &scope)?; }
    fs::create_dir_all(target.parent().ok_or("安装目录无效")?).map_err(|error| error.to_string())?;
    let mut prepared_hooks = hooks.clone();
    prepared_hooks.staging_base = Some(super::preflight::staging_directory(req)?);
    let (staging, extracted, owns_staging) = stage_payload(&prepared_hooks)?;
    let same_volume = unique_sibling_path(target.parent().ok_or("安装目录无效")?, "SidekickAI-Staged")?;
    let mut staged_ownership = None;
    let outcome = (|| {
        let incoming = super::preflight::tree_size(&extracted)?;
        let mut required = incoming;
        for path in std::iter::once(&scope.install_dir).chain(scope.cleanup_dirs.iter()) {
            required = required.checked_add(super::preflight::tree_size(path)?.saturating_mul(2)).ok_or("安装空间估算超出支持范围")?;
        }
        super::preflight::check_space(&[(target.clone(), required)])?;
        super::transaction::copy_durable(&extracted, &same_volume)?;
        let seal = super::retained::TreeSeal::capture(&same_volume)?;
        staged_ownership = Some(seal.clone());
        prepared_hooks.extracted = Some(same_volume.clone());
        let mut stop_targets = vec![target.clone()];
        stop_targets.extend(scope.cleanup_dirs.iter().cloned());
        stop_processes_in_targets(&stop_targets)?;
        let current = prepare_operation_scope_with_hooks(req, hooks.roaming_base().as_deref(), hooks)?;
        super::scope::verify_legacy_unchanged(&scope, &current)?;
        let transaction = super::transaction::Transaction::begin(req, hooks)?;
        super::transaction::retain_prepared(&same_volume, &seal)?;
        hooks.checkpoint("prepared")?;
        let result = match req.mode {
        InstallMode::Repair => run_repair(req, &prepared_hooks, &scope),
        InstallMode::Uninstall => unreachable!("uninstall was rejected above"),
        InstallMode::Install => run_install(req, &prepared_hooks, &scope),
        };
        match result {
            Ok(()) => { hooks.checkpoint("before-commit")?; transaction.commit() },
            Err(error) => {
                drop(transaction);
                match super::transaction::recover(req, hooks) {
                    Ok(_) => Err(format!("安装失败：{error}；已恢复原安装与入口。")),
                    Err(recovery) => Err(format!("{error}；{recovery}")),
                }
            }
        }
    })();
    cleanup_staging(&staging, owns_staging);
    let cleanup = match staged_ownership {
        Some(seal) => super::transaction::clean_prepared(&same_volume, &seal),
        None if super::retained::present(&same_volume)? => Err(format!("未封存的安装暂存副本已保留：{}", same_volume.display())),
        None => Ok(()),
    };
    match (outcome, cleanup) {
        (result, Ok(())) => result,
        (Ok(()), Err(cleanup)) => Err(cleanup),
        (Err(error), Err(cleanup)) => Err(format!("{error}；{cleanup}")),
    }
}

fn run_install(req: &InstallRequest, hooks: &EngineHooks, admitted: &OperationScope) -> Result<(), String> {
    let roaming = hooks.roaming_base();
    let scope = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
    super::scope::verify_legacy_unchanged(admitted, &scope)?;
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
    if let Err(error) = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)
        .and_then(|current| super::scope::verify_legacy_unchanged(admitted, &current)) {
        cleanup_staging(&staging, owns_staging);
        return Err(error);
    }
    let mut stop_targets = vec![install_dir.clone()];
    stop_targets.extend(scope.cleanup_dirs.iter().cloned());
    if let Err(e) = stop_processes_in_targets(&stop_targets) {
        cleanup_staging(&staging, owns_staging);
        return Err(e);
    }
    if admitted.legacy_identity.is_some() {
        let current = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
        super::scope::verify_legacy_unchanged(admitted, &current)?;
    }

    // ---- backup：同卷同父目录 rename 暂存；失败即中止，绝不做破坏性回退 ----
    let mut backup: Option<PathBuf> = None;
    if install_dir.exists() {
        status("正在备份旧版本…");
        let candidate = unique_sibling_path(&parent, "SidekickAI-Backup")?;
        super::transaction::retain_move(&install_dir, &candidate)?;
        match fs::rename(&install_dir, &candidate) {
            Ok(()) => {
                hooks.checkpoint("backup-before-seal")?;
                super::transaction::seal_retained(&candidate)?;
                backup = Some(candidate);
            }
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
    hooks.checkpoint("old-directory-moved")?;
    progress(84);
    status("正在写入安装文件…");
    if let Err(error) = commit_staged(&extracted, &install_dir) {
        if super::transaction::active() { return Err(error); }
        write_log(&format!("E|提交安装失败：{}，开始回滚", error));
        let restore = restore_install_dir(&install_dir, backup.as_deref());
        cleanup_staging(&staging, owns_staging);
        return Err(install_rollback_message("安装失败", &error, restore, backup.as_deref()));
    }
    cleanup_staging(&staging, owns_staging);
    hooks.checkpoint("new-directory-present")?;

    // ---- 配置 / 快捷方式 / 注册表 / 云端资源（任一失败 → 回滚文件与旧注册项）----
    let tail = (|| -> Result<(), String> {
        if let Some(backup) = &backup {
            let mut relatives = super::scope::portable_state_paths(backup)?.into_iter()
                .map(|entry| entry.file_name().map(PathBuf::from).ok_or("用户数据路径无效"))
                .collect::<Result<Vec<_>, _>>()?;
            let acquired = super::scope::acquired_resource_path(backup)?;
            let acquired_target = install_dir.join("resources/cloud");
            if let Some(source) = &acquired {
                if super::retained::present(&acquired_target)? {
                    return Err("已获取资源目录存在冲突，原内容已保留。".into());
                }
                relatives.push(source.strip_prefix(backup).map_err(|error| error.to_string())?.to_path_buf());
            }
            super::transaction::prepare_retained_removal(backup, &relatives)?;
            hooks.checkpoint("portable-state-before-move")?;
            move_portable_state(backup, &install_dir)?;
            if let Some(source) = acquired {
                fs::rename(&source, &acquired_target).map_err(|error| format!("无法保留已获取资源：{error}"))?;
            }
            hooks.checkpoint("portable-state-moved-before-seal")?;
            super::transaction::seal_retained(backup)?;
        }
        prepare_legacy_alias(backup.as_deref(), &install_dir)?;
        progress(90);
        status("正在写入配置…");
        write_install_config(req, &install_dir)?;
        write_plugins_manifest(req, &install_dir)?;
        super::config::prepare_public_resource_configuration(req, &install_dir)?;
        let origin = env!("SIDEKICK_OXY_ORIGIN");
        if !origin.is_empty() {
            super::transaction::write_file(install_dir.join("oxy-service.json"), serde_json::to_vec(&serde_json::json!({ "origin": origin })).map_err(|error| error.to_string())?)
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
            create_shortcuts(hooks, req.for_all_users, &install_dir)?;
        }

        progress(97);
        status("正在写入卸载信息…");
        register_uninstall(hooks, req, &install_dir)?;
        hooks.checkpoint("registration-written")?;
        injected_tail_failure(hooks)?;
        copy_uninstaller(&install_dir)?;
        hooks.maintain_startup_tasks(&install_dir)?;
        Ok(())
    })();

    if let Err(error) = tail {
        if super::transaction::active() { return Err(error); }
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

    for extra in &scope.cleanup_dirs {
        if extra.exists() && portable_user_data(extra).is_none() {
            hooks.remove_startup_tasks(extra).map_err(|error| format!(
                "新安装已写入，但其他安装位置的管理员启动任务未能清理；该位置与旧版本备份已保留：{error}"
            ))?;
        }
    }

    // ---- 成功：删除 backup、清理用户确认的其他位置 ----
    if let Some(backup) = backup.as_ref().filter(|_| !super::transaction::active()) {
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
fn run_repair(req: &InstallRequest, hooks: &EngineHooks, admitted: &OperationScope) -> Result<(), String> {
    let roaming = hooks.roaming_base();
    let scope = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
    super::scope::verify_legacy_unchanged(admitted, &scope)?;
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
        hooks.maintain_startup_tasks(&install_dir)?;
        register_uninstall(hooks, req, &install_dir)?;
        hooks.checkpoint("repair-registration-written")?;
        migrate_legacy_shortcuts(hooks, req.for_all_users, &install_dir)
            .map_err(|error| format!("修复尚未完成：历史快捷方式迁移失败（{error}）。已保留匹配当前运行库的历史入口。"))?;
        if req.create_desktop_shortcut {
            create_shortcuts(hooks, req.for_all_users, &install_dir)?;
        }
        progress(100);
        status("核心文件完整，无需修复");
        write_log("I|核心文件与载荷一致，独立卸载器为当前版本，仅重建注册项");
        return Ok(());
    }

    status("正在关闭运行中的进程…");
    if let Err(error) = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)
        .and_then(|current| super::scope::verify_legacy_unchanged(admitted, &current)) {
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
    if admitted.legacy_identity.is_some() {
        let current = prepare_operation_scope_with_hooks(req, roaming.as_deref(), hooks)?;
        super::scope::verify_legacy_unchanged(admitted, &current)?;
    }
    let replacement = replace_from_sources(&install_dir, &extracted, &sources, &|| {
        validate_core(&install_dir)?;
        if !core_payload_matches(&install_dir, &extracted) {
            return Err("程序运行库与待部署载荷不一致".into());
        }
        if has_legacy_alias && !super::validate::paths_have_same_content(
            &install_dir.join(&edition.legacy_executable), &install_dir.join(&product.executable)) {
            return Err("历史程序入口与当前完整运行库不一致。".into());
        }
        hooks.maintain_startup_tasks(&install_dir)?;
        register_uninstall(hooks, req, &install_dir)?;
        hooks.checkpoint("repair-registration-written")?;
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
        create_shortcuts(hooks, req.for_all_users, &install_dir)?;
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
