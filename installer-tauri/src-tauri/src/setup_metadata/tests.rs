use super::*;
use std::fs;

fn value() -> serde_json::Value {
    serde_json::json!({ "schemaVersion": 2, "edition": sidekickai_uninstall_core::product::edition_id(),
        "productVersion": "0.9.0", "componentVersion": env!("CARGO_PKG_VERSION"), "uninstallProtocolVersion": 1,
        "features": [], "options": [{ "id": "autoLaunch", "label": "Start", "description": "Startup option", "type": "boolean", "defaultValue": false }] })
}

pub(crate) fn fixture_bytes(payload: &[u8], extractor: &[u8]) -> Vec<u8> {
    let mut metadata = value();
    metadata["payload"] = serde_json::json!({ "size": payload.len(), "sha256": format!("{:x}", Sha256::digest(payload)) });
    metadata["extractor"] = serde_json::json!({ "size": extractor.len(), "sha256": format!("{:x}", Sha256::digest(extractor)) });
    let data = serde_json::to_vec(&metadata).unwrap();
    let mut bytes = b"native-maintenance-program".to_vec();
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(extractor);
    bytes.extend_from_slice(&data);
    bytes.extend_from_slice(b"SKPAYLD2");
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(extractor.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(data.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&Sha256::digest(&data));
    bytes.extend_from_slice(&(FOOTER_SIZE as u32).to_le_bytes());
    bytes
}

fn file() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("sidekick-metadata-{}", sidekickai_uninstall_core::random_id("test").unwrap()));
    fs::create_dir(&root).unwrap();
    root.join("setup.exe")
}

#[test]
fn metadata_versions_and_defaults_are_release_data() {
    for version in ["0.1.5-beta-rc", "0.9.0", "3.2.1"] {
        for enabled in [true, false] {
            let mut data = value();
            data["productVersion"] = version.into();
            data["options"][0]["defaultValue"] = enabled.into();
            let parsed: SetupMetadata = serde_json::from_value(data).unwrap();
            validate(&parsed).unwrap();
            assert_eq!(parsed.product_version, version);
            assert_eq!(parsed.options[0].default_value, enabled);
        }
    }
}

#[test]
fn unsupported_metadata_is_refused() {
    for (key, replacement) in [("schemaVersion", serde_json::json!(99)), ("edition", serde_json::json!("foreign")),
        ("productVersion", serde_json::json!("invalid/version")), ("componentVersion", serde_json::json!("99.0.0")),
        ("uninstallProtocolVersion", serde_json::json!(99))] {
        let mut data = value();
        data[key] = replacement;
        assert!(validate(&serde_json::from_value(data).unwrap()).is_err());
    }
    let mut data = value();
    data["options"][0]["id"] = "arbitraryCommand".into();
    assert!(validate(&serde_json::from_value(data).unwrap()).is_err());
}

#[test]
fn embedded_metadata_reads_without_loading_payload() {
    let path = file();
    fs::write(&path, fixture_bytes(b"application payload", b"extractor")).unwrap();
    let mut file = File::open(&path).unwrap();
    let layout = read_layout(&mut file).unwrap();
    assert_eq!(layout.payload_size, 19);
    let parsed = read_from(&mut file, &layout).unwrap();
    assert_eq!(parsed.product_version, "0.9.0");
    assert_eq!(parsed.component_version, env!("CARGO_PKG_VERSION"));
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn truncated_corrupt_and_unbounded_metadata_are_refused() {
    let path = file();
    for (offset, size) in [(8, u64::MAX), (16, u64::MAX), (24, u64::MAX), (8, 0), (16, MAX_EXTRACTOR + 1), (24, MAX_METADATA + 1)] {
        let mut bytes = fixture_bytes(b"payload", b"extractor");
        let at = bytes.len() - FOOTER_SIZE as usize;
        bytes[at + offset..at + offset + 8].copy_from_slice(&size.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(read_layout(&mut File::open(&path).unwrap()).is_err());
    }
    let mut bytes = fixture_bytes(b"payload", b"extractor");
    let digest = bytes.len() - FOOTER_SIZE as usize + 32;
    bytes[digest] ^= 0xff;
    fs::write(&path, bytes).unwrap();
    let mut file = File::open(&path).unwrap();
    let layout = read_layout(&mut file).unwrap();
    assert!(read_from(&mut file, &layout).is_err());
    fs::write(&path, b"truncated").unwrap();
    assert!(read_layout(&mut File::open(&path).unwrap()).is_err());
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
