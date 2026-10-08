use super::*;
use ed25519_dalek::{Signer, SigningKey};
use std::io::Cursor;

fn signed(payload: Value, purpose: &str) -> (SignedEnvelope, Value) {
    let signer = SigningKey::from_bytes(&[0x31; 32]);
    let header = serde_json::json!({"alg":"EdDSA","kid":"test-publisher","typ":purpose});
    let text = format!("{}.{}", URL_SAFE_NO_PAD.encode(canonical_bytes(&header).unwrap()), URL_SAFE_NO_PAD.encode(canonical_bytes(&payload).unwrap()));
    let signature = format!("{text}.{}", URL_SAFE_NO_PAD.encode(signer.sign(text.as_bytes()).to_bytes()));
    let keys = serde_json::json!([{"id":"test-publisher","publicKey":{"kty":"OKP","crv":"Ed25519","x":URL_SAFE_NO_PAD.encode(signer.verifying_key().to_bytes())}}]);
    (SignedEnvelope { payload, signature }, keys)
}

fn descriptor(path: &str, bytes: &[u8]) -> FileDescriptor {
    FileDescriptor { path: path.into(), size_bytes: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(bytes)), executable_architecture: None }
}

#[test]
fn purpose_identity_and_claims_are_bound_to_the_signature() {
    let payload = serde_json::json!({"protocolVersion":1,"edition":"community"});
    let (mut envelope, keys) = signed(payload.clone(), BODY_PROOF_TYPE);
    assert_eq!(verify_envelope_with_keys::<Value>(&envelope, BODY_PROOF_TYPE, &keys).unwrap(), payload);
    assert!(verify_envelope_with_keys::<Value>(&envelope, RUNTIME_PROOF_TYPE, &keys).is_err());
    assert!(verify_envelope_with_keys::<Value>(&envelope, BODY_PROOF_TYPE, &serde_json::json!([])).is_err());
    envelope.payload["edition"] = "concept".into();
    assert!(verify_envelope_with_keys::<Value>(&envelope, BODY_PROOF_TYPE, &keys).is_err());
}

#[test]
fn signed_prerelease_cannot_claim_the_stable_channel() {
    let asset = |index: &str, role: &str, architectures: Vec<&str>, executable: Option<&str>| serde_json::json!({
        "assetId":index.repeat(64),"role":role,"filename":format!("asset-{index}.{}", if executable.is_some() {"exe"} else {"zip"}),
        "sizeBytes":1,"sha256":index.repeat(64),"contentType":"application/octet-stream","executableArchitecture":executable,
        "supportedNativeArchitectures":architectures,"bodyProofSha256":if role=="online-bootstrap" {None} else {Some("a".repeat(64))}});
    let mut payload = serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":"community","productVersion":"0.1.5-alpha+20261008.001",
        "releaseId":"01950455-7587-4dd0-8d2f-5d8f5684b4bf","channel":"alpha","platform":"windows","maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,
        "assets":[asset("1","online-bootstrap",vec!["x64","arm64"],Some("x64")),asset("2","application-payload",vec!["x64"],None),asset("3","application-payload",vec!["arm64"],None)],
        "publicAssetIds":["1".repeat(64)],"architectureEvidence":[
            {"nativeArchitecture":"x64","evidenceId":"e".repeat(64),"testedAt":"2026-10-07T00:00:00.000Z","nativePackageVerified":true},
            {"nativeArchitecture":"arm64","evidenceId":"f".repeat(64),"testedAt":"2026-10-07T00:00:00.000Z","nativePackageVerified":true}],
        "notes":"","createdAt":"2026-10-07T00:00:00.000Z"});
    let valid: ReleaseDescriptor = serde_json::from_value(payload.clone()).unwrap();
    validate_release(&valid,"community").unwrap();
    payload["channel"] = "stable".into();
    let (proof, keys) = signed(payload, RELEASE_PROOF_TYPE);
    let bad: ReleaseDescriptor = verify_envelope_with_keys(&proof, RELEASE_PROOF_TYPE, &keys).unwrap();
    assert!(validate_release(&bad,"community").is_err());
    assert_eq!(version_channel("0.1.5+alpha-build"),"stable");
}

