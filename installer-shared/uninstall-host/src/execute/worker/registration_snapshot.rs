//! Exact registry-value snapshots with conflict-aware removal and restoration.

use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(windows)]
use winreg::{enums::*, RegKey, RegValue};

const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ValueSnapshot { name: String, kind: u32, bytes: Vec<u8> }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KeyTree { values: Vec<ValueSnapshot>, children: Vec<(String, KeyTree)> }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RegistrationSnapshot {
    pub root: String, pub view: u32, pub name: String, pub install: String, tree: KeyTree,
}

#[cfg(windows)]
fn hive(root: &str) -> Result<RegKey, String> {
    match root { "HKCU" => Ok(RegKey::predef(HKEY_CURRENT_USER)), "HKLM" => Ok(RegKey::predef(HKEY_LOCAL_MACHINE)), _ => Err("不支持的注册表根。".into()) }
}

#[cfg(windows)]
fn flush(key: &RegKey) -> Result<(), String> {
    use windows::Win32::System::Registry::{HKEY, RegFlushKey};
    unsafe { RegFlushKey(HKEY(key.raw_handle() as _)).ok() }.map_err(|error| error.to_string())
}

#[cfg(windows)]
fn read_tree(key: &RegKey, depth: usize) -> Result<KeyTree, String> {
    if depth > 16 { return Err("卸载登记嵌套过深。".into()); }
    let mut values = Vec::new();
    for value in key.enum_values() {
        let (name, value) = value.map_err(|error| error.to_string())?;
        if values.len() >= 4096 || value.bytes.len() > 4 * 1024 * 1024 { return Err("卸载登记超出可恢复范围。".into()); }
        values.push(ValueSnapshot { name, kind: value.vtype as u32, bytes: value.bytes });
    }
    let mut children = Vec::new();
    for name in key.enum_keys() {
        let name = name.map_err(|error| error.to_string())?;
        let child = key.open_subkey_with_flags(&name, KEY_READ).map_err(|error| error.to_string())?;
        children.push((name, read_tree(&child, depth + 1)?));
    }
    values.sort_by(|left, right| left.name.cmp(&right.name)); children.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(KeyTree { values, children })
}

#[cfg(windows)]
fn write_tree(key: &RegKey, tree: &KeyTree) -> Result<(), String> {
    for value in &tree.values {
        let kind = [REG_NONE, REG_SZ, REG_EXPAND_SZ, REG_BINARY, REG_DWORD, REG_DWORD_BIG_ENDIAN, REG_LINK, REG_MULTI_SZ,
            REG_RESOURCE_LIST, REG_FULL_RESOURCE_DESCRIPTOR, REG_RESOURCE_REQUIREMENTS_LIST, REG_QWORD]
            .into_iter().find(|kind| kind.clone() as u32 == value.kind).ok_or("未知注册表值类型。")?;
        key.set_raw_value(&value.name, &RegValue { bytes: value.bytes.clone(), vtype: kind }).map_err(|error| error.to_string())?;
    }
    for (name, child) in &tree.children {
        if name.is_empty() || name.contains(['\\', '/', '\0']) { return Err("注册表子项名称无效。".into()); }
        let (key, _) = key.create_subkey(name).map_err(|error| error.to_string())?;
        write_tree(&key, child)?;
    }
    flush(key)
}

#[cfg(windows)]
fn owned(tree: &KeyTree, install: &Path) -> bool {
    use winreg::types::FromRegValue;
    let value = |name: &str| tree.values.iter().find(|item| item.name.eq_ignore_ascii_case(name)).and_then(|item| {
        if item.kind != REG_SZ as u32 && item.kind != REG_EXPAND_SZ as u32 { return None; }
        String::from_reg_value(&RegValue { bytes: item.bytes.clone(), vtype: REG_SZ }).ok()
    }).unwrap_or_default();
    super::registry::install_location_matches(&value("InstallLocation"), install)
        && crate::discovery::uninstall_command_matches(&value("UninstallString"), &install.join("uninstall.exe"))
}

