//! Read-only validation of the application's ZIP and SABK import formats.
//! No archive is accepted solely because it exists or has a particular size.

use crate::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug)]
pub struct VerifiedArchive {
    pub device_id: String,
    pub edition: Option<String>,
    pub options: Option<BTreeMap<String, bool>>,
    pub entry_hashes: BTreeMap<String, String>,
}

pub fn inspect_archive(path: &Path, password: Option<&str>) -> Result<VerifiedArchive, UninstallError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options.open(path).map_err(|e| failure(e.to_string()))?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| failure(e.to_string()))?;
    file.seek(SeekFrom::Start(0)).map_err(|e| failure(e.to_string()))?;
    if magic == *b"SABK" {
        let reader = crate::sabk_reader::SabkReader::new(file, password.ok_or_else(|| failure("加密备份需要密码。"))?)
            .map_err(|e| failure(e.to_string()))?;
        inspect_reader(reader)
    } else {
        if password.is_some() { return Err(failure("期望 SABK 加密备份，但读到的是未加密归档。")); }
        inspect_reader(file)
    }
}

pub fn inspect_bytes(bytes: &[u8], password: Option<&str>) -> Result<VerifiedArchive, UninstallError> {
    let plaintext;
    let bytes = if bytes.starts_with(b"SABK") {
        plaintext = decrypt_sabk(bytes, password.ok_or_else(|| failure("加密备份需要密码。"))?)?;
        plaintext.as_slice()
    } else {
        if password.is_some() { return Err(failure("期望 SABK 加密备份，但读到的是未加密归档。")); }
        bytes
    };
    inspect_reader(Cursor::new(bytes))
}

fn inspect_reader<R: Read + Seek>(reader: R) -> Result<VerifiedArchive, UninstallError> {
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| failure(e.to_string()))?;
    if zip.len() > 100_000 { return Err(failure("归档条目数量超出支持范围。")); }
    let mut entry_hashes = BTreeMap::new();
    let mut entry_sizes = BTreeMap::new();
    let mut paths = BTreeMap::new();
    let mut manifest = None;
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| failure(e.to_string()))?;
        let name = entry.name().strip_suffix('/').unwrap_or(entry.name()).to_owned();
        let directory = entry.is_dir();
        if !safe_path(&name) || entry.enclosed_name().is_none()
            || entry.unix_mode().is_some_and(|mode| ![0, if directory { 0o040000 } else { 0o100000 }].contains(&(mode & 0o170000))) {
            return Err(failure("归档包含不安全条目。"));
        }
        if paths.insert(name.to_lowercase(), directory).is_some() { return Err(failure("归档包含大小写冲突或重复条目。")); }
        if directory { continue; }
        total = total.checked_add(entry.size()).ok_or_else(|| failure("归档大小溢出。"))?;
        if entry.size() > 9_007_199_254_740_991 || total > 9_007_199_254_740_991 {
            return Err(failure("归档超出校验大小上限。"));
        }
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut manifest_bytes = Vec::new();
        loop {
            let read = entry.read(&mut buffer).map_err(|e| failure(format!("无法读取归档条目 {name}：{e}")))?;
            if read == 0 { break; }
            hasher.update(&buffer[..read]);
            if name == "manifest.json" {
                if manifest_bytes.len() + read > 64 * 1024 * 1024 { return Err(failure("清单超出校验大小上限。")); }
                manifest_bytes.extend_from_slice(&buffer[..read]);
            }
        }
        entry_sizes.insert(name.clone(), entry.size());
        if entry_hashes.insert(name.clone(), format!("{:x}", hasher.finalize())).is_some() {
            return Err(failure("归档包含重复条目名称。"));
        }
        if name == "manifest.json" {
            manifest = Some(serde_json::from_slice::<serde_json::Value>(&manifest_bytes).map_err(|e| failure(e.to_string()))?);
        }
    }
    for name in paths.keys() {
        let mut ancestor = name.as_str();
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            if paths.get(parent) == Some(&false) { return Err(failure("归档文件与目录路径冲突。")); }
            ancestor = parent;
        }
    }
    if !["settings.db", "profiles.json"].iter().any(|name| entry_hashes.contains_key(*name)) {
        return Err(failure("归档缺少应用必需的导入数据。"));
    }
    let manifest = manifest.ok_or_else(|| failure("归档缺少 manifest.json。"))?;
    for field in ["deviceId", "appVersion", "exportedAt"] {
        if !manifest[field].as_str().is_some_and(|value| !value.trim().is_empty() && value != "unknown") {
            return Err(failure(format!("归档清单字段 {field} 无效。")));
        }
    }
    let device_id = manifest["deviceId"].as_str().unwrap().to_owned();
    let edition = match manifest.get("edition") {
        None => None,
        Some(value) => Some(match value.as_str() {
            Some("concept" | "sidekickai-opensource") => "concept",
            Some("community" | "sidekick-ai") => "community",
            _ => return Err(failure("归档产品路线无效。")),
        }.to_owned()),
    };
    let options = if manifest.get("format").is_some() || manifest.get("formatVersion").is_some() {
        Some(validate_modern_manifest(&manifest, &entry_hashes, &entry_sizes)?)
    } else { None };
    Ok(VerifiedArchive { device_id, edition, options, entry_hashes })
}

