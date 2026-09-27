pub fn app_archive(seed: &[u8]) -> Vec<u8> {
    archive_for(&sidekickai_uninstall_core::product::edition().package_name, seed)
}

pub fn archive_for(package_name: &str, seed: &[u8]) -> Vec<u8> {
    archive_for_version(package_name, None, seed)
}

pub fn archive_for_version(package_name: &str, version: Option<&str>, seed: &[u8]) -> Vec<u8> {
    let package = serde_json::to_vec(&serde_json::json!({
        "name": package_name,
        "version": version,
        "fixture": seed,
    })).unwrap();
    let header = serde_json::to_vec(&serde_json::json!({"files": {"package.json": {"size": package.len(), "offset": "0"}}})).unwrap();
    let payload_size = (4 + header.len() + 3) & !3;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&4u32.to_le_bytes());
    bytes.extend_from_slice(&((payload_size + 4) as u32).to_le_bytes());
    bytes.extend_from_slice(&(payload_size as u32).to_le_bytes());
    bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.resize(12 + payload_size, 0);
    bytes.extend_from_slice(&package);
    bytes
}
