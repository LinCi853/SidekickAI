use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edition {
    pub label: String,
    pub package_name: String,
    pub directory: String,
    #[serde(default)]
    pub legacy_directories: Vec<String>,
    pub registry_key: String,
    pub data_directories: Vec<String>,
    pub legacy_executable: String,
    pub cloud_resources: bool,
}

#[derive(Deserialize)]
pub struct Product {
    pub name: String,
    pub executable: String,
    pub editions: HashMap<String, Edition>,
}

pub fn product() -> &'static Product {
    static VALUE: OnceLock<Product> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(include_str!("../packages/product-contract/manifest.json")).expect("valid product contract"))
}

pub fn edition_id() -> &'static str {
    static VALUE: OnceLock<String> = OnceLock::new();
    VALUE.get_or_init(|| {
        let value: serde_json::Value = serde_json::from_str(include_str!("../product-edition.json")).expect("valid edition selection");
        let id = value["edition"].as_str().expect("edition identifier");
        assert!(product().editions.contains_key(id), "unknown edition");
        id.to_owned()
    })
}

pub fn edition() -> &'static Edition { &product().editions[edition_id()] }

impl Edition {
    pub fn install_directories(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.directory.as_str()).chain(self.legacy_directories.iter().map(String::as_str))
    }
}

pub fn installation_edition(directory: &Path) -> Option<(&'static str, &'static Edition)> {
    let name = package_name(&directory.join("resources/app.asar")).ok()?;
    product().editions.iter().find(|(_, edition)| edition.package_name == name)
        .map(|(id, edition)| (id.as_str(), edition))
}

pub fn validate_uninstall_identity(directory: &Path) -> Result<(), String> {
    let (id, _) = installation_edition(directory).ok_or("无法确认安装的产品身份。")?;
    validate_legacy_recovery_for(directory, id)?;
    validate_installation_boundaries(directory)
}

pub fn registry_path() -> String {
    format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}", edition().registry_key)
}

pub struct PackageIdentity {
    pub name: String,
    pub version: Option<String>,
}

fn display_version(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')) {
        return None;
    }
    Some(value.to_owned())
}

/// Read the embedded package identity with bounded allocations and offsets.
pub fn package_identity(archive: &Path) -> Result<PackageIdentity, String> {
    let read = || -> Result<PackageIdentity, Box<dyn std::error::Error>> {
        let mut file = File::open(archive)?;
        let length = file.metadata()?.len();
        let mut prefix = [0u8; 16];
        file.read_exact(&mut prefix)?;
        let field = |offset| u32::from_le_bytes(prefix[offset..offset + 4].try_into().unwrap()) as u64;
        let header_size = field(4);
        let json_size = field(12);
        if field(0) != 4 || header_size < 8 || header_size > 32 * 1024 * 1024 || json_size > header_size - 8 || 8 + header_size > length { return Err("invalid archive header".into()); }
        let mut bytes = vec![0; json_size as usize];
        file.read_exact(&mut bytes)?;
        let header: serde_json::Value = serde_json::from_slice(&bytes)?;
        let entry = &header["files"]["package.json"];
        if entry.get("link").is_some() || entry.get("unpacked").is_some() { return Err("package identity must be embedded".into()); }
        let size = entry["size"].as_u64().ok_or("missing package size")?;
        let offset: u64 = entry["offset"].as_str().ok_or("missing package offset")?.parse()?;
        let start = (8 + header_size).checked_add(offset).ok_or("archive offset overflow")?;
        if size == 0 || size > 1024 * 1024 || start.checked_add(size).is_none_or(|end| end > length) { return Err("invalid package range".into()); }
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; size as usize];
        file.read_exact(&mut bytes)?;
        let package: serde_json::Value = serde_json::from_slice(&bytes)?;
        Ok(PackageIdentity {
            name: package["name"].as_str().ok_or("missing package name")?.to_owned(),
            version: package["version"].as_str().and_then(display_version),
        })
    };
    read().map_err(|error| error.to_string())
}

