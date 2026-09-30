// validate —— PE 架构、应用与独立卸载器校验
use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest;

use super::deploy::program_items;
use super::product_version;

// This metadata is an integrity binding to the payload, not an Authenticode signature.
#[derive(Debug, PartialEq, Eq, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallerManifest {
    pub protocol_version: u32,
    #[serde(default)]
    pub edition: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub product_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub component_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uninstall_protocol_version: Option<u32>,
    pub arch: String,
    pub sha256: String,
    pub size: u64,
    pub input_fingerprint: String,
}

pub(crate) fn regular_file(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.file_attributes() & 0x400 != 0 {
        return Err(format!("无效文件或重解析点：{}", path.display()));
    }
    Ok(())
}

pub fn pe_arch(bytes: &[u8]) -> Result<&'static str, String> {
    fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
        Ok(u16::from_le_bytes(bytes.get(at..at + 2).ok_or("PE 被截断")?.try_into().unwrap()))
    }
    fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
        Ok(u32::from_le_bytes(bytes.get(at..at + 4).ok_or("PE 被截断")?.try_into().unwrap()))
    }
    if bytes.get(..2) != Some(b"MZ") { return Err("无效的 DOS 头".into()); }
    let offset = u32_at(bytes, 0x3c)? as usize;
    if bytes.get(offset..offset + 4) != Some(b"PE\0\0") { return Err("无效的 PE 头".into()); }
    let arch = match u16_at(bytes, offset + 4)? {
        0x8664 => "x64", 0xaa64 => "arm64", _ => return Err("不支持的 PE 架构".into()),
    };
    let count = u16_at(bytes, offset + 6)? as usize;
    let optional_size = u16_at(bytes, offset + 20)? as usize;
    if count == 0 || optional_size < 112 || u16_at(bytes, offset + 24)? != 0x20b {
        return Err("无效的 PE32+ 节表".into());
    }
    let sections = offset + 24 + optional_size;
    if sections + count * 40 > bytes.len() { return Err("PE 节表被截断".into()); }
    for index in 0..count {
        let section = sections + index * 40;
        let size = u32_at(bytes, section + 16)? as u64;
        let start = u32_at(bytes, section + 20)? as u64;
        if start + size > bytes.len() as u64 { return Err("PE 节超出文件范围".into()); }
    }
    Ok(arch)
}

pub(crate) fn validate_application(dir: &Path) -> Result<String, String> {
    regular_file(&dir.join("SidekickAI.exe"))?;
    regular_file(&dir.join("resources").join("app.asar"))?;
    if !sidekickai_uninstall_core::product::owns_installation(dir) { return Err("应用载荷不属于当前版本".into()); }
    Ok(pe_arch(&fs::read(dir.join("SidekickAI.exe")).map_err(|e| e.to_string())?)?.into())
}

pub(crate) fn validate_payload_identity(dir: &Path) -> Result<(), String> {
    let identity = sidekickai_uninstall_core::product::package_identity(&dir.join("resources/app.asar"))?;
    if identity.name != sidekickai_uninstall_core::product::edition().package_name
        || identity.version.as_deref() != Some(crate::setup_metadata::current()?.product_version.as_str()) {
        return Err("应用载荷的路线或产品版本与安装包不一致，尚未安装。".into());
    }
    Ok(())
}