fn safe_path(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}' || "\\<>:\"|?*".contains(ch))
        && name.split('/').all(|part| {
            let base = part.split('.').next().unwrap_or_default().to_ascii_lowercase();
            !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
                && !["con", "prn", "aux", "nul"].contains(&base.as_str())
                && !((base.starts_with("com") || base.starts_with("lpt")) && base.len() == 4 && matches!(base.as_bytes()[3], b'1'..=b'9'))
        })
}

fn validate_modern_manifest(manifest: &serde_json::Value, actual: &BTreeMap<String, String>, sizes: &BTreeMap<String, u64>) -> Result<BTreeMap<String, bool>, UninstallError> {
    if manifest["format"] != "sidekickai-backup" || manifest["formatVersion"] != 1 || !actual.contains_key("settings.db") {
        return Err(failure("备份格式不受支持或缺少 settings.db。"));
    }
    if manifest.get("dataSchemaVersion").is_some_and(|value| !value.as_u64().is_some_and(|value| (1..=9_007_199_254_740_991).contains(&value))) {
        return Err(failure("备份数据版本无效。"));
    }
    let options = ["basicData", "cookies", "indexedDB", "cache"].iter().map(|name| {
        manifest["options"][name].as_bool().map(|value| ((*name).to_owned(), value)).ok_or_else(|| failure("备份选项无效。"))
    }).collect::<Result<BTreeMap<_, _>, _>>()?;
    if !options["basicData"] { return Err(failure("备份缺少基础资料。")); }
    let entries = manifest["entries"].as_object().ok_or_else(|| failure("备份缺少完整源清单。"))?;
    if entries.len() + 1 != actual.len() || !entries.contains_key("settings.db") { return Err(failure("备份源清单与归档条目数量不一致。")); }
    for (name, value) in entries {
        let Some(hash) = value.as_str() else { return Err(failure("备份条目摘要无效。")); };
        if !safe_path(name) || name == "manifest.json" || hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            || actual.get(name).map(String::as_str) != Some(hash) { return Err(failure(format!("备份清单与条目内容不一致：{name}"))); }
    }
    if let Some(inventory) = manifest.get("inventory") {
        let inventory = inventory.as_array().ok_or_else(|| failure("备份快照清单无效。"))?;
        if inventory.len() != entries.len() { return Err(failure("备份快照清单条目数量不一致。")); }
        let mut seen = BTreeSet::new();
        for entry in inventory {
            let name = entry["path"].as_str().ok_or_else(|| failure("快照条目路径无效。"))?;
            if !seen.insert(name) || entries.get(name) != Some(&entry["sha256"]) || entry["state"] != "verified"
                || entry["size"].as_u64() != sizes.get(name).copied() { return Err(failure("备份快照清单与已验证内容不一致。")); }
        }
    }
    validate_cookie_snapshots(manifest, options["cookies"])?;
    Ok(options)
}

fn validate_cookie_snapshots(manifest: &serde_json::Value, cookies_selected: bool) -> Result<(), UninstallError> {
    let Some(snapshots) = manifest.get("cookieSnapshots") else { return Ok(()); };
    let invalid = || failure("备份浏览器会话快照无效。");
    let snapshots = snapshots.as_array().filter(|_| cookies_selected).ok_or_else(invalid)?;
    let mut seen = BTreeSet::new();
    for snapshot in snapshots {
        let name = snapshot["path"].as_str().ok_or_else(invalid)?;
        if !seen.insert(name.to_lowercase()) || !name.is_empty() && (!safe_path(name) || !name.starts_with("Partitions/") || name.matches('/').count() != 1) { return Err(invalid()); }
        for cookie in snapshot["cookies"].as_array().ok_or_else(invalid)? {
            if !cookie["name"].is_string() || !cookie["value"].is_string()
                || !cookie["domain"].as_str().is_some_and(|value| !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || "/@\\:".contains(ch)))
                || !cookie["path"].as_str().is_some_and(|value| value.starts_with('/'))
                || !cookie["sameSite"].as_str().is_some_and(|value| ["unspecified", "no_restriction", "lax", "strict"].contains(&value))
                || ["hostOnly", "httpOnly", "secure", "session"].iter().any(|key| !cookie[key].is_boolean())
                || cookie.get("expirationDate").is_some_and(|value| value.as_f64().is_none_or(|value| !value.is_finite())) { return Err(invalid()); }
        }
    }
    Ok(())
}