pub fn package_name(archive: &Path) -> Result<String, String> {
    package_identity(archive).map(|identity| identity.name)
}

pub fn owns_installation(directory: &Path) -> bool {
    package_name(&directory.join("resources/app.asar")).is_ok_and(|name| name == edition().package_name)
}

pub const INSTALL_RECEIPT: &str = "install-receipt.json";

/// A receipt binds a completed deployment to one directory and registry scope.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReceipt {
    pub schema_version: u32,
    pub edition: String,
    pub package_name: String,
    pub version: String,
    pub arch: String,
    pub install_location: String,
    pub installation_id: String,
    pub registry_root: String,
    pub registry_key: String,
}

/// These values must come from the selected edition's uninstall registration.
#[derive(Debug, Clone)]
pub struct InstallRegistration {
    pub root: String,
    pub install_location: String,
    pub version: String,
    pub edition: String,
    pub receipt_sha256: String,
    pub uninstall_string: String,
}

pub fn receipt_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read_install_receipt(directory: &Path) -> Result<(InstallReceipt, Vec<u8>), String> {
    let path = directory.join(INSTALL_RECEIPT);
    crate::path::reject_reparse_points(&path).map_err(|error| error.message)?;
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 {
        return Err("安装记录无效。".into());
    }
    let mut bytes = Vec::new();
    (&mut file).take(64 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 { return Err("安装记录过大。".into()); }
    let receipt: InstallReceipt = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let Some(known_edition) = product().editions.get(&receipt.edition) else {
        return Err("安装记录的版本路线未知。".into());
    };
    let location = crate::path::normalize_absolute_path(&receipt.install_location).map_err(|error| error.message)?;
    if receipt.schema_version != 1 || receipt.package_name != known_edition.package_name
        || receipt.registry_key != known_edition.registry_key
        || !matches!(receipt.registry_root.as_str(), "HKCU" | "HKLM")
        || !matches!(receipt.arch.as_str(), "x64" | "arm64")
        || receipt.version.is_empty() || receipt.installation_id.is_empty()
        || !crate::path::paths_equal(location.as_path(), directory) {
        return Err("安装记录与当前目录不一致。".into());
    }
    Ok((receipt, bytes))
}

/// A readable foreign package always wins over a stale or copied receipt.
pub fn owns_registered_installation(directory: &Path, registration: &InstallRegistration) -> bool {
    if let Ok(name) = package_name(&directory.join("resources/app.asar")) {
        if name != edition().package_name { return false; }
    }
    let Ok((receipt, bytes)) = read_install_receipt(directory) else { return false; };
    receipt.edition == edition_id() && receipt.registry_root == registration.root
        && receipt.version == registration.version && registration.edition == edition_id()
        && receipt_digest(&bytes) == registration.receipt_sha256
        && crate::path::paths_equal(Path::new(&registration.install_location), directory)
        && uninstall_command_matches(&registration.uninstall_string, directory)
}

fn uninstall_command_matches(command: &str, directory: &Path) -> bool {
    let Some(quoted_path) = command.strip_prefix('"').and_then(|value| value.strip_suffix("\" --uninstall")) else { return false; };
    if quoted_path.is_empty() || quoted_path.contains('"') { return false; }
    crate::path::normalize_absolute_path(quoted_path).is_ok_and(|path|
        crate::path::paths_equal(path.as_path(), &directory.join("uninstall.exe")))
}

/// An occupied target must prove its edition before any repair or replacement.
pub fn validate_destination(directory: &Path) -> Result<(), String> {
    validate_destination_with_registration(directory, None)
}

pub fn validate_destination_with_registration(directory: &Path, registration: Option<&InstallRegistration>) -> Result<(), String> {
    validate_legacy_recovery(directory)?;
    validate_installation_boundaries(directory)?;
    if !directory.exists() { return Ok(()); }
    let mut entries = std::fs::read_dir(directory).map_err(|error| error.to_string())?;
    if entries.next().is_none() || owns_installation(directory)
        || registration.is_some_and(|registration| owns_registered_installation(directory, registration)) { return Ok(()); }
    let identified = match package_identity(&directory.join("resources/app.asar")) {
        Ok(identity) => product().editions.iter().find(|(_, value)| value.package_name == identity.name)
            .map(|(id, value)| (id.as_str(), value.label.as_str(), identity.version)),
        Err(_) => read_install_receipt(directory).ok().map(|(receipt, _)| {
            let (id, value) = product().editions.get_key_value(&receipt.edition).expect("validated edition");
            (id.as_str(), value.label.as_str(), display_version(&receipt.version))
        }),
    };
    if let Some((_, label, version)) = identified.filter(|(id, _, _)| *id != edition_id()) {
        let version = version.map(|version| format!("（版本 {version}）")).unwrap_or_default();
        return Err(format!("该目录已安装{label}{version}，当前安装器为{}。不同路线不能直接覆盖；若要继续使用此目录，请先卸载{label}，卸载时默认保留用户数据，再安装{}。也可以选择其他目录。已有程序和数据未修改。", edition().label, edition().label));
    }
    Err("无法确认该目录属于当前产品路线，请选择空目录或先恢复原安装。已有程序和数据未修改。".into())
}

fn recognized_installation(directory: &Path) -> bool {
    package_name(&directory.join("resources/app.asar")).is_ok_and(|name| product().editions.values().any(|edition| edition.package_name == name))
        || read_install_receipt(directory).is_ok()
}

/// A nested installation would inherit its parent's deletion boundary.
pub fn validate_installation_boundaries(directory: &Path) -> Result<(), String> {
    if directory.ancestors().skip(1).any(recognized_installation) {
        return Err("安装目录位于另一安装内部，请选择独立目录。".into());
    }
    let mut pending = if directory.is_dir() { vec![directory.to_owned()] } else { Vec::new() };
    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { continue; } }
            if metadata.is_dir() {
                let child = entry.path();
                if recognized_installation(&child) { return Err("目标目录包含另一安装，请分别维护各自目录。".into()); }
                pending.push(child);
            }
        }
    }
    Ok(())
}

