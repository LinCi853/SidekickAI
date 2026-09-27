//! Read-only validation of the application's ZIP and SABK import formats.
//! No archive is accepted solely because it exists or has a particular size.

use crate::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

#[derive(Debug)]
pub struct VerifiedArchive {
    pub device_id: String,
    pub entry_hashes: BTreeMap<String, String>,
}

pub fn inspect_archive(path: &Path, password: Option<&str>) -> Result<VerifiedArchive, UninstallError> {
    let bytes = std::fs::read(path).map_err(|e| failure(e.to_string()))?;
    inspect_bytes(&bytes, password)
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
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| failure(e.to_string()))?;
    let mut entry_hashes = BTreeMap::new();
    let mut manifest = None;
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| failure(e.to_string()))?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with('/') || name.contains(':') || name.split('/').any(|p| p == "..")
            || entry.enclosed_name().is_none() || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(failure("归档包含不安全条目。"));
        }
        if entry.is_dir() { continue; }
        total = total.checked_add(entry.size()).ok_or_else(|| failure("归档大小溢出。"))?;
        if entry.size() > 2 * 1024 * 1024 * 1024 || total > 16 * 1024 * 1024 * 1024 {
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
                if manifest_bytes.len() + read > 1024 * 1024 { return Err(failure("清单超出校验大小上限。")); }
                manifest_bytes.extend_from_slice(&buffer[..read]);
            }
        }
        if entry_hashes.insert(name.clone(), format!("{:x}", hasher.finalize())).is_some() {
            return Err(failure("归档包含重复条目名称。"));
        }
        if name == "manifest.json" {
            manifest = Some(serde_json::from_slice::<serde_json::Value>(&manifest_bytes).map_err(|e| failure(e.to_string()))?);
        }
    }
    if !["settings.db", "profiles.json", "app-key.json"].iter().any(|name| entry_hashes.contains_key(*name)) {
        return Err(failure("归档缺少应用必需的导入数据。"));
    }
    let manifest = manifest.ok_or_else(|| failure("归档缺少 manifest.json。"))?;
    for field in ["deviceId", "appVersion", "exportedAt"] {
        if !manifest[field].as_str().is_some_and(|value| !value.trim().is_empty() && value != "unknown") {
            return Err(failure(format!("归档清单字段 {field} 无效。")));
        }
    }
    let device_id = manifest["deviceId"].as_str().unwrap().to_owned();
    if bytes.is_empty() { return Err(failure("归档为空。")); }
    Ok(VerifiedArchive { device_id, entry_hashes })
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
    if salt_length == 0 || salt_length > 4096 { return Err(failure("SABK 盐长度无效。")); }
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
}
