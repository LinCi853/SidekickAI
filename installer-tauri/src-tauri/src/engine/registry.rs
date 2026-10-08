// registry —— 卸载注册表读写与快照恢复
use std::path::Path;

use sidekickai_uninstall_core::path::paths_equal;
use winreg::enums::*;
use winreg::{RegKey, RegValue};

use crate::manifest::InstallRequest;

use super::pipeline::EngineHooks;
use super::{product_version, write_log};

pub(crate) fn read_install_registration(key: &str, root: &str) -> Result<Option<sidekickai_uninstall_core::product::InstallRegistration>, String> {
    use sidekickai_uninstall_core::product::InstallRegistration;
    let Some(install_location) = read_registry_string(key, "InstallLocation")? else { return Ok(None); };
    Ok(Some(InstallRegistration {
        root: root.into(),
        install_location,
        version: read_registry_string(key, "DisplayVersion")?.unwrap_or_default(),
        edition: read_registry_string(key, "Edition")?.unwrap_or_default(),
        receipt_sha256: read_registry_string(key, "InstallReceiptSha256")?.unwrap_or_default(),
        uninstall_string: read_registry_string(key, "UninstallString")?.unwrap_or_default(),
    }))
}

// ============================================================================
// Registry: typed access with explicit absent-vs-error handling
// ============================================================================

/// Split `HKCU\...` / `HKLM\...` into the predefined root and its subkey path.
pub(crate) fn registry_root(key: &str) -> Result<(RegKey, String), String> {
    let (hive, subkey) = key
        .split_once('\\')
        .ok_or_else(|| format!("注册表键路径无效：{key}"))?;
    let root = match hive {
        "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        other => return Err(format!("不支持的注册表根：{other}")),
    };
    Ok((root, subkey.to_string()))
}

/// Open a key in the 64-bit view. `Ok(None)` only ever means
/// `ErrorKind::NotFound`; permission and hive errors are propagated so they can
/// never be mistaken for "the key is absent".
pub(crate) fn open_registry_key(key: &str, flags: u32) -> Result<Option<RegKey>, String> {
    let (root, subkey) = registry_root(key)?;
    match root.open_subkey_with_flags(&subkey, flags | KEY_WOW64_64KEY) {
        Ok(opened) => Ok(Some(opened)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法打开注册表项 {key}：{error}")),
    }
}

pub(crate) fn create_registry_key(key: &str) -> Result<RegKey, String> {
    super::transaction::registry_key_intent(key)?;
    let (root, subkey) = registry_root(key)?;
    root.create_subkey_with_flags(&subkey, KEY_WRITE | KEY_WOW64_64KEY)
        .map(|(created, _)| created)
        .map_err(|error| format!("无法创建注册表项 {key}：{error}"))
}

/// Delete a key and every value below it. `Ok(false)` means it was already gone.
pub(crate) fn delete_registry_key(key: &str) -> Result<bool, String> {
    super::transaction::registry_key_intent(key)?;
    if let Some(values) = snapshot_registration(key)? {
        for (name, _, _) in values { super::transaction::registry_intent(key, &name, None)?; }
    }
    let (root, subkey) = registry_root(key)?;
    match root.delete_subkey_all(&subkey) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法删除注册表项 {key}：{error}")),
    }
}

pub(crate) fn read_registry_string(key: &str, name: &str) -> Result<Option<String>, String> {
    let Some(opened) = open_registry_key(key, KEY_READ)? else {
        return Ok(None);
    };
    match opened.get_value::<String, _>(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取注册表值 {key}\\{name}：{error}")),
    }
}

pub(crate) fn delete_registry_value(key: &str, name: &str) -> Result<(), String> {
    super::transaction::registry_intent(key, name, None)?;
    let Some(opened) = open_registry_key(key, KEY_SET_VALUE)? else {
        return Ok(());
    };
    match opened.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除注册表值 {key}\\{name}：{error}")),
    }
}