pub fn validate_uninstaller(dir: &Path, arch: &str, version: &str) -> Result<UninstallerManifest, String> {
    use sha2::{Digest, Sha256};
    let exe = dir.join("uninstall.exe");
    let metadata = dir.join("uninstall-manifest.json");
    regular_file(&exe)?;
    regular_file(&metadata)?;
    let manifest: UninstallerManifest = serde_json::from_slice(&fs::read(metadata).map_err(|e| e.to_string())?)
        .map_err(|e| format!("卸载器清单无效：{e}"))?;
    let bytes = fs::read(exe).map_err(|e| e.to_string())?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let compatible = match manifest.protocol_version {
        1 => manifest.version == version && manifest.product_version.is_empty() && manifest.component_version.is_empty()
            && manifest.uninstall_protocol_version.is_none(),
        2 => manifest.version.is_empty() && manifest.product_version == version && manifest.component_version == env!("CARGO_PKG_VERSION")
            && manifest.uninstall_protocol_version == Some(1),
        _ => false,
    };
    if !compatible || manifest.edition != sidekickai_uninstall_core::product::edition_id() || manifest.arch != arch
        || pe_arch(&bytes)? != arch || manifest.size != bytes.len() as u64 || manifest.sha256 != digest
        || manifest.input_fingerprint.len() != 64 || !manifest.input_fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("卸载器清单/哈希/版本/架构不匹配".into());
    }
    // app.asar path strings are valid identity probes, not embedded application data.
    let setup_footer = [(28, b"SKPAYLD1"), (68, b"SKPAYLD2")].iter()
        .any(|(size, magic)| bytes.len().checked_sub(*size).and_then(|at| bytes.get(at..at + 8)) == Some(magic.as_slice()));
    if setup_footer || bytes.windows(10).any(|v| v == b"payload.7z")
        || bytes.windows(7).any(|v| v == b"7zr.exe") {
        return Err("独立卸载器中发现安装器载荷".into());
    }
    Ok(manifest)
}

/// Compare the deployed uninstaller pair with the payload that would be
/// deployed now. Byte equality alone is not enough: the manifest hash, size,
/// version and input fingerprint must match too, so an uninstaller rebuilt for
/// the same version is still replaced. The architecture is an explicit argument
/// so this check is independent of application-payload health.
pub(crate) fn uninstaller_payload_matches(install_dir: &Path, payload_dir: &Path, arch: &str) -> bool {
    let deployed = match validate_uninstaller(install_dir, arch, &product_version()) {
        Ok(manifest) => manifest,
        Err(_) => return false,
    };
    let incoming = match validate_uninstaller(payload_dir, arch, &product_version()) {
        Ok(manifest) => manifest,
        Err(_) => return false,
    };
    match (
        fs::read(install_dir.join("uninstall.exe")),
        fs::read(payload_dir.join("uninstall.exe")),
    ) {
        (Ok(deployed_bytes), Ok(incoming_bytes)) => {
            deployed_bytes == incoming_bytes && deployed == incoming
        }
        _ => false,
    }
}

/// Application payload identity (structure + host architecture) without the
/// standalone uninstaller, so the two repair decisions stay independent.
pub(crate) fn validate_core_payload(dir: &Path) -> Result<String, String> {
    let arch = validate_application(dir)?;
    if arch != manifest::host_arch() {
        return Err("应用载荷架构不匹配".into());
    }
    Ok(arch)
}

pub(crate) fn validate_core(dir: &Path) -> Result<(), String> {
    let arch = validate_core_payload(dir)?;
    validate_uninstaller(dir, &arch, &product_version())?;
    Ok(())
}

/// Compare the installed program files with the verified payload by content, so
/// "the same version" is fresh only when the bytes really match.
pub(crate) fn core_payload_matches(install_dir: &Path, payload_dir: &Path) -> bool {
    program_items(payload_dir).is_ok_and(|names| names.iter()
        .all(|name| paths_have_same_content(&install_dir.join(name), &payload_dir.join(name))))
}

pub(crate) fn paths_have_same_content(left: &Path, right: &Path) -> bool {
    match (left.is_dir(), right.is_dir()) {
        (true, true) => match (directory_digest(left), directory_digest(right)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        },
        (false, false) => match (fs::read(left), fs::read(right)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        },
        _ => false,
    }
}

/// Deterministic content digest of a directory tree: relative path plus the hash
/// of every regular file, in sorted order.
pub(crate) fn directory_digest(root: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_dir() {
                pending.push(entry.path());
            } else {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('/', "\\");
                entries.push((relative, entry.path()));
            }
        }
    }
    entries.sort();
    let mut hasher = Sha256::new();
    for (relative, path) in entries {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(fs::read(&path).map_err(|e| e.to_string())?);
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