#[test]
fn installed_maintenance_requires_the_signed_body_and_exact_registration() {
    let root = std::env::temp_dir().join(crate::random_id("signed-installation").unwrap());
    fs::create_dir_all(root.join("maintenance")).unwrap();
    fs::create_dir(root.join("resources")).unwrap();
    fs::write(root.join("resources/app.asar"), b"damaged application archive").unwrap();
    let edition = crate::product::edition_id();
    let location = crate::path::normalize_absolute_path(&root).unwrap().as_string();
    let registration = serde_json::json!({"schemaVersion":1,"edition":edition,"packageName":crate::product::edition().package_name,
        "version":"0.9.42","arch":"x64","installLocation":location,"installationId":"fixture-installation",
        "registryRoot":"HKCU","registryKey":crate::product::edition().registry_key});
    fs::write(root.join(crate::product::INSTALL_RECEIPT), serde_json::to_vec(&registration).unwrap()).unwrap();
    assert!(verify_installed_identity_with_keys(&root, &serde_json::json!([])).is_err());
    let files = vec![descriptor("maintenance/backup-runtime.zip", b"runtime"), descriptor("maintenance/runtime-proof.json", b"proof")];
    let body = serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":edition,"productVersion":"0.9.42",
        "variant":"installed","platform":"windows","nativeArchitectures":["x64"],"maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,
        "archive":{"sha256":"a".repeat(64),"sizeBytes":1,"expandedBytes":12,"fileCount":2},"files":files,
        "components":[{"componentId":"backup-runtime","componentVersion":"1.0.0","nativeArchitecture":"x64",
            "archivePath":"maintenance/backup-runtime.zip","proofPath":"maintenance/runtime-proof.json","sha256":format!("{:x}", Sha256::digest(b"runtime")),"sizeBytes":7}]});
    let (proof, keys) = signed(body, BODY_PROOF_TYPE);
    fs::write(root.join("distribution-proof.json"), serde_json::to_vec(&proof).unwrap()).unwrap();
    let receipt = serde_json::json!({"protocolVersion":1,"edition":edition,"productVersion":"0.9.42","nativeArchitecture":"x64",
        "bodyProofSha256":content_digest(&proof.payload).unwrap(),"releaseId":null,"releaseManifestSha256":null,"installationId":"fixture-distribution"});
    let path = root.join("maintenance/distribution-receipt.json");
    fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    verify_installed_identity_with_keys(&root, &keys).unwrap();
    assert!(verify_installed_identity_with_keys(&root, &serde_json::json!([])).is_err());
    for (field, value) in [("productVersion", Value::from("0.9.43")), ("nativeArchitecture", Value::from("arm64")),
        ("bodyProofSha256", Value::from("b".repeat(64))), ("protocolVersion", Value::from(0)),
        ("releaseId", Value::from("01950455-7587-4dd0-8d2f-5d8f5684b4bf"))] {
        let mut altered = receipt.clone(); altered[field] = value;
        fs::write(&path, serde_json::to_vec(&altered).unwrap()).unwrap();
        assert!(verify_installed_identity_with_keys(&root, &keys).is_err(), "{field}");
    }
    let mut absent = receipt.clone(); absent.as_object_mut().unwrap().remove("releaseId");
    fs::write(&path, serde_json::to_vec(&absent).unwrap()).unwrap();
    assert!(verify_installed_identity_with_keys(&root, &keys).is_err());
    fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let mut altered = registration; altered["version"] = "0.9.43".into();
    fs::write(root.join(crate::product::INSTALL_RECEIPT), serde_json::to_vec(&altered).unwrap()).unwrap();
    assert!(verify_installed_identity_with_keys(&root, &keys).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn archive_file_paths_and_case_collisions_are_rejected() {
    for path in ["../file", "/file", "C:/file", "a\\file", "file.", "a/CON.txt", "a//file"] {
        assert!(!safe_relative_path(path), "{path}");
    }
    assert!(validate_files(&[descriptor("data.bin", b"a"), descriptor("DATA.bin", b"a")]).is_err());
    assert!(validate_files(&[descriptor("a/normal.bin", b"")]).is_ok());
}

#[test]
fn zip_extraction_rejects_extra_files_and_wrong_bytes() {
    let root = std::env::temp_dir().join(crate::random_id("distribution-zip").unwrap());
    fs::create_dir(&root).unwrap();
    let output = root.join("output");
    fs::create_dir(&output).unwrap();
    let archive = root.join("payload.zip");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("file.bin", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(b"verified content").unwrap();
    fs::write(&archive, zip.finish().unwrap().into_inner()).unwrap();
    assert!(extract_verified_zip(&archive, &[descriptor("different.bin", b"verified content")], &output).is_err());
    assert!(extract_verified_zip(&archive, &[descriptor("file.bin", b"wrong content!!!")], &output).is_err());
    let _ = fs::remove_file(output.join("file.bin"));
    extract_verified_zip(&archive, &[descriptor("file.bin", b"verified content")], &output).unwrap();
    assert_eq!(fs::read(output.join("file.bin")).unwrap(), b"verified content");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_and_unknown_runtime_protocols_are_not_admitted() {
    let mut payload = serde_json::json!({
        "protocolVersion":1,"productId":"sidekickai","edition":"community","componentId":"backup-runtime",
        "componentVersion":"1.0.0","nativeArchitecture":"x64","archive":{"sha256":"a".repeat(64),"sizeBytes":1},
        "files":[{"path":"node.exe","sizeBytes":1,"sha256":"a".repeat(64),"executableArchitecture":"x64"},
            {"path":"export.mjs","sizeBytes":1,"sha256":"a".repeat(64),"executableArchitecture":null},
            {"path":"sidekick-backup.cjs","sizeBytes":1,"sha256":"a".repeat(64),"executableArchitecture":null}],
        "exportProtocolVersion":1,"recoveryProtocolVersion":1,
        "entrypoints":{"export":"export.mjs","restore":"sidekick-backup.cjs"}
    });
    let runtime: RuntimeDescriptor = serde_json::from_value(payload.clone()).unwrap();
    validate_runtime(&runtime, "community", "x64").unwrap();
    assert!(validate_runtime(&runtime, "concept", "x64").is_err());
    assert!(validate_runtime(&runtime, "community", "arm64").is_err());
    payload["protocolVersion"] = 0.into();
    assert!(validate_runtime(&serde_json::from_value(payload.clone()).unwrap(), "community", "x64").is_err());
    payload["unexpected"] = true.into();
    assert!(serde_json::from_value::<RuntimeDescriptor>(payload).is_err());
}

#[test]
fn nullable_architecture_must_be_explicit_in_a_signed_inventory() {
    let payload=serde_json::json!({"path":"script.mjs","sizeBytes":1,"sha256":"a".repeat(64)});
    assert!(serde_json::from_value::<FileDescriptor>(payload.clone()).is_err());
    let mut payload=payload;payload["executableArchitecture"]=Value::Null;
    assert!(serde_json::from_value::<FileDescriptor>(payload).is_ok());
}

#[test]
fn semantic_versions_reject_ambiguous_numeric_and_empty_labels() {
    for value in ["01.1.5", "0.01.5", "0.1.05", "0.1.5-alpha.01", "0.1.5+build..1", "0.1.5+.", "0.1.5+"] {
        assert!(!valid_version(value), "{value}");
    }
    for value in ["0.1.5", "0.1.5-alpha.0", "0.1.5-rc.10+20261008.001", "0.1.5+build.01"] {
        assert!(valid_version(value), "{value}");
    }
}

#[test]
fn anycpu_requires_a_mapped_pure_il_header() {
    let mut bytes=vec![0;0x400];bytes[..2].copy_from_slice(b"MZ");bytes[60..64].copy_from_slice(&0x80u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");bytes[0x84..0x86].copy_from_slice(&0x14cu16.to_le_bytes());
    bytes[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());bytes[0x94..0x96].copy_from_slice(&224u16.to_le_bytes());
    bytes[0x98..0x9a].copy_from_slice(&0x10bu16.to_le_bytes());bytes[0x98+92..0x98+96].copy_from_slice(&16u32.to_le_bytes());
    bytes[0x98+208..0x98+212].copy_from_slice(&0x2000u32.to_le_bytes());bytes[0x98+212..0x98+216].copy_from_slice(&72u32.to_le_bytes());
    let section=0x98+224;bytes[section+12..section+16].copy_from_slice(&0x2000u32.to_le_bytes());
    bytes[section+16..section+20].copy_from_slice(&0x200u32.to_le_bytes());bytes[section+20..section+24].copy_from_slice(&0x200u32.to_le_bytes());
    bytes[0x200..0x204].copy_from_slice(&72u32.to_le_bytes());bytes[0x210..0x214].copy_from_slice(&1u32.to_le_bytes());
    assert_eq!(executable_architecture(&bytes).unwrap(),"anycpu");
    for flags in [0u32,3,0x20001] {bytes[0x210..0x214].copy_from_slice(&flags.to_le_bytes());assert!(executable_architecture(&bytes).is_err());}
    bytes[0x210..0x214].copy_from_slice(&1u32.to_le_bytes());bytes[section+16..section+20].copy_from_slice(&16u32.to_le_bytes());
    assert!(executable_architecture(&bytes).is_err());
}