pub fn require_source_entries(archive: &VerifiedArchive, expected: &BTreeMap<String, String>) -> Result<(), UninstallError> {
    if expected.is_empty() { return Err(failure("本次备份未清点到任何源数据。")); }
    for (path, hash) in expected {
        if archive.entry_hashes.get(path) != Some(hash) {
            return Err(failure(format!("所选源数据缺失或不一致：{path}")));
        }
    }
    Ok(())
}

fn decrypt_sabk(bytes: &[u8], password: &str) -> Result<Vec<u8>, UninstallError> {
    if bytes.len() < 9 || bytes[4] != 1 { return Err(failure("SABK 头不受支持或已截断。")); }
    let salt_length = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    if salt_length == 0 || salt_length > 65536 { return Err(failure("SABK 盐长度无效。")); }
    let salt_end = 9usize.checked_add(salt_length).ok_or_else(|| failure("SABK 长度无效。"))?;
    let payload_start = salt_end.checked_add(28).ok_or_else(|| failure("SABK 长度无效。"))?;
    if payload_start >= bytes.len() { return Err(failure("SABK 加密载荷已截断。")); }
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &bytes[9..salt_end], 100000, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| failure("SABK 密钥无效。"))?;
    key.fill(0);
    // Electron stores tag before ciphertext; the Rust AEAD API expects it last.
    let mut ciphertext = bytes[payload_start..].to_vec();
    ciphertext.extend_from_slice(&bytes[salt_end + 12..payload_start]);
    cipher.decrypt(Nonce::from_slice(&bytes[salt_end..salt_end + 12]), ciphertext.as_ref())
        .map_err(|_| failure("密码错误或 SABK 备份已损坏。"))
}