pub fn validate_legacy_recovery(directory: &Path) -> Result<(), String> {
    validate_legacy_recovery_for(directory, edition_id())
}

fn validate_legacy_recovery_for(directory: &Path, id: &str) -> Result<(), String> {
    if id != "concept" { return Ok(()); }
    if let Some(parent) = directory.parent() {
        for name in [".sidekick-open-source-transaction.json", ".sidekick-open-source-uninstall.json"] {
            let journal = parent.join(name);
            match std::fs::symlink_metadata(&journal) {
                Ok(_) => return Err(format!("检测到尚未处理的历史恢复记录，请先恢复该安装：{}", journal.display())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(())
}

/// Windows requires unique filenames for shortcuts with the same display name.
pub fn shortcut_names() -> Vec<String> {
    std::iter::once("SidekickAI.lnk".to_owned()).chain((2..=99).map(|index| format!("SidekickAI ({index}).lnk"))).collect()
}

pub fn owned_shortcut_names() -> Vec<String> {
    shortcut_names_for(edition())
}

pub fn shortcut_names_for(edition: &Edition) -> Vec<String> {
    let mut names = shortcut_names();
    let legacy = Path::new(&edition.legacy_executable).with_extension("lnk").to_string_lossy().into_owned();
    if !names.contains(&legacy) { names.push(legacy); }
    names
}

pub fn application_executable(directory: &Path) -> std::path::PathBuf {
    let current = directory.join(&product().executable);
    let installed = installation_edition(directory).map(|(_, edition)| edition).unwrap_or_else(edition);
    if current.is_file() { current } else { directory.join(&installed.legacy_executable) }
}
