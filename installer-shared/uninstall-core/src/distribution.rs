use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

mod installed;
pub use installed::{verify_installed_identity, verify_installed_identity_with_keys, InstalledIdentity, InstallationReceipt};

pub const BODY_PROOF_TYPE: &str = "sidekickai-application-body-v1";
pub const RUNTIME_PROOF_TYPE: &str = "sidekickai-backup-runtime-v1";
pub const RELEASE_PROOF_TYPE: &str = "sidekickai-application-release-v1";
pub const CHANNEL_PROOF_TYPE: &str = "sidekickai-application-channel-v1";
pub const MAX_PROOF_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_FILE_COUNT: usize = 5000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedEnvelope {
    pub payload: Value,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDescriptor {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(deserialize_with = "required_nullable")]
    pub executable_architecture: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveDescriptor {
    pub sha256: String,
    pub size_bytes: u64,
    pub expanded_bytes: u64,
    pub file_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArchive {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentDescriptor {
    pub component_id: String,
    pub component_version: String,
    pub native_architecture: String,
    pub archive_path: String,
    pub proof_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyDescriptor {
    pub protocol_version: u32,
    pub product_id: String,
    pub edition: String,
    pub product_version: String,
    pub variant: String,
    pub platform: String,
    pub native_architectures: Vec<String>,
    pub maintenance_protocol_version: u32,
    pub recovery_protocol_version: u32,
    #[serde(deserialize_with = "required_nullable")]
    pub archive: Option<ArchiveDescriptor>,
    pub files: Vec<FileDescriptor>,
    pub components: Vec<ComponentDescriptor>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEntrypoints {
    pub export: String,
    pub restore: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub protocol_version: u32,
    pub product_id: String,
    pub edition: String,
    pub component_id: String,
    pub component_version: String,
    pub native_architecture: String,
    pub archive: RuntimeArchive,
    pub files: Vec<FileDescriptor>,
    pub export_protocol_version: u32,
    pub recovery_protocol_version: u32,
    pub entrypoints: RuntimeEntrypoints,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAsset {
    pub asset_id: String,
    pub role: String,
    pub filename: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub content_type: String,
    #[serde(deserialize_with = "required_nullable")]
    pub executable_architecture: Option<String>,
    pub supported_native_architectures: Vec<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub body_proof_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectureEvidence {
    pub native_architecture: String,
    pub evidence_id: String,
    pub tested_at: String,
    pub native_package_verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseDescriptor {
    pub protocol_version: u32,
    pub product_id: String,
    pub edition: String,
    pub product_version: String,
    pub release_id: String,
    pub channel: String,
    pub platform: String,
    pub maintenance_protocol_version: u32,
    pub recovery_protocol_version: u32,
    pub assets: Vec<ReleaseAsset>,
    pub public_asset_ids: Vec<String>,
    pub architecture_evidence: Vec<ArchitectureEvidence>,
    pub notes: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelDescriptor {
    pub protocol_version: u32,
    pub product_id: String,
    pub edition: String,
    pub channel: String,
    #[serde(deserialize_with = "required_nullable")]
    pub release_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub release_manifest_sha256: Option<String>,
    pub sequence: u64,
    pub issued_at: u64,
    pub expires_at: u64,
}

fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

pub fn valid_release_id(value: &str) -> bool {
    value.len() == 36 && value.as_bytes()[14]==b'4' && matches!(value.as_bytes()[19],b'8'|b'9'|b'a'|b'b') && value.bytes().enumerate().all(|(at, byte)| {
        if matches!(at, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    })
}

pub fn validate_channel(channel: &ChannelDescriptor, edition: &str, channel_id: &str, now: u64, last_sequence: u64) -> Result<(), String> {
    if channel.protocol_version != 1 || channel.product_id != "sidekickai" || channel.edition != edition
        || channel.channel != channel_id || !matches!(channel_id, "stable" | "beta" | "alpha" | "rc")
        || channel.sequence == 0 || channel.sequence > 9_007_199_254_740_991 || channel.sequence < last_sequence || channel.issued_at==0
        || channel.issued_at > now.saturating_add(60) || channel.expires_at <= now
        || channel.expires_at <= channel.issued_at || channel.expires_at - channel.issued_at > 24 * 60 * 60 {
        return Err("在线发行选择过期、倒退或协议不匹配。".into());
    }
    match (&channel.release_id, &channel.release_manifest_sha256) {
        (None, None) => Ok(()),
        (Some(id), Some(digest)) if valid_release_id(id) && valid_digest(digest) => Ok(()),
        _ => Err("在线发行选择身份无效。".into()),
    }
}

pub fn validate_release(release: &ReleaseDescriptor, edition: &str) -> Result<(), String> {
    if release.protocol_version != 1 || release.product_id != "sidekickai" || release.edition != edition
        || !matches!(edition, "community" | "concept") || !valid_version(&release.product_version)
        || !valid_release_id(&release.release_id) || release.channel != version_channel(&release.product_version)
        || release.platform != "windows" || release.maintenance_protocol_version != 1 || release.recovery_protocol_version != 1
        || release.assets.len()!=3 || release.notes.chars().count() > 8000 || !valid_timestamp(&release.created_at) {
        return Err("发行集合身份或协议不匹配。".into());
    }
    let mut assets = BTreeSet::new();
    let mut architectures = BTreeSet::new();
    for asset in &release.assets {
        if asset.asset_id != asset.sha256 || !valid_digest(&asset.sha256) || !assets.insert(&asset.asset_id)
            || !safe_relative_path(&asset.filename) || asset.filename.contains('/') || asset.size_bytes == 0 || asset.size_bytes > MAX_ASSET_BYTES
            || !matches!(asset.role.as_str(), "online-bootstrap" | "offline-installer" | "portable" | "application-payload")
            || asset.supported_native_architectures.is_empty() || asset.supported_native_architectures.len() > 2
            || asset.supported_native_architectures.iter().any(|architecture| !valid_architecture(architecture))
            || asset.supported_native_architectures.iter().collect::<BTreeSet<_>>().len() != asset.supported_native_architectures.len()
            || asset.executable_architecture.as_deref().is_some_and(|architecture| !valid_architecture(architecture))
            || asset.body_proof_sha256.as_deref().is_some_and(|digest| !valid_digest(digest))
            || !valid_content_type(&asset.content_type) {
            return Err("发行资产身份、大小或架构无效。".into());
        }
        if asset.role == "online-bootstrap" {
            if edition != "community" || asset.executable_architecture.as_deref() != Some("x64")
                || asset.body_proof_sha256.is_some() || asset.supported_native_architectures.len() != 2 || !asset.filename.to_ascii_lowercase().ends_with(".exe") {
                return Err("在线入口能力无效。".into());
            }
        } else if asset.body_proof_sha256.is_none() {
            return Err("发行资产缺少本体证明绑定。".into());
        }
        if asset.role=="offline-installer" && (asset.supported_native_architectures.len()!=1 || asset.executable_architecture.as_ref()!=asset.supported_native_architectures.first()
            || !asset.filename.to_ascii_lowercase().ends_with(".exe")) || matches!(asset.role.as_str(),"portable"|"application-payload") && (asset.executable_architecture.is_some()
            || !asset.filename.to_ascii_lowercase().ends_with(".zip") || asset.supported_native_architectures.len()!=if asset.role=="portable" {2} else {1}) {
            return Err("发行资产包型与架构不匹配。".into());
        }
        architectures.extend(asset.supported_native_architectures.iter().cloned());
    }
    let public: BTreeSet<_> = release.public_asset_ids.iter().collect();
    if public.len() != release.public_asset_ids.len() || public.iter().any(|id| !assets.contains(id)) {
        return Err("公开发行资产清单无效。".into());
    }
    if edition == "community" {
        if release.assets.len() != 3 || release.public_asset_ids.len() != 1
            || release.assets.iter().filter(|asset| asset.role == "online-bootstrap" && public.contains(&asset.asset_id)).count() != 1 {
            return Err("社区发行必须包含一个入口与两个内部载荷。".into());
        }
        for architecture in ["x64", "arm64"] {
            if release.assets.iter().filter(|asset| asset.role == "application-payload" && asset.executable_architecture.is_none()
                && asset.supported_native_architectures == [architecture.to_string()] && !public.contains(&asset.asset_id)).count() != 1 {
                return Err("社区发行架构载荷不完整。".into());
            }
        }
    } else if release.assets.len() != 3 || release.public_asset_ids.len() != 3
        || release.assets.iter().filter(|asset| asset.role == "portable" && asset.executable_architecture.is_none() && asset.supported_native_architectures.len() == 2).count() != 1
        || ["x64", "arm64"].iter().any(|architecture| release.assets.iter().filter(|asset| asset.role == "offline-installer"
            && asset.executable_architecture.as_deref() == Some(architecture) && asset.supported_native_architectures == [architecture.to_string()]).count() != 1) {
        return Err("概念发行必须包含两个单架构安装器与一个双架构绿色包。".into());
    }
    if release.architecture_evidence.len() != architectures.len() { return Err("发行原生架构证据不完整。".into()); }
    let mut evidence = BTreeSet::new();
    for item in &release.architecture_evidence {
        if !architectures.contains(&item.native_architecture) || !evidence.insert(&item.native_architecture)
            || !valid_digest(&item.evidence_id) || !item.native_package_verified || !valid_timestamp(&item.tested_at) {
            return Err("发行原生架构证据无效。".into());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignatureHeader {
    alg: String,
    kid: String,
    typ: String,
}

pub fn trusted_keys() -> Result<Value, String> {
    serde_json::from_str(env!("SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON"))
        .map_err(|_| "发行信任配置无效。".into())
}

pub fn canonical_bytes(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|error| error.to_string())
}

pub fn content_digest(value: &Value) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(canonical_bytes(value)?)))
}

pub fn parse_envelope(bytes: &[u8]) -> Result<SignedEnvelope, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROOF_BYTES {
        return Err("发行证明超过大小限制。".into());
    }
    serde_json::from_slice(bytes).map_err(|_| "发行证明格式无效。".into())
}

pub fn verify_envelope<T: DeserializeOwned>(envelope: &SignedEnvelope, purpose: &str) -> Result<T, String> {
    verify_envelope_with_keys(envelope, purpose, &trusted_keys()?)
}

pub fn verify_envelope_with_keys<T: DeserializeOwned>(envelope: &SignedEnvelope, purpose: &str, keys: &Value) -> Result<T, String> {
    if envelope.signature.len() as u64 > MAX_PROOF_BYTES * 2 {
        return Err("发行签名超过大小限制。".into());
    }
    let parts: Vec<_> = envelope.signature.split('.').collect();
    if parts.len() != 3 {
        return Err("发行签名缺失或格式错误。".into());
    }
    let decode = |value: &str| URL_SAFE_NO_PAD.decode(value).map_err(|_| "发行签名编码无效。".to_string());
    let header: SignatureHeader = serde_json::from_slice(&decode(parts[0])?).map_err(|_| "发行签名头部无效。")?;
    if header.alg != "EdDSA" || header.typ != purpose || header.kid.is_empty() {
        return Err("发行签名用途不匹配。".into());
    }
    let key = keys.as_array().and_then(|keys| keys.iter().find(|key| key["id"].as_str() == Some(&header.kid)))
        .and_then(|key| key.get("publicKey")).ok_or("发行签名密钥不受信任。")?;
    if key["kty"].as_str() != Some("OKP") || key["crv"].as_str() != Some("Ed25519") {
        return Err("发行公钥类型无效。".into());
    }
    let public = decode(key["x"].as_str().ok_or("发行公钥缺失。")?)?;
    let public: [u8; 32] = public.try_into().map_err(|_| "发行公钥长度无效。")?;
    let public = VerifyingKey::from_bytes(&public).map_err(|_| "发行公钥无效。")?;
    let signature = Signature::from_slice(&decode(parts[2])?).map_err(|_| "发行签名长度无效。")?;
    public.verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).map_err(|_| "发行签名校验失败。")?;
    let bytes = decode(parts[1])?;
    if bytes != canonical_bytes(&envelope.payload)? {
        return Err("发行证明与签名正文不一致。".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "发行合同字段无效或不受支持。".into())
}

pub fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn valid_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')) {
        return false;
    }
    let (value,build)=value.split_once('+').map_or((value,None),|(value,build)|(value,Some(build)));
    if build.is_some_and(|build|build.split('.').any(|label|label.is_empty()||!label.bytes().all(|byte|byte.is_ascii_alphanumeric()||byte==b'-'))) {return false;}
    let (numeric,prerelease)=value.split_once('-').map_or((value,None),|(value,prerelease)|(value,Some(prerelease)));
    if let Some(prerelease)=prerelease {let mut labels=prerelease.split('.');if !matches!(labels.next(),Some("alpha"|"beta"|"rc"))
        || labels.any(|label|label.is_empty()||!label.bytes().all(|byte|byte.is_ascii_alphanumeric()||byte==b'-')
            || label.len()>1&&label.starts_with('0')&&label.bytes().all(|byte|byte.is_ascii_digit())) {return false;}}
    let parts: Vec<_> = numeric.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && (part.len()==1||!part.starts_with('0')) && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub fn version_channel(version: &str) -> &'static str {
    let base = version.split('+').next().unwrap_or_default();
    let stage = base.split_once('-').map(|(_, value)| value.split('.').next().unwrap_or_default());
    match stage { Some("alpha") => "alpha", Some("beta") => "beta", Some("rc") => "rc", _ => "stable" }
}

pub fn valid_timestamp(value:&str)->bool {
    let bytes=value.as_bytes();
    bytes.len()==24 && [4,7,10,13,16,19,23].iter().all(|at|bytes[*at]==match at {4|7=>b'-',10=>b'T',13|16=>b':',19=>b'.',_=>b'Z'})
        && bytes.iter().enumerate().all(|(at,byte)|matches!(at,4|7|10|13|16|19|23)||byte.is_ascii_digit())
        && &value[17..19]<="59" && time::OffsetDateTime::parse(value,&time::format_description::well_known::Rfc3339).is_ok()
}

fn valid_content_type(value:&str)->bool {
    value.len()<=120 && value.split_once('/').is_some_and(|(family,subtype)|!family.is_empty()&&!subtype.is_empty()
        && family.as_bytes()[0].is_ascii_lowercase() && family.bytes().chain(subtype.bytes()).all(|byte|byte.is_ascii_lowercase()||byte.is_ascii_digit()||b"!#$&^_.+-".contains(&byte)))
}

pub fn valid_architecture(value: &str) -> bool {
    matches!(value, "x64" | "arm64")
}

pub fn safe_relative_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && !value.contains(['\\', ':', '\0'])
        && value.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
                && !part.chars().any(|character| character.is_control() || matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
                && !matches!(part.split('.').next().unwrap_or_default().to_ascii_uppercase().as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
                    | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
        })
}

fn path_key(value: &str) -> Result<String, String> {
    #[cfg(windows)]
    return crate::lock::windows_ordinal_upper(value).map_err(|error| error.message);
    #[cfg(not(windows))]
    Ok(value.to_uppercase())
}

pub fn validate_files(files: &[FileDescriptor]) -> Result<u64, String> {
    if files.is_empty() || files.len() > MAX_FILE_COUNT {
        return Err("发行文件清单为空或过大。".into());
    }
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for file in files {
        if !safe_relative_path(&file.path) || !valid_digest(&file.sha256) || file.size_bytes > MAX_EXPANDED_BYTES
            || file.executable_architecture.as_deref().is_some_and(|arch| !valid_architecture(arch) && arch != "anycpu")
            || file.path.to_ascii_lowercase().ends_with(".exe") && file.executable_architecture.is_none()
            || !paths.insert(path_key(&file.path)?) {
            return Err("发行文件路径、架构或摘要无效。".into());
        }
        total = total.checked_add(file.size_bytes).filter(|size| *size <= MAX_EXPANDED_BYTES).ok_or("发行解压大小超过限制。")?;
    }
    Ok(total)
}

pub fn validate_body(body: &BodyDescriptor, edition: &str, architecture: &str, variant: &str) -> Result<(), String> {
    if body.protocol_version != 1 || body.product_id != "sidekickai" || body.edition != edition
        || !matches!(edition, "community" | "concept") || !valid_version(&body.product_version)
        || body.variant != variant || !matches!(variant, "installed" | "portable") || body.platform != "windows"
        || body.maintenance_protocol_version != 1 || body.recovery_protocol_version != 1
        || !valid_architecture(architecture) || !body.native_architectures.iter().any(|arch| arch == architecture)
        || body.native_architectures.is_empty() || body.native_architectures.len() > 2
        || body.native_architectures.iter().any(|arch| !valid_architecture(arch))
        || body.native_architectures.iter().collect::<BTreeSet<_>>().len() != body.native_architectures.len() {
        return Err("本体版别、版本、架构或协议不匹配。".into());
    }
    let total = validate_files(&body.files)?;
    if body.files.iter().any(|file| file.executable_architecture.as_deref().is_some_and(|arch| arch != "anycpu" && !body.native_architectures.iter().any(|native| native == arch))) {
        return Err("本体包含其他原生架构文件。".into());
    }
    match (&body.archive, variant) {
        (Some(archive), "installed") if body.native_architectures.len() == 1
            && valid_digest(&archive.sha256) && archive.size_bytes > 0 && archive.size_bytes <= MAX_ASSET_BYTES
            && archive.expanded_bytes == total && archive.file_count == body.files.len() as u64 => {},
        (None, "portable") if edition=="concept" && body.native_architectures.len() == 2 => {},
        _ => return Err("本体归档合同无效。".into()),
    }
    if body.components.len() != body.native_architectures.len() {
        return Err("本体恢复组件数量不匹配。".into());
    }
    let mut components = BTreeSet::new();
    for component in &body.components {
        if component.component_id != "backup-runtime" || !valid_version(&component.component_version)
            || !body.native_architectures.contains(&component.native_architecture) || !components.insert(&component.native_architecture)
            || !safe_relative_path(&component.archive_path) || !safe_relative_path(&component.proof_path)
            || component.archive_path==component.proof_path || !valid_digest(&component.sha256) || component.size_bytes == 0 || component.size_bytes > MAX_ASSET_BYTES
            || !body.files.iter().any(|file| file.path == component.archive_path && file.sha256 == component.sha256 && file.size_bytes == component.size_bytes)
            || !body.files.iter().any(|file| file.path == component.proof_path) {
            return Err("本体恢复组件依赖不完整。".into());
        }
    }
    if body.files.iter().any(|file| {let path=file.path.to_ascii_lowercase();matches!(path.as_str(), "distribution-proof.json" | "body-proof.json" | "data") || path.starts_with("data/")}) {
        return Err("发行文件清单不得包含证明自身或用户资料。".into());
    }
    Ok(())
}

pub fn validate_runtime(runtime: &RuntimeDescriptor, edition: &str, architecture: &str) -> Result<(), String> {
    if runtime.protocol_version != 1 || runtime.product_id != "sidekickai" || runtime.edition != edition
        || runtime.component_id != "backup-runtime" || !valid_version(&runtime.component_version)
        || runtime.native_architecture != architecture || !valid_architecture(architecture)
        || runtime.export_protocol_version != 1 || runtime.recovery_protocol_version != 1
        || !valid_digest(&runtime.archive.sha256) || runtime.archive.size_bytes == 0 || runtime.archive.size_bytes > MAX_ASSET_BYTES
        || runtime.entrypoints.export != "export.mjs" || runtime.entrypoints.restore != "sidekick-backup.cjs"
        || runtime.files.len() > MAX_FILE_COUNT {
        return Err("独立恢复组件身份或协议不匹配。".into());
    }
    validate_files(&runtime.files)?;
    if runtime.files.iter().any(|file| file.executable_architecture.as_deref().is_some_and(|arch| arch != architecture && arch!="anycpu")) {
        return Err("独立恢复组件包含不兼容的可执行文件。".into());
    }
    for required in ["node.exe", runtime.entrypoints.export.as_str(), runtime.entrypoints.restore.as_str()] {
        if !runtime.files.iter().any(|file| file.path == required) {
            return Err("独立恢复组件缺少必要文件。".into());
        }
    }
    if runtime.files.iter().find(|file| file.path == "node.exe").and_then(|file| file.executable_architecture.as_deref()) != Some(architecture) {
        return Err("独立恢复组件 Node 架构未绑定。".into());
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    crate::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("发行资产不是常规文件。".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn verify_file(path: &Path, size: u64, digest: &str) -> Result<(), String> {
    crate::path::reject_reparse_points(path).map_err(|error| error.message)?;
    if !valid_digest(digest) || !fs::metadata(path).map_err(|error| error.to_string())?.is_file()
        || fs::metadata(path).map_err(|error| error.to_string())?.len() != size || sha256_file(path)? != digest {
        return Err("发行文件大小或摘要校验失败。".into());
    }
    Ok(())
}

pub fn pe_architecture(path: &Path) -> Result<&'static str, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    executable_architecture(&bytes)
}

pub fn executable_architecture(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() < 64 || &bytes[..2] != b"MZ" { return Err("可执行文件 DOS 头无效。".into()); }
    let at = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
    if at.checked_add(24).is_none_or(|end| end > bytes.len()) || &bytes[at..at + 4] != b"PE\0\0" {
        return Err("可执行文件 PE 头无效。".into());
    }
    let machine = u16::from_le_bytes(bytes[at + 4..at + 6].try_into().unwrap());
    if machine != 0x14c { return crate::architecture::architecture_for_machine(machine); }
    let u16_at = |at: usize| bytes.get(at..at + 2).map(|value| u16::from_le_bytes(value.try_into().unwrap())).ok_or("托管 PE 被截断。");
    let u32_at = |at: usize| bytes.get(at..at + 4).map(|value| u32::from_le_bytes(value.try_into().unwrap())).ok_or("托管 PE 被截断。");
    let optional_size = u16_at(at + 20)? as usize;
    let optional = at + 24;
    let sections = optional.checked_add(optional_size).ok_or("托管 PE 节表无效。")?;
    let section_count = u16_at(at + 6)? as usize;
    if u16_at(optional)? != 0x10b || optional_size < 224 || u32_at(optional + 92)? < 15 || section_count == 0 || section_count > 96 {
        return Err("可执行文件不是受支持的 AnyCPU 程序。".into());
    }
    let clr_rva = u32_at(optional + 96 + 14 * 8)?;
    let clr_size = u32_at(optional + 96 + 14 * 8 + 4)?;
    if clr_size < 72 { return Err("AnyCPU CLR 头无效。".into()); }
    for index in 0..section_count {
        let section = sections + index * 40;
        let virtual_address = u32_at(section + 12)?;
        let raw_size = u32_at(section + 16)?;
        let raw_offset = u32_at(section + 20)? as usize;
        if let Some(relative) = clr_rva.checked_sub(virtual_address).filter(|relative| relative.checked_add(clr_size).is_some_and(|end| end <= raw_size)) {
            let offset = raw_offset.checked_add(relative as usize).ok_or("AnyCPU CLR 地址无效。")?;
            if raw_offset.checked_add(raw_size as usize).is_none_or(|end| end > bytes.len()) || u32_at(offset)? < 72 {
                return Err("AnyCPU CLR 超出文件范围。".into());
            }
            let flags = u32_at(offset + 16)?;
            if flags & 1 != 0 && flags & (2 | 0x20000) == 0 { return Ok("anycpu"); }
            return Err("托管程序要求或优先使用 32 位架构。".into());
        }
    }
    Err("AnyCPU CLR 地址未映射到文件节。".into())
}

pub fn verify_declared_files(root: &Path, files: &[FileDescriptor]) -> Result<(), String> {
    validate_files(files)?;
    for file in files {
        let path = root.join(&file.path);
        verify_file(&path, file.size_bytes, &file.sha256)?;
        if let Some(architecture) = &file.executable_architecture {
            if pe_architecture(&path)? != architecture {
                return Err("发行可执行文件架构不匹配。".into());
            }
        }
    }
    Ok(())
}

pub fn extract_verified_zip(archive: &Path, files: &[FileDescriptor], destination: &Path) -> Result<(), String> {
    validate_files(files)?;
    crate::path::reject_reparse_points(destination).map_err(|error| error.message)?;
    if fs::read_dir(destination).map_err(|error| error.to_string())?.next().is_some() {
        return Err("发行解压目录必须为空。".into());
    }
    let declared: BTreeMap<_, _> = files.iter().map(|file| (file.path.as_str(), file)).collect();
    let mut archive = zip::ZipArchive::new(File::open(archive).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    if archive.len() != files.len() { return Err("发行归档文件数量不匹配。".into()); }
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        let expected = declared.get(name.as_str()).ok_or("发行归档包含未声明文件。")?;
        if !safe_relative_path(&name) || !seen.insert(path_key(&name)?) || entry.is_dir()
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            || entry.size() != expected.size_bytes {
            return Err("发行归档路径、类型或大小无效。".into());
        }
        let target = destination.join(&name);
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        crate::path::reject_reparse_points(&target).map_err(|error| error.message)?;
        let mut target = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|error| error.to_string())?;
        let mut digest = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = entry.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 { break; }
            total = total.checked_add(count as u64).filter(|size| *size <= expected.size_bytes).ok_or("发行解压文件超过大小限制。")?;
            digest.update(&buffer[..count]);
            target.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
        }
        target.sync_all().map_err(|error| error.to_string())?;
        if total != expected.size_bytes || format!("{:x}", digest.finalize()) != expected.sha256 {
            return Err("发行解压内容摘要不匹配。".into());
        }
    }
    verify_declared_files(destination, files)
}


#[cfg(windows)]
pub fn harden_private_directory(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    crate::path::reject_reparse_points(path).map_err(|error| error.message)?;
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|error| error.to_string())?;
        let result = (|| {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
            if size == 0 || size > 64 * 1024 { return Err("无法读取当前用户身份。".to_string()); }
            let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
            GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), size, &mut size).map_err(|error| error.to_string())?;
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut sid = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(|error| error.to_string())?;
            let text = sid.to_string().map_err(|error| error.to_string());
            let _ = LocalFree(HLOCAL(sid.0.cast()));
            let text = text?;
            if !text.starts_with("S-1-") || text.chars().any(|character| character.is_whitespace() || matches!(character, '(' | ')' | ';')) {
                return Err("当前用户身份无效。".into());
            }
            let sddl: Vec<u16> = format!("O:{text}D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;{text})").encode_utf16().chain(Some(0)).collect();
            let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut descriptor, None).map_err(|error| error.to_string())?;
            let applied = SetFileSecurityW(PCWSTR(path.as_ptr()), DACL_SECURITY_INFORMATION, descriptor);
            let applied = if applied.as_bool() { SetFileSecurityW(PCWSTR(path.as_ptr()), OWNER_SECURITY_INFORMATION, descriptor) } else { applied };
            let error = (!applied.as_bool()).then(std::io::Error::last_os_error);
            let _ = LocalFree(HLOCAL(descriptor.0));
            if let Some(error) = error { return Err(format!("无法设置私有目录权限：{error}")); }
            Ok(())
        })();
        let _ = CloseHandle(token);
        result
    }
}

