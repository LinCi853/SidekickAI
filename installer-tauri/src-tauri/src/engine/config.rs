// config —— install-config.json / plugins-manifest.json
use std::fs;
use std::path::Path;

use crate::manifest::{self, InstallRequest};

use super::pipeline::EngineHooks;
use super::scope::{acquire_operation_locks, prepare_operation_scope};
use super::write_log;

pub(crate) fn prepare_public_resource_configuration(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let body = if req.distribution_body_proof.is_empty() { None } else {
        let proof = sidekickai_uninstall_core::distribution::parse_envelope(req.distribution_body_proof.as_bytes())?;
        Some(crate::distribution::verify_body(&proof)?)
    };
    prepare_public_resource_configuration_from_files(dir, body.as_ref().map(|body| body.files.as_slice()).unwrap_or(&[]))
}

fn prepare_public_resource_configuration_from_files(
    dir: &Path,
    files: &[sidekickai_uninstall_core::distribution::FileDescriptor],
) -> Result<(), String> {
    use std::io::Read;
    use sidekickai_uninstall_core::distribution;
    for relative in ["resources/resource-trust.json", "resources/resource-hosts.json"] {
        let path = dir.join(relative);
        if let Some(file) = files.iter().find(|file| file.path.eq_ignore_ascii_case(relative)) {
            if file.size_bytes > 64 * 1024 { return Err(format!("公开资源配置过大：{relative}")); }
            distribution::verify_file(&path, file.size_bytes, &file.sha256)?;
            let mut bytes = Vec::new();
            fs::File::open(&path).map_err(|error| error.to_string())?.take(64 * 1024 + 1)
                .read_to_end(&mut bytes).map_err(|error| error.to_string())?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("公开资源配置无效：{relative}（{error}）"))?;
            validate_public_resource_configuration(relative, &value)?;
        } else if relative.ends_with("resource-trust.json") {
            match fs::symlink_metadata(&path) {
                Ok(_) => return Err("存在未登记的资源公钥配置，尚未完成安装。".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(format!("无法核对资源公钥配置：{error}")),
            }
        } else {
            let hosts: serde_json::Value = serde_json::from_str(env!("SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON"))
                .map_err(|error| format!("资源主机配置无效：{error}"))?;
            validate_public_resource_configuration(relative, &hosts)?;
            super::transaction::write_file(&path, serde_json::to_vec(&hosts).map_err(|error| error.to_string())?)
                .map_err(|error| format!("无法写入资源主机配置：{error}"))?;
        }
    }
    Ok(())
}

