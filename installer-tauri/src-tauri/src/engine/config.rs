// config —— install-config.json / plugins-manifest.json
use std::fs;
use std::path::Path;

use crate::manifest::{self, InstallRequest};

use super::pipeline::EngineHooks;
use super::scope::{acquire_operation_locks, prepare_operation_scope};
use super::write_log;

/// Repair keeps the target's generation without rewriting its configuration.
pub(crate) fn repair_installation_id(dir: &Path) -> Result<String, String> {
    use std::io::Read;
    use sidekickai_uninstall_core::{path::reject_reparse_points, product};

    let receipt_path = dir.join(product::INSTALL_RECEIPT);
    reject_reparse_points(&receipt_path).map_err(|error| error.message)?;
    let receipt_id = product::read_install_receipt(dir).ok()
        .filter(|(receipt, _)| receipt.edition == product::edition_id())
        .map(|(receipt, _)| receipt.installation_id);
    let config_path = dir.join("install-config.json");
    reject_reparse_points(&config_path).map_err(|error| error.message)?;
    let config_id = match fs::File::open(&config_path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(1024 * 1024 + 1).read_to_end(&mut bytes)
                .map_err(|error| format!("无法读取原安装配置，尚未替换程序文件：{error}"))?;
            if bytes.len() > 1024 * 1024 { return Err("原安装配置过大，尚未替换程序文件。".into()); }
            serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                .and_then(|value| value.get("installationId").and_then(|id| id.as_str())
                    .filter(|id| !id.trim().is_empty()).map(str::to_owned))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法读取原安装配置，尚未替换程序文件：{error}")),
    };
    match (receipt_id, config_id) {
        (Some(receipt), Some(config)) if receipt != config =>
            Err("安装记录与原配置的安装标识不一致，尚未替换程序文件。请先核对原安装记录。".into()),
        (Some(id), _) | (_, Some(id)) => Ok(id),
        (None, None) => Ok(manifest::new_installation_id()),
    }
}

/// 读取已存在安装位置的 install-config.json（覆盖安装/修复时预读作初始值）。
/// 返回 {"modules": {...}, "options": {...}}；文件不存在或解析失败返回 None。
pub fn read_install_config(dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = dir.join("install-config.json");
    let raw = fs::read_to_string(path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(serde_json::json!({
        "modules": cfg.get("modules").cloned().unwrap_or_default(),
        "options": cfg.get("options").cloned().unwrap_or_default(),
    }))
}

/// 用户完成/关闭向导时写入最终配置（执行期已写过初始快照，此处覆盖为用户最终选择）。
pub fn flush_install_config(req: &InstallRequest) -> Result<(), String> {
    flush_install_config_with(req, &EngineHooks::default())
}

pub(crate) fn flush_install_config_with(req: &InstallRequest, hooks: &EngineHooks) -> Result<(), String> {
    if req.mode == manifest::InstallMode::Repair {
        return Ok(());
    }
    // A configuration write is a config-write operation: it must not race an
    // install, a repair or an uninstall worker on the same target.
    let roaming = hooks.roaming_base();
    let scope = prepare_operation_scope(req, roaming.as_deref())?;
    let _locks = acquire_operation_locks(&scope.lock_paths)?;
    write_log("I|flush-config：写入最终安装配置");
    let existing: serde_json::Value = serde_json::from_slice(&fs::read(scope.install_dir.join("install-config.json"))
        .map_err(|error| format!("无法读取待完成安装：{error}"))?)
        .map_err(|error| format!("待完成安装配置无效：{error}"))?;
    let mut finalized = req.clone();
    finalized.installation_id = existing.get("installationId").and_then(|value| value.as_str())
        .filter(|value| !value.is_empty()).ok_or("缺少待完成安装标识。")?.to_string();
    finalized.resources = existing.get("resources").and_then(|value| value.as_array())
        .ok_or("缺少待完成资源状态。")?.clone();
    write_install_config(&finalized, &scope.install_dir)
}

/// Only changed configuration from a new installation needs a completion write.
pub fn install_config_needs_write(req: &InstallRequest) -> bool {
    req.mode != manifest::InstallMode::Repair && !install_config_matches(req)
}

pub fn install_config_matches(req: &InstallRequest) -> bool {
    let path = Path::new(&req.install_dir).join("install-config.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    let Ok(existing) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let mut comparable = req.clone();
    comparable.installation_id = existing.get("installationId").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    comparable.resources = existing.get("resources").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    existing == build_install_config_json(&comparable)
}

pub(crate) fn build_install_config_json(req: &InstallRequest) -> serde_json::Value {
    let mut modules = serde_json::Map::new();
    for f in manifest::features() {
        let default_enabled = f.default_enabled && !(f.install_required == Some(true) && f.required != Some(true));
        let enabled = f.required == Some(true) || req
            .features
            .get(&f.id)
            .and_then(|v| v.as_bool())
            .unwrap_or(default_enabled);
        modules.insert(f.id, serde_json::json!({ "enabled": enabled }));
    }
    let mut options = serde_json::Map::new();
    for o in manifest::options() {
        let v = req
            .options
            .get(&o.id)
            .cloned()
            .unwrap_or_else(|| o.default_value.clone());
        options.insert(o.id, v);
    }
    let resources: Vec<serde_json::Value> = ["ai-app-catalog", "rule", "device-preset", "ai-supplier", "oxy-baseline"]
        .into_iter().map(|kind| req.resources.iter()
            .find(|entry| entry.get("resourceType").and_then(|value| value.as_str()) == Some(kind))
            .cloned().unwrap_or_else(|| serde_json::json!({ "resourceType": kind, "status": "missing" })))
        .collect();
    serde_json::json!({ "schemaVersion": 2, "installationId": req.installation_id,
        "configState": "pending", "modules": modules, "options": options, "resources": resources })
}

pub(crate) fn write_install_config(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    if req.installation_id.is_empty() {
        return Err("缺少安装标识。".into());
    }
    let config = build_install_config_json(req);
    fs::write(
        dir.join("install-config.pending.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("写入 install-config.json 失败：{}", e))?;
    fs::rename(dir.join("install-config.pending.json"), dir.join("install-config.json"))
        .map_err(|error| format!("提交待完成配置失败：{error}"))?;
    Ok(())
}

pub(crate) fn write_plugins_manifest(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let wb = req.features.get("whiteboard").and_then(|v| v.as_bool()).unwrap_or(false);
    fs::write(
        dir.join("plugins-manifest.json"),
        format!("{{\"whiteboard\":{{\"installed\":{}}}}}\n", wb),
    )
    .map_err(|e| format!("写入 plugins-manifest.json 失败：{}", e))?;
    Ok(())
}
