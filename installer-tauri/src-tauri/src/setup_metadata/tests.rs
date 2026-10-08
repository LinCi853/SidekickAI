use super::*;
use std::fs;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};

pub(crate) fn test_trust() -> serde_json::Value {
    let key = SigningKey::from_bytes(&[0x39; 32]);
    serde_json::json!({"id":"native-test-publisher","publicKey":{"kty":"OKP","crv":"Ed25519","x":URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())}})
}

fn signed_body(payload: &[u8], version: &str) -> SignedEnvelope {
    let digest = format!("{:x}", Sha256::digest(payload));
    let body = serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":sidekickai_uninstall_core::product::edition_id(),
        "productVersion":version,"variant":"installed","platform":"windows","nativeArchitectures":["x64"],
        "maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,
        "archive":{"sha256":digest,"sizeBytes":payload.len(),"expandedBytes":payload.len()+2,"fileCount":3},
        "files":[{"path":"SidekickAI.exe","sizeBytes":payload.len(),"sha256":digest,"executableArchitecture":"x64"},
            {"path":"maintenance/backup-runtime.zip","sizeBytes":1,"sha256":"a".repeat(64),"executableArchitecture":null},
            {"path":"maintenance/runtime-proof.json","sizeBytes":1,"sha256":"b".repeat(64),"executableArchitecture":null}],
        "components":[{"componentId":"backup-runtime","componentVersion":"1.0.0","nativeArchitecture":"x64",
            "archivePath":"maintenance/backup-runtime.zip","proofPath":"maintenance/runtime-proof.json","sha256":"a".repeat(64),"sizeBytes":1}]});
    let header = serde_json::json!({"alg":"EdDSA","kid":"native-test-publisher","typ":BODY_PROOF_TYPE});
    let input = format!("{}.{}",URL_SAFE_NO_PAD.encode(distribution::canonical_bytes(&header).unwrap()),URL_SAFE_NO_PAD.encode(distribution::canonical_bytes(&body).unwrap()));
    let key = SigningKey::from_bytes(&[0x39; 32]);
    let signature = format!("{input}.{}",URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes()));
    SignedEnvelope { payload: body, signature }
}

pub(crate) fn complete_draft(value:&mut SetupMetadata) {
    if value.distribution_mode=="offline" && value.distribution_proof.is_none() {
        let payload=b"isolated native metadata fixture";
        value.payload=Some(BlobDescriptor{size:payload.len() as u64,sha256:format!("{:x}",Sha256::digest(payload))});
        value.distribution_proof=Some(signed_body(payload,&value.product_version));
    }
}

fn value(payload: &[u8], version: &str) -> serde_json::Value {
    let offline = sidekickai_uninstall_core::product::edition_id() == "concept";
    serde_json::json!({"schemaVersion":3,"edition":sidekickai_uninstall_core::product::edition_id(),
        "productVersion":version,"componentVersion":env!("CARGO_PKG_VERSION"),"uninstallProtocolVersion":2,
        "distributionProtocolVersion":1,"distributionMode":if offline {"offline"} else {"online"},
        "targetArchitecture":if offline {Some("x64")} else {None},"executableArchitecture":"x64",
        "supportedNativeArchitectures":if offline {vec!["x64"]} else {vec!["x64","arm64"]},
        "distributionProof":if offline {Some(signed_body(payload,version))} else {None},
        "payload":if offline {Some(serde_json::json!({"size":payload.len(),"sha256":format!("{:x}",Sha256::digest(payload))}))} else {None},
        "extractor":null,"features":[],
        "options":[{"id":"autoLaunch","label":"Start","description":"Startup option","type":"boolean","defaultValue":false}]})
}

fn fixture_bytes(payload: &[u8]) -> Vec<u8> {
    let metadata = value(payload,"0.9.0");
    let data = serde_json::to_vec(&metadata).unwrap();
    let payload = if metadata["distributionMode"] == "offline" {payload} else {&[]};
    let mut bytes = b"native-maintenance-program".to_vec();
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(&data);
    bytes.extend_from_slice(b"SKSETUP3");
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(&(data.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&Sha256::digest(&data));
    bytes.extend_from_slice(&(FOOTER_SIZE as u32).to_le_bytes());
    bytes
}

fn file() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("sidekick-metadata-{}",sidekickai_uninstall_core::random_id("test").unwrap()));
    fs::create_dir(&root).unwrap();
    root.join("setup.exe")
}