fn validate_public_resource_configuration(relative: &str, value: &serde_json::Value) -> Result<(), String> {
    let items = value.as_array().ok_or_else(|| format!("公开资源配置必须为数组：{relative}"))?;
    let valid_token = |value: Option<&str>, maximum: usize| value.is_some_and(|text|
        !text.is_empty() && text.len() <= maximum && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')));
    let valid = if relative.ends_with("resource-trust.json") {
        items.len() <= 16 && items.iter().all(|key| valid_token(key["id"].as_str(), 80)
            && key["publicKey"]["kty"] == "OKP" && key["publicKey"]["crv"] == "Ed25519"
            && key["publicKey"]["x"].as_str().is_some_and(|text| text.len() == 43)
            && valid_token(key["publicKey"]["x"].as_str(), 43)
            && key["publicKey"].get("d").is_none() && key.get("privateKey").is_none())
    } else {
        items.len() <= 100 && items.iter().all(|host| host.as_str().is_some_and(|text|
            !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-'))))
    };
    if !valid { return Err(format!("公开资源配置内容无效：{relative}")); }
    Ok(())
}

#[cfg(test)]
mod resource_configuration_tests {
    use super::*;
    use sidekickai_uninstall_core::distribution::FileDescriptor;

    fn root() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("resource-config-test").unwrap());
        fs::create_dir_all(path.join("resources")).unwrap();
        path
    }

    fn key() -> serde_json::Value {
        serde_json::json!({"id":"rotated-resource-key","publicKey":{"kty":"OKP","crv":"Ed25519","x":"A".repeat(43)}})
    }

    fn declared(root: &Path, relative: &str, bytes: &[u8]) -> FileDescriptor {
        fs::write(root.join(relative), bytes).unwrap();
        FileDescriptor { path: relative.into(), size_bytes: bytes.len() as u64,
            sha256: sidekickai_uninstall_core::distribution::sha256_file(&root.join(relative)).unwrap(),
            executable_architecture: None }
    }

    #[test]
    fn signed_configuration_preserves_whitespace_and_rotated_public_keys() {
        for (trust_path, hosts_path) in [("resources/resource-trust.json", "resources/resource-hosts.json"),
            ("Resources/Resource-Trust.json", "Resources/Resource-Hosts.json")] {
            let root = root();
            let trust = (serde_json::to_string_pretty(&vec![key()]).unwrap() + "\r\n").into_bytes();
            let hosts = b"\n[ \"new.example.test\" ]\r\n";
            let files = vec![declared(&root, trust_path, &trust), declared(&root, hosts_path, hosts)];
            prepare_public_resource_configuration_from_files(&root, &files).unwrap();
            assert_eq!(fs::read(root.join(&files[0].path)).unwrap(), trust);
            assert_eq!(fs::read(root.join(&files[1].path)).unwrap(), hosts);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn malformed_or_private_declared_trust_is_rejected_without_rewriting_it() {
        let root = root();
        let mut private = key();
        private["publicKey"]["d"] = "private-material".into();
        let mut embedded = key();
        embedded["privateKey"] = serde_json::json!({});
        for bytes in [b"[".to_vec(), b"{}".to_vec(), serde_json::to_vec(&vec![private]).unwrap(),
            serde_json::to_vec(&vec![embedded]).unwrap(), serde_json::to_vec(&vec![key(); 17]).unwrap()] {
            let file = declared(&root, "resources/resource-trust.json", &bytes);
            assert!(prepare_public_resource_configuration_from_files(&root, &[file]).is_err());
            assert_eq!(fs::read(root.join("resources/resource-trust.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_changed_declared_configuration_cannot_be_replaced_by_bootstrap_defaults() {
        let root = root();
        let bytes = serde_json::to_vec(&vec![key()]).unwrap();
        let file = declared(&root, "resources/resource-trust.json", &bytes);
        fs::remove_file(root.join(&file.path)).unwrap();
        assert!(prepare_public_resource_configuration_from_files(&root, &[file.clone()]).is_err());
        assert!(!root.join(&file.path).exists());
        fs::write(root.join(&file.path), b"[]").unwrap();
        assert!(prepare_public_resource_configuration_from_files(&root, &[file]).is_err());
        assert_eq!(fs::read(root.join("resources/resource-trust.json")).unwrap(), b"[]");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_trust_stays_disabled_and_undeclared_present_trust_is_rejected() {
        let root = root();
        prepare_public_resource_configuration_from_files(&root, &[]).unwrap();
        assert!(!root.join("resources/resource-trust.json").exists());
        let expected: serde_json::Value = serde_json::from_str(env!("SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON")).unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&fs::read(root.join("resources/resource-hosts.json")).unwrap()).unwrap();
        assert_eq!(actual, expected);
        let bytes = serde_json::to_vec(&vec![key()]).unwrap();
        fs::write(root.join("resources/resource-trust.json"), &bytes).unwrap();
        assert!(prepare_public_resource_configuration_from_files(&root, &[]).is_err());
        assert_eq!(fs::read(root.join("resources/resource-trust.json")).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_declared_hosts_are_rejected_even_with_the_correct_digest() {
        let root = root();
        for bytes in [b"{}".to_vec(), b"[\"UPPER.example.test\"]".to_vec(), b"[\"\"]".to_vec(),
            serde_json::to_vec(&vec!["host.example.test"; 101]).unwrap()] {
            let file = declared(&root, "resources/resource-hosts.json", &bytes);
            assert!(prepare_public_resource_configuration_from_files(&root, &[file]).is_err());
            assert_eq!(fs::read(root.join("resources/resource-hosts.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
}


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
    super::transaction::write_file(
        dir.join("install-config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("写入 install-config.json 失败：{}", e))?;
    Ok(())
}

pub(crate) fn write_plugins_manifest(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let config = build_install_config_json(req);
    let plugins = manifest::features().into_iter().filter(|feature| feature.install_required == Some(true))
        .map(|feature| {
            let enabled = config["modules"][&feature.id]["enabled"].as_bool().unwrap_or(false);
            (feature.id, serde_json::json!({ "installed": enabled }))
        }).collect::<serde_json::Map<String, serde_json::Value>>();
    super::transaction::write_file(
        dir.join("plugins-manifest.json"),
        serde_json::to_string(&plugins).map_err(|error| error.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 plugins-manifest.json 失败：{}", e))?;
    Ok(())
}