#[cfg(windows)]
pub(super) fn capture(root: &str, install: &Path) -> Result<Vec<RegistrationSnapshot>, String> {
    let hive = hive(root)?; let mut snapshots = Vec::new();
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let parent = match hive.open_subkey_with_flags(BASE, KEY_READ | view) {
            Ok(key) => key, Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue, Err(error) => return Err(error.to_string()),
        };
        for name in parent.enum_keys() {
            let name = name.map_err(|error| error.to_string())?;
            let key = match parent.open_subkey_with_flags(&name, KEY_READ | view) { Ok(key) => key, Err(_) => continue };
            let location: String = key.get_value("InstallLocation").unwrap_or_default();
            if !super::registry::install_location_matches(&location, install) { continue; }
            let tree = read_tree(&key, 0)?;
            if owned(&tree, install) { snapshots.push(RegistrationSnapshot { root: root.into(), view, name,
                install: install.to_string_lossy().into_owned(), tree }); }
        }
    }
    Ok(snapshots)
}

#[cfg(windows)]
fn validate(snapshot: &RegistrationSnapshot) -> Result<(), String> {
    if ![KEY_WOW64_32KEY, KEY_WOW64_64KEY].contains(&snapshot.view) || snapshot.name.is_empty()
        || snapshot.name.contains(['\\', '/', '\0']) || !owned(&snapshot.tree, Path::new(&snapshot.install)) {
        return Err("卸载登记恢复清单缺少有效的安装归属。".into());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn remove(snapshot: &RegistrationSnapshot) -> Result<(), String> {
    validate(snapshot)?;
    let parent = hive(&snapshot.root)?.open_subkey_with_flags(BASE, KEY_READ | KEY_WRITE | snapshot.view).map_err(|error| error.to_string())?;
    let key = match parent.open_subkey_with_flags(&snapshot.name, KEY_READ | snapshot.view) {
        Ok(key) => key, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(error) => return Err(error.to_string()),
    };
    if read_tree(&key, 0)? != snapshot.tree { return Err("卸载登记已由外部修改，未覆盖。".into()); }
    drop(key);
    parent.delete_subkey_all(&snapshot.name).map_err(|error| error.to_string())?;
    flush(&parent)
}

#[cfg(windows)]
pub(super) fn restore(snapshot: &RegistrationSnapshot) -> Result<(), String> {
    validate(snapshot)?;
    let (parent, _) = hive(&snapshot.root)?.create_subkey_with_flags(BASE, KEY_READ | KEY_WRITE | snapshot.view).map_err(|error| error.to_string())?;
    match parent.open_subkey_with_flags(&snapshot.name, KEY_READ | snapshot.view) {
        Ok(key) if read_tree(&key, 0)? == snapshot.tree => return Ok(()),
        Ok(_) => return Err("卸载登记恢复位置已有不同内容，已保留冲突。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (), Err(error) => return Err(error.to_string()),
    }
    let (key, disposition) = parent.create_subkey_with_flags(&snapshot.name, KEY_READ | KEY_WRITE | snapshot.view).map_err(|error| error.to_string())?;
    if disposition != REG_CREATED_NEW_KEY { return Err("卸载登记在恢复前被重新建立，未覆盖。".into()); }
    write_tree(&key, &snapshot.tree)
}

#[cfg(not(windows))]
pub(super) fn capture(_root: &str, _install: &Path) -> Result<Vec<RegistrationSnapshot>, String> { Ok(Vec::new()) }
#[cfg(not(windows))]
pub(super) fn remove(_snapshot: &RegistrationSnapshot) -> Result<(), String> { Err("卸载登记仅支持Windows。".into()) }
#[cfg(not(windows))]
pub(super) fn restore(_snapshot: &RegistrationSnapshot) -> Result<(), String> { Err("卸载登记仅支持Windows。".into()) }