/// Raw value snapshot, so a failed overwrite can put the previous registration
/// back instead of deleting a key this installation did not create.
pub(crate) type RegistrationSnapshot = Option<Vec<(String, RegType, Vec<u8>)>>;

pub(crate) fn snapshot_registration(key: &str) -> Result<RegistrationSnapshot, String> {
    let Some(opened) = open_registry_key(key, KEY_READ)? else {
        return Ok(None);
    };
    let mut values = Vec::new();
    for entry in opened.enum_values() {
        let (name, value) = entry.map_err(|error| format!("无法枚举注册表项 {key}：{error}"))?;
        values.push((name, value.vtype, value.bytes));
    }
    Ok(Some(values))
}

pub(crate) fn restore_registration(key: &str, snapshot: &RegistrationSnapshot) -> Result<(), String> {
    if super::transaction::active() { return Ok(()); }
    delete_registry_key(key)?;
    let Some(values) = snapshot else {
        return Ok(());
    };
    let created = create_registry_key(key)?;
    for (name, vtype, bytes) in values {
        created
            .set_raw_value(name, &RegValue { bytes: bytes.clone(), vtype: vtype.clone() })
            .map_err(|error| format!("恢复注册表值 {key}\\{name} 失败：{error}"))?;
    }
    Ok(())
}

/// Read the registered version from the uninstall entry. Absent is reported as
/// "not registered"; any other registry error is logged instead of swallowed.
pub(crate) fn registered_version() -> (bool, String) {
    for root in ["HKCU", "HKLM"] {
        let key = uninstall_registration_key(root);
        match read_registry_string(&key, "DisplayVersion") {
            Ok(Some(version)) => return (true, version),
            Ok(None) => {}
            Err(error) => write_log(&format!("W|读取卸载注册版本失败：{error}")),
        }
    }
    (false, String::new())
}

pub(crate) fn uninstall_registration_key(root: &str) -> String {
    format!("{}\\{}", root, sidekickai_uninstall_core::product::registry_path())
}

/// Read the recorded `InstallLocation` of one uninstall key. `Ok(None)` means
/// the key or value is absent; every other registry error is propagated so a
/// permission failure is never mistaken for "no registration".
pub(crate) fn registered_install_location(key: &str) -> Result<Option<String>, String> {
    read_registry_string(key, "InstallLocation")
}

/// Remove a registration only when its `InstallLocation` is exactly the
/// expected directory, so a different installation that shares the product
/// name keeps its entry. An absent or empty value never counts as a match.
pub(crate) fn remove_uninstall_entry_if_matches(key: &str, expected: &Path) -> Result<bool, String> {
    let Some(location) = registered_install_location(key)? else {
        return Ok(false);
    };
    let location = location.trim();
    if location.is_empty() {
        write_log(&format!("W|卸载注册项 {} 的 InstallLocation 为空，不视为匹配", key));
        return Ok(false);
    }
    if !paths_equal(Path::new(location), expected) {
        write_log(&format!(
            "W|保留其他安装范围的卸载注册项 {}（InstallLocation={}）",
            key, location
        ));
        return Ok(false);
    }
    // A key that disappeared between the read and the delete is already gone.
    let _ = delete_registry_key(key)?;
    Ok(true)
}

