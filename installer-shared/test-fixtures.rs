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

pub fn test_trust() -> serde_json::Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let key = ed25519_dalek::SigningKey::from_bytes(&[0x63; 32]);
    serde_json::json!({"id":"maintenance-test-publisher","publicKey":{"kty":"OKP","crv":"Ed25519","x":URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())}})
}

pub fn installed_fingerprint(root: &std::path::Path) -> Result<sidekickai_uninstall_core::FileFingerprint, sidekickai_uninstall_core::UninstallError> {
    if root.join("uninstall.exe").is_file() && !root.join("distribution-proof.json").exists() {
        seal_installation(root);
    }
    sidekickai_uninstall_core::FileFingerprint::from_path(root)
}

pub fn seal_installation(root: &std::path::Path) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use ed25519_dalek::Signer;
    use sidekickai_uninstall_core::{distribution as contract, product};
    use std::fs;
    if !root.join("resources/app.asar").is_file() { return; }
    let Ok(package) = product::package_identity(&root.join("resources/app.asar")) else { return; };
    let Some((edition, known)) = product::product().editions.iter().find(|(_, known)| known.package_name == package.name) else { return; };
    let version = package.version.unwrap_or_else(|| "0.1.0-alpha".into());
    let architecture = "x64";
    fs::create_dir_all(root.join("maintenance")).unwrap();
    for (path, bytes) in [("maintenance/backup-runtime.zip", b"isolated runtime archive".as_slice()), ("maintenance/runtime-proof.json", b"isolated runtime proof".as_slice())] {
        if !root.join(path).exists() { fs::write(root.join(path), bytes).unwrap(); }
    }
    let mut files = Vec::new();
    let mut total = 0;
    for path in ["resources/app.asar", "maintenance/backup-runtime.zip", "maintenance/runtime-proof.json", "SidekickAI.exe", "uninstall.exe"] {
        let file = root.join(path);
        if !file.is_file() { continue; }
        let size = fs::metadata(&file).unwrap().len(); total += size;
        files.push(serde_json::json!({"path":path,"sizeBytes":size,"sha256":contract::sha256_file(&file).unwrap(),
            "executableArchitecture":if path.ends_with(".exe") {Some(architecture)} else {None}}));
    }
    let archive = root.join("maintenance/backup-runtime.zip");
    let payload = serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":edition,"productVersion":version,
        "variant":"installed","platform":"windows","nativeArchitectures":[architecture],"maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,
        "archive":{"sha256":"a".repeat(64),"sizeBytes":1,"expandedBytes":total,"fileCount":files.len()},"files":files,
        "components":[{"componentId":"backup-runtime","componentVersion":"1.0.0","nativeArchitecture":architecture,
            "archivePath":"maintenance/backup-runtime.zip","proofPath":"maintenance/runtime-proof.json","sha256":contract::sha256_file(&archive).unwrap(),"sizeBytes":fs::metadata(&archive).unwrap().len()}]});
    let key = ed25519_dalek::SigningKey::from_bytes(&[0x63; 32]);
    let header = serde_json::json!({"alg":"EdDSA","kid":"maintenance-test-publisher","typ":contract::BODY_PROOF_TYPE});
    let text = format!("{}.{}", URL_SAFE_NO_PAD.encode(contract::canonical_bytes(&header).unwrap()), URL_SAFE_NO_PAD.encode(contract::canonical_bytes(&payload).unwrap()));
    let proof = serde_json::json!({"payload":payload,"signature":format!("{text}.{}", URL_SAFE_NO_PAD.encode(key.sign(text.as_bytes()).to_bytes()))});
    fs::write(root.join("distribution-proof.json"), serde_json::to_vec(&proof).unwrap()).unwrap();
    let normalized = sidekickai_uninstall_core::path::normalize_absolute_path(root).unwrap().as_string();
    let registration = fs::read(root.join(product::INSTALL_RECEIPT)).ok().filter(|bytes| {
        serde_json::from_slice::<serde_json::Value>(bytes).is_ok_and(|value|
            value["edition"] == *edition && value["version"] == version && value["arch"] == architecture && value["installLocation"] == normalized)
    }).unwrap_or_else(|| serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"edition":edition,"packageName":known.package_name,"version":version,"arch":architecture,
        "installLocation":normalized,"installationId":"isolated-installation","registryRoot":"HKCU","registryKey":known.registry_key})).unwrap());
    fs::write(root.join(product::INSTALL_RECEIPT), registration).unwrap();
    fs::write(root.join("maintenance/distribution-receipt.json"), serde_json::to_vec(&serde_json::json!({"protocolVersion":1,
        "edition":edition,"productVersion":version,"nativeArchitecture":architecture,"bodyProofSha256":contract::content_digest(&proof["payload"]).unwrap(),
        "releaseId":null,"releaseManifestSha256":null,"installationId":"isolated-distribution-installation"})).unwrap()).unwrap();
}