#[test]
fn metadata_versions_and_defaults_are_release_data() {
    for version in ["0.1.5-rc+20261007.001","0.9.0","3.2.1"] {
        for enabled in [true,false] {
            let mut data=value(b"raw application zip",version);
            data["options"][0]["defaultValue"]=enabled.into();
            let parsed:SetupMetadata=serde_json::from_value(data).unwrap();
            validate(&parsed).unwrap();
            assert_eq!(parsed.product_version,version);
            assert_eq!(parsed.options[0].default_value,enabled);
        }
    }
}

#[test]
fn unsupported_metadata_is_refused() {
    for (key,replacement) in [("schemaVersion",serde_json::json!(2)),("edition",serde_json::json!("foreign")),
        ("productVersion",serde_json::json!("invalid/version")),("componentVersion",serde_json::json!("99.0.0")),
        ("uninstallProtocolVersion",serde_json::json!(1)),("distributionProtocolVersion",serde_json::json!(99))] {
        let mut data=value(b"application zip","0.9.0"); data[key]=replacement;
        assert!(validate(&serde_json::from_value(data).unwrap()).is_err());
    }
    let mut data=value(b"application zip","0.9.0"); data["options"][0]["id"]="arbitraryCommand".into();
    assert!(validate(&serde_json::from_value(data).unwrap()).is_err());
}

#[test]
fn embedded_metadata_reads_without_loading_payload() {
    let path=file(); fs::write(&path,fixture_bytes(b"application payload")).unwrap();
    let mut file=File::open(&path).unwrap(); let layout=read_layout(&mut file).unwrap();
    assert_eq!(layout.extractor_size,0);
    assert_eq!(layout.payload_size,if sidekickai_uninstall_core::product::edition_id()=="concept" {19} else {0});
    let parsed=read_from(&mut file,&layout).unwrap(); assert_eq!(parsed.product_version,"0.9.0");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn truncated_corrupt_and_unbounded_metadata_are_refused() {
    let path=file();
    for (offset,size) in [(8,u64::MAX),(16,1),(24,u64::MAX),(24,0),(24,MAX_METADATA+1)] {
        let mut bytes=fixture_bytes(b"application zip"); let at=bytes.len()-FOOTER_SIZE as usize;
        bytes[at+offset..at+offset+8].copy_from_slice(&size.to_le_bytes()); fs::write(&path,bytes).unwrap();
        assert!(read_layout(&mut File::open(&path).unwrap()).is_err());
    }
    let mut bytes=fixture_bytes(b"application zip"); let digest=bytes.len()-FOOTER_SIZE as usize+32; bytes[digest]^=0xff;
    fs::write(&path,bytes).unwrap(); let mut file=File::open(&path).unwrap(); let layout=read_layout(&mut file).unwrap();
    assert!(read_from(&mut file,&layout).is_err());
    fs::write(&path,b"truncated").unwrap(); assert!(read_layout(&mut File::open(&path).unwrap()).is_err());
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn authenticode_certificate_padding_keeps_footer_discoverable() {
    let path=file();
    let suffix=fixture_bytes(b"application zip");
    let mut bytes=vec![0;512]; bytes[..2].copy_from_slice(b"MZ"); bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
    bytes[64..68].copy_from_slice(b"PE\0\0"); bytes[84..86].copy_from_slice(&240u16.to_le_bytes()); bytes[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
    bytes.extend_from_slice(&suffix["native-maintenance-program".len()..]);
    while bytes.len()%8!=0 {bytes.push(0);}
    let certificate=bytes.len(); bytes.extend_from_slice(&16u32.to_le_bytes()); bytes.extend_from_slice(&0x200u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes()); bytes.extend_from_slice(&[0;8]);
    bytes[88+112+32..88+112+36].copy_from_slice(&(certificate as u32).to_le_bytes()); bytes[88+112+36..88+112+40].copy_from_slice(&16u32.to_le_bytes());
    fs::write(&path,bytes).unwrap(); let mut file=File::open(&path).unwrap(); let layout=read_layout(&mut file).unwrap();
    assert_eq!(read_from(&mut file,&layout).unwrap().product_version,"0.9.0");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