/// 注册卸载入口：`"<InstallLocation>\\uninstall.exe" --uninstall`。
/// 不写静默卸载；旧版本遗留的 QuietUninstallString 必须被清除。
pub(crate) fn register_uninstall(hooks: &EngineHooks, req: &InstallRequest, dir: &Path) -> Result<(), String> {
    use sidekickai_uninstall_core::product::{self, InstallReceipt};
    use std::fs;
    let arch = super::validate::validate_application(dir)?;
    super::validate::validate_uninstaller(dir, &arch, &product_version())?;
    let root = if req.for_all_users { "HKLM" } else { "HKCU" };
    let key = hooks.registration_key(root);
    let receipt_path = dir.join(product::INSTALL_RECEIPT);
    sidekickai_uninstall_core::path::reject_reparse_points(&receipt_path).map_err(|error| error.message)?;
    if fs::metadata(&receipt_path).is_ok_and(|metadata| !metadata.is_file() || metadata.len() > 64 * 1024) {
        return Err("原安装记录无效，已保留原文件。".into());
    }
    let previous = match fs::read(&receipt_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法保留原安装记录：{error}")),
    };
    let previous_registration = snapshot_registration(&key)?;
    let location = sidekickai_uninstall_core::path::normalize_absolute_path(dir).map_err(|error| error.message)?.as_string();
    let receipt = InstallReceipt {
        schema_version: 1, edition: product::edition_id().into(), package_name: product::edition().package_name.clone(),
        version: product_version(), arch, install_location: location, installation_id: req.installation_id.clone(),
        registry_root: root.into(), registry_key: product::edition().registry_key.clone(),
    };
    if receipt.installation_id.is_empty() { return Err("缺少安装标识，无法登记安装。".into()); }
    let bytes = serde_json::to_vec(&receipt).map_err(|error| error.to_string())?;
    let result = super::transaction::write_file(&receipt_path, bytes).map_err(|error| format!("无法写入安装记录：{error}"))
        .and_then(|_| product::read_install_receipt(dir).map(|_| ()))
        .and_then(|_| crate::distribution::write_receipt(req, dir))
        .and_then(|_| {
            #[cfg(test)]
            if hooks.fail_after_receipt { return Err("receipt registration interrupted".into()); }
            write_uninstall_registration(dir, &key)
        });
    if let Err(error) = result {
        let receipt_restore = match previous {
            Some(bytes) => super::transaction::write_file(&receipt_path, bytes),
            None => match fs::remove_file(&receipt_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                result => result,
            },
        };
        let registration_restore = restore_registration(&key, &previous_registration);
        let mut message = error;
        if let Err(error) = receipt_restore { message.push_str(&format!("；无法恢复安装记录：{error}")); }
        if let Err(error) = registration_restore { message.push_str(&format!("；无法恢复卸载登记：{error}")); }
        return Err(message);
    }
    Ok(())
}

/// Key path is a parameter so the registration contract can be verified against
/// a dedicated test key instead of the user's real SidekickAI uninstall entry.
pub(crate) fn write_uninstall_registration(dir: &Path, key: &str) -> Result<(), String> {
    let exe = dir.join("SidekickAI.exe").to_string_lossy().into_owned();
    let uninst = format!("\"{}\" --uninstall", dir.join("uninstall.exe").to_string_lossy());
    let loc = dir.to_string_lossy().into_owned();
    let mut pairs: Vec<(&str, String)> = vec![
        ("DisplayName", "SidekickAI".into()),
        ("DisplayVersion", product_version()),
        ("Publisher", "LinCi853".into()),
        ("InstallLocation", loc),
        ("DisplayIcon", exe),
        ("UninstallString", uninst),
        ("NoModify", "1".into()),
        ("NoRepair", "1".into()),
    ];
    if let Ok((receipt, bytes)) = sidekickai_uninstall_core::product::read_install_receipt(dir) {
        pairs.push(("Edition", receipt.edition));
        pairs.push(("InstallReceiptSha256", sidekickai_uninstall_core::product::receipt_digest(&bytes)));
    }
    let subkey = create_registry_key(key)?;
    for (name, value) in &pairs {
        use winreg::types::ToRegValue;
        super::transaction::registry_intent(key, name, Some(value.to_reg_value()))?;
        subkey
            .set_value(name, value)
            .map_err(|error| format!("写入卸载注册项 {name} 失败：{error}"))?;
    }
    drop(subkey);
    // 未实现静默卸载：清除可能由旧版本写入的值，避免系统入口指向不存在的功能。
    delete_registry_value(key, "QuietUninstallString")?;
    Ok(())
}