#[cfg(not(windows))]
pub fn harden_private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

pub struct VerifiedRuntime {
    pub descriptor: RuntimeDescriptor,
    pub directory: std::path::PathBuf,
    _files: Vec<File>,
    _directories: Vec<File>,
}

pub struct VerifiedFiles {
    _files: Vec<File>,
    _directories: Vec<File>,
}

pub fn pin_declared_files(root: &Path, files: &[FileDescriptor]) -> Result<VerifiedFiles, String> {
    crate::path::reject_reparse_points(root).map_err(|error| error.message)?;
    let mut handles = Vec::new();
    let mut directory_handles = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut directories = BTreeSet::new();
        for ancestor in root.ancestors() { directories.insert(ancestor.to_path_buf()); }
        for descriptor in files {
            let mut parent = root.join(&descriptor.path).parent().map(Path::to_path_buf);
            while let Some(path) = parent.filter(|path| path.starts_with(root)) {
                directories.insert(path.clone()); parent = path.parent().map(Path::to_path_buf);
            }
        }
        for directory in directories {
            crate::path::reject_reparse_points(&directory).map_err(|error| error.message)?;
            directory_handles.push(fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x02200000)
                .open(directory).map_err(|error| format!("无法固定产品目录：{error}"))?);
        }
    }
    for descriptor in files {
        let path = root.join(&descriptor.path);
        crate::path::reject_reparse_points(&path).map_err(|error| error.message)?;
        let mut options = fs::OpenOptions::new(); options.read(true);
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(1); }
        handles.push(options.open(path).map_err(|error| format!("无法固定产品文件：{error}"))?);
    }
    verify_declared_files(root, files)?;
    Ok(VerifiedFiles { _files: handles, _directories: directory_handles })
}

