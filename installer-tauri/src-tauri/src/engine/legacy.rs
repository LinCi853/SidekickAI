use std::fs;
use std::io::Read;
use std::path::Path;

use sidekickai_uninstall_core::{distribution, product};

use super::pipeline::EngineHooks;
use super::validate::{pe_arch, regular_file, UninstallerManifest};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LegacyIdentity(String);

fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn bounded_file(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    regular_file(path)?;
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > maximum {
        return Err("旧安装身份文件超出大小限制。".into());
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > maximum { return Err("旧安装身份文件超出大小限制。".into()); }
    Ok(bytes)
}

pub(crate) fn admit(root: &Path, registry_root: &str, hooks: &EngineHooks) -> Result<Option<LegacyIdentity>, String> {
    if present(&root.join("distribution-proof.json"))? || present(&root.join("maintenance/distribution-receipt.json"))? {
        distribution::verify_installed_identity(root)?;
        return Ok(None);
    }
    let check = || -> Result<LegacyIdentity, String> {
        sidekickai_uninstall_core::path::validate_tree(root).map_err(|error| error.message)?;
        if present(&root.join("portable.txt"))? { return Err("绿色目录不能作为旧安装迁移。".into()); }
        let (receipt, receipt_bytes) = product::read_install_receipt(root)?;
        if receipt.edition != product::edition_id() || receipt.registry_root != registry_root
            || receipt.arch != sidekickai_uninstall_core::architecture::native_architecture()?
            || !distribution::valid_version(&receipt.version) {
            return Err("旧安装回执的路线、版本、权限范围或架构不一致。".into());
        }
        let registration = super::registry::read_install_registration(&hooks.registration_key(registry_root), registry_root)?
            .ok_or("旧安装缺少对应卸载登记。")?;
        if !product::owns_registered_installation(root, &registration) { return Err("旧安装回执与卸载登记不一致。".into()); }
        let config_bytes = bounded_file(&root.join("install-config.json"), 1024 * 1024)?;
        let config: serde_json::Value = serde_json::from_slice(&config_bytes).map_err(|error| error.to_string())?;
        if config["schemaVersion"] != 2 || config["installationId"].as_str() != Some(&receipt.installation_id) {
            return Err("旧安装配置与回执标识不一致。".into());
        }
        regular_file(&root.join("resources/app.asar"))?;
        let package = product::package_identity(&root.join("resources/app.asar"))?;
        if package.name != receipt.package_name || package.version.as_deref() != Some(&receipt.version) {
            return Err("旧安装应用身份与回执不一致。".into());
        }
        let executable = bounded_file(&root.join("SidekickAI.exe"), 512 * 1024 * 1024)?;
        let uninstaller = bounded_file(&root.join("uninstall.exe"), 512 * 1024 * 1024)?;
        let manifest_bytes = bounded_file(&root.join("uninstall-manifest.json"), 64 * 1024)?;
        let manifest: UninstallerManifest = serde_json::from_slice(&manifest_bytes).map_err(|error| error.to_string())?;
        if pe_arch(&executable)? != receipt.arch || pe_arch(&uninstaller)? != receipt.arch
            || manifest.protocol_version != 2 || !manifest.version.is_empty() || manifest.component_version != "1.0.0"
            || manifest.uninstall_protocol_version != Some(1) || manifest.edition != receipt.edition
            || manifest.product_version != receipt.version || manifest.arch != receipt.arch
            || manifest.size != uninstaller.len() as u64 || manifest.sha256 != product::receipt_digest(&uninstaller)
            || !distribution::valid_digest(&manifest.input_fingerprint) {
            return Err("旧安装程序或卸载器的清单、版本、摘要与架构不一致。".into());
        }
        let binding = serde_json::to_vec(&serde_json::json!({
            "receipt": product::receipt_digest(&receipt_bytes), "config": product::receipt_digest(&config_bytes),
            "application": product::receipt_digest(&executable), "archive": distribution::sha256_file(&root.join("resources/app.asar"))?,
            "uninstaller": manifest.sha256, "manifest": product::receipt_digest(&manifest_bytes),
            "registration": [registration.root, registration.install_location, registration.version, registration.edition,
                registration.receipt_sha256, registration.uninstall_string],
        })).map_err(|error| error.to_string())?;
        Ok(LegacyIdentity(product::receipt_digest(&binding)))
    };
    check().map(Some).map_err(|error| format!("该安装缺少新发行合同身份，且旧安装无法核验：{error}已有程序和资料未替换。"))
}