fn failure(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::BackupIncomplete, message, UninstallPhase::BackingUp, false, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn modern_manifest() -> serde_json::Value {
        serde_json::json!({ "format": "sidekickai-backup", "formatVersion": 1, "edition": "concept",
            "deviceId": "fixture-device", "appVersion": "0.9.42", "exportedAt": "2026-10-07T00:00:00Z",
            "options": { "basicData": true, "cookies": false, "indexedDB": false, "cache": false },
            "entries": { "settings.db": format!("{:x}", Sha256::digest(b"fixture settings")) },
            "inventory": [{ "path": "settings.db", "size": 16, "sha256": format!("{:x}", Sha256::digest(b"fixture settings")), "state": "verified" }] })
    }

    fn custom_archive(manifest: &serde_json::Value, extra: &[&str]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap(); zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("settings.db", options).unwrap(); zip.write_all(b"fixture settings").unwrap();
        for name in extra { zip.start_file(*name, options).unwrap(); zip.write_all(b"extra").unwrap(); }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn rejects_modern_manifest_inventory_and_payload_mismatches() {
        let manifest = modern_manifest();
        assert!(inspect_bytes(&custom_archive(&manifest, &[]), None).is_ok());
        let mut invalid = manifest.clone(); invalid["entries"]["settings.db"] = serde_json::json!("0".repeat(64));
        assert!(inspect_bytes(&custom_archive(&invalid, &[]), None).is_err());
        let mut invalid = manifest.clone(); invalid["inventory"][0]["size"] = serde_json::json!(17);
        assert!(inspect_bytes(&custom_archive(&invalid, &[]), None).is_err());
        let mut invalid = manifest.clone(); invalid["options"]["cookies"] = serde_json::json!("false");
        assert!(inspect_bytes(&custom_archive(&invalid, &[]), None).is_err());
        assert!(inspect_bytes(&custom_archive(&manifest, &["unlisted.txt"]), None).is_err());
    }

    #[test]
    fn rejects_windows_path_collisions_and_unimportable_entries() {
        let manifest = serde_json::json!({ "deviceId": "fixture", "appVersion": "0.9.42", "exportedAt": "now" });
        for extra in ["SETTINGS.DB", "settings.db/child", "./file", "file.", "CON.txt", "nested\\file", "nested//file"] {
            assert!(inspect_bytes(&custom_archive(&manifest, &[extra]), None).is_err(), "{extra}");
        }
    }

    fn archive(valid: bool) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"deviceId":"fixture-device","appVersion":"0.1.0-alpha","exportedAt":"2026-01-01T00:00:00Z"}"#).unwrap();
        if valid { zip.start_file("settings.db", options).unwrap(); zip.write_all(b"fixture settings").unwrap(); }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn rejects_missing_required_content_and_truncation() {
        assert!(inspect_bytes(&archive(false), None).is_err());
        assert!(inspect_bytes(b"PK\x03\x04", None).is_err());
        let bytes = archive(true);
        let inspected = inspect_bytes(&bytes, None).unwrap();
        assert_eq!(inspected.device_id, "fixture-device");
        let expected = BTreeMap::from([("settings.db".into(), format!("{:x}", Sha256::digest(b"fixture settings")))]);
        require_source_entries(&inspected, &expected).unwrap();
        assert!(require_source_entries(&inspected, &BTreeMap::from([("notes.db".into(), "missing".into())])).is_err());
    }

    #[test]
    fn reads_node_crypto_and_admzip_compatibility_vector() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/node-backup.json")).unwrap();
        fn decode(value: &str) -> Vec<u8> {
            value.as_bytes().chunks_exact(2).map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect()
        }
        let zip = decode(fixture["zipHex"].as_str().unwrap());
        let sabk = decode(fixture["sabkHex"].as_str().unwrap());
        let plain = inspect_bytes(&zip, None).unwrap();
        let encrypted = inspect_bytes(&sabk, fixture["password"].as_str()).unwrap();
        let root = std::env::temp_dir().join(crate::random_id("sabk-stream").unwrap());
        std::fs::create_dir(&root).unwrap();
        let target = root.join("backup.sabackup");
        std::fs::write(&target, &sabk).unwrap();
        let streamed = inspect_archive(&target, fixture["password"].as_str()).unwrap();
        assert_eq!(streamed.entry_hashes, encrypted.entry_hashes);
        assert!(inspect_archive(&target, Some("wrong-password")).is_err());
        let mut damaged = sabk.clone();
        *damaged.last_mut().unwrap() ^= 1;
        std::fs::write(&target, damaged).unwrap();
        assert!(inspect_archive(&target, fixture["password"].as_str()).is_err());
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(plain.device_id, "node-fixture-device");
        assert_eq!(plain.entry_hashes, encrypted.entry_hashes);
        assert!(encrypted.entry_hashes.contains_key("notes-assets/sample.txt"));
    }

    #[test]
    fn reads_electron_sabk_layout_and_authenticates_password() {
        let salt = b"fixture-device";
        let nonce = [7u8; 12];
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"fixture-password", salt, 100000, &mut key);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), archive(true).as_slice()).unwrap();
        let split = encrypted.len() - 16;
        let mut bytes = b"SABK\x01".to_vec();
        bytes.extend_from_slice(&(salt.len() as u32).to_le_bytes());
        bytes.extend_from_slice(salt); bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&encrypted[split..]); bytes.extend_from_slice(&encrypted[..split]);
        assert!(inspect_bytes(&bytes, Some("fixture-password")).is_ok());
        assert!(inspect_bytes(&bytes, Some("wrong")).is_err());
        assert!(inspect_bytes(&bytes[..12], Some("fixture-password")).is_err());
        let last = bytes.len() - 1; bytes[last] ^= 1;
        assert!(inspect_bytes(&bytes, Some("fixture-password")).is_err());
    }

    #[test]
    fn accepts_the_documented_sabk_salt_limit_in_memory_and_streaming() {
        let salt = vec![b's'; 65536];
        let nonce = [23u8; 12];
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"fixture-password", &salt, 100000, &mut key);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), archive(true).as_slice()).unwrap();
        let split = encrypted.len() - 16;
        let mut bytes = b"SABK\x01".to_vec();
        bytes.extend_from_slice(&(salt.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&salt); bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&encrypted[split..]); bytes.extend_from_slice(&encrypted[..split]);
        let expected = inspect_bytes(&bytes, Some("fixture-password")).unwrap();
        let file = std::env::temp_dir().join(crate::random_id("sabk-salt-boundary").unwrap());
        std::fs::write(&file, &bytes).unwrap();
        let actual = inspect_archive(&file, Some("fixture-password")).unwrap();
        assert_eq!(expected.entry_hashes, actual.entry_hashes);
        bytes[5..9].copy_from_slice(&65537u32.to_le_bytes());
        assert!(inspect_bytes(&bytes, Some("fixture-password")).is_err());
        std::fs::write(&file, bytes).unwrap();
        assert!(inspect_archive(&file, Some("fixture-password")).is_err());
        std::fs::remove_file(file).unwrap();
    }
}