pub fn read_envelope(path: &Path) -> Result<SignedEnvelope, String> {
    crate::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("发行证明不是常规文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PROOF_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    parse_envelope(&bytes)
}

pub fn prepare_runtime(installation_root: &Path, destination: &Path, edition: &str, architecture: &str) -> Result<VerifiedRuntime, String> {
    prepare_runtime_with_keys(installation_root,destination,edition,architecture,&trusted_keys()?)
}

pub fn prepare_runtime_with_keys(installation_root: &Path, destination: &Path, edition: &str, architecture: &str, keys: &Value) -> Result<VerifiedRuntime, String> {
    let proof = read_envelope(&installation_root.join("distribution-proof.json"))?;
    let body: BodyDescriptor = verify_envelope_with_keys(&proof, BODY_PROOF_TYPE,keys)?;
    validate_body(&body, edition, architecture, &body.variant)?;
    prepare_bound_runtime_with_keys(installation_root, destination, &body, architecture,keys)
}

pub fn prepare_bound_runtime(root: &Path, destination: &Path, body: &BodyDescriptor, architecture: &str) -> Result<VerifiedRuntime, String> {
    prepare_bound_runtime_with_keys(root,destination,body,architecture,&trusted_keys()?)
}

pub fn prepare_bound_runtime_with_keys(root: &Path, destination: &Path, body: &BodyDescriptor, architecture: &str, keys: &Value) -> Result<VerifiedRuntime, String> {
    crate::path::reject_reparse_points(root).map_err(|error| error.message)?;
    crate::path::reject_reparse_points(destination).map_err(|error| error.message)?;
    let component = body.components.iter().find(|component| component.native_architecture == architecture)
        .ok_or("本体没有当前架构的独立恢复组件。")?;
    let proof_file = body.files.iter().find(|file| file.path == component.proof_path).ok_or("本体未绑定恢复证明。")?;
    let proof_path = root.join(&component.proof_path);
    verify_file(&proof_path, proof_file.size_bytes, &proof_file.sha256)?;
    let proof = read_envelope(&proof_path)?;
    let runtime: RuntimeDescriptor = verify_envelope_with_keys(&proof, RUNTIME_PROOF_TYPE,keys)?;
    validate_runtime(&runtime, &body.edition, architecture)?;
    if runtime.component_version != component.component_version || runtime.archive.sha256 != component.sha256
        || runtime.archive.size_bytes != component.size_bytes {
        return Err("独立恢复组件与本体依赖不一致。".into());
    }
    let source = root.join(&component.archive_path);
    verify_file(&source, component.size_bytes, &component.sha256)?;
    let archive = destination.join("backup-runtime.zip");
    fs::copy(&source, &archive).map_err(|error| format!("无法准备独立恢复组件：{error}"))?;
    verify_file(&archive, runtime.archive.size_bytes, &runtime.archive.sha256)?;
    let directory = destination.join("runtime");
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    extract_verified_zip(&archive, &runtime.files, &directory)?;
    let mut handles = Vec::new();
    let mut directory_handles = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut directories = BTreeSet::from([destination.to_path_buf(), directory.clone()]);
        for file in &runtime.files {
            let mut parent = directory.join(&file.path).parent().map(Path::to_path_buf);
            while let Some(path) = parent.filter(|path| path.starts_with(&directory)) {
                directories.insert(path.clone());
                parent = path.parent().map(Path::to_path_buf);
            }
        }
        for path in directories {
            directory_handles.push(fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x02200000)
                .open(path).map_err(|error| format!("无法固定独立恢复目录：{error}"))?);
        }
    }
    for descriptor in &runtime.files {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        handles.push(options.open(directory.join(&descriptor.path)).map_err(|error| format!("无法固定独立恢复文件：{error}"))?);
    }
    verify_declared_files(&directory, &runtime.files)?;
    Ok(VerifiedRuntime { descriptor: runtime, directory, _files: handles, _directories: directory_handles })
}


#[cfg(test)]
mod tests;
