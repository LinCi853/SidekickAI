// Public resource acquisition and recoverable landing. Resource files contain
// exact signed envelope bytes; native proof verification uses embedded public
// trust, and program deployment owns rollback until every file is committed.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};

use crate::manifest::CloudAssetRequest;

/// Resource-package envelope byte limit from the shared contract.
pub const MAX_RESOURCE_PACKAGE_BYTES: u64 = 200_000;

const CLOUD_PREFIX: &str = "resources/cloud/";

fn configured_origin() -> Result<reqwest::Url, String> {
    let configured = env!("SIDEKICK_OXY_ORIGIN");
    let fallback = if cfg!(debug_assertions) { "http://localhost:4318" } else { "" };
    let origin = if configured.is_empty() { fallback } else { configured };
    let url = reqwest::Url::parse(origin).map_err(|_| "尚未配置正式资源来源。")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path() != "/"
        || (url.scheme() != "https" && !(local && url.scheme() == "http")) {
        return Err("资源来源必须是 HTTPS，且不得包含凭据或查询参数。".into());
    }
    Ok(url)
}

pub fn fetch_resource_catalog(resource_type: &str) -> Result<serde_json::Value, String> {
    if resource_type == "default-configuration" {
        return fetch_public_json(configured_origin()?.join("/api/public/v1/resource-packages/default-configuration").map_err(|error| error.to_string())?);
    }
    validate_resource_type(resource_type)?;
    let origin = configured_origin()?;
    let endpoint = origin.join(&format!("/api/public/v1/resource-packages?type={resource_type}&limit=200")).map_err(|error| error.to_string())?;
    fetch_public_json(endpoint)
}

fn validate_resource_type(resource_type: &str) -> Result<(), String> {
    if !["ai-app-catalog", "rule", "device-preset", "ai-supplier", "oxy-baseline"].contains(&resource_type) {
        return Err("不支持的安装器资源类型。".into());
    }
    Ok(())
}

pub fn fetch_resource_package(resource_type: &str, resource_id: &str, version: &str) -> Result<serde_json::Value, String> {
    validate_resource_type(resource_type)?;
    if resource_id.is_empty() || resource_id.len() > 80 || !resource_id.bytes().all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
        || version.is_empty() || version.len() > 32 || !version.bytes().all(|value| value.is_ascii_alphanumeric() || value == b'.' || value == b'-') {
        return Err("资源下载标识无效。".into());
    }
    let endpoint = configured_origin()?.join(&format!("/api/public/v1/resource-packages/{resource_type}/{resource_id}/{version}/download")).map_err(|error| error.to_string())?;
    fetch_public_json(endpoint)
}

fn fetch_public_json(endpoint: reqwest::Url) -> Result<serde_json::Value, String> {
    use std::io::Read;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|error| format!("无法准备资源请求：{error}"))?;
    let response = client.get(endpoint).header("Accept", "application/json").send()
        .and_then(|response| response.error_for_status()).map_err(|error| format!("资源目录不可用：{error}"))?;
    if !response.status().is_success() { return Err("不接受资源目录重定向。".into()); }
    let max_bytes = 40_000_000u64;
    if response.content_length().is_some_and(|size| size > max_bytes) {
        return Err("资源目录超出下载大小上限。".into());
    }
    let mut bytes = Vec::new();
    response.take(max_bytes + 1).read_to_end(&mut bytes).map_err(|error| format!("无法读取资源目录：{error}"))?;
    if bytes.len() as u64 > max_bytes { return Err("资源目录超出下载大小上限。".into()); }
    serde_json::from_slice(&bytes).map_err(|error| format!("资源目录 JSON 无效：{error}"))
}

pub fn trusted_resource_keys() -> Result<serde_json::Value, String> {
    serde_json::from_str(env!("SIDEKICK_RESOURCE_TRUST_KEYS_JSON"))
        .map_err(|error| format!("资源信任配置无效：{error}"))
}

pub fn verify_resource_proof(asset: &CloudAssetRequest) -> Result<(), String> {
    verify_resource_proof_with_keys(asset, &trusted_resource_keys()?)
}

fn verify_resource_proof_with_keys(asset: &CloudAssetRequest, keys: &serde_json::Value) -> Result<(), String> {
    if !is_safe_cloud_destination(&asset.destination) || asset.payload_json.len() as u64 > MAX_RESOURCE_PACKAGE_BYTES {
        return Err("资源信封或目标路径不安全。".into());
    }
    if asset.size_bytes != asset.payload_json.len() as u64 || sha256_hex(asset.payload_json.as_bytes()) != asset.digest {
        return Err("资源信封完整性校验失败。".into());
    }
    let parts: Vec<&str> = asset.signed_token.split('.').collect();
    if parts.len() != 3 { return Err("资源签名缺失或格式错误。".into()); }
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| "资源签名编码格式错误。".to_string());
    let header: serde_json::Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| "资源签名头部格式错误。")?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("EdDSA")
        || header.get("typ").and_then(|v| v.as_str()) != Some("oxy-resource-package")
        || header.as_object().map(|value| value.len()) != Some(3) {
        return Err("资源签名用途无效。".into());
    }
    let kid = header.get("kid").and_then(|v| v.as_str()).ok_or("资源签名密钥缺失。")?;
    let key = keys.as_array().and_then(|keys| keys.iter().find(|key| key.get("id").and_then(|v| v.as_str()) == Some(kid)))
        .and_then(|key| key.get("publicKey")).ok_or("资源签名密钥不受信任。")?;
    if key.get("kty").and_then(|v| v.as_str()) != Some("OKP") || key.get("crv").and_then(|v| v.as_str()) != Some("Ed25519") {
        return Err("配置的资源密钥格式不受支持。".into());
    }
    let raw_key = decode(key.get("x").and_then(|v| v.as_str()).ok_or("资源密钥内容缺失。")?)?;
    let key_bytes: [u8; 32] = raw_key.try_into().map_err(|_| "资源密钥长度无效。")?;
    let verifying_key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| "资源密钥无效。")?;
    let signature = Signature::from_slice(&decode(parts[2])?).map_err(|_| "资源签名长度无效。")?;
    verifying_key.verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .map_err(|_| "资源签名校验失败。")?;
    if decode(parts[1])? != asset.payload_json.as_bytes() { return Err("已签名资源内容与信封不一致。".into()); }
    let envelope: serde_json::Value = serde_json::from_str(&asset.payload_json).map_err(|_| "资源信封 JSON 无效。")?;
    let kind = envelope.get("resourceType").and_then(|v| v.as_str()).ok_or("资源类型缺失。")?;
    let id = envelope.get("resourceId").and_then(|v| v.as_str()).ok_or("资源标识缺失。")?;
    let version = envelope.get("version").and_then(|v| v.as_str()).ok_or("资源版本缺失。")?;
    let expected_destination = format!("resources/cloud/{kind}/{id}/{id}-{version}.json");
    if envelope.get("formatVersion").and_then(|v| v.as_u64()) != Some(1)
        || asset.asset_id != format!("{kind}/{id}@{version}") || version != asset.version || asset.destination != expected_destination {
        return Err("资源标识与已签名信封不匹配。".into());
    }
    if !["theme", "rule", "device-preset", "ai-supplier", "ai-app-catalog", "oxy-baseline"].contains(&kind) {
        return Err("不支持的资源类型。".into());
    }
    Ok(())
}

/// Destination must stay under `resources/cloud/` with no traversal, no
/// absolute prefix and no backslashes.
pub fn is_safe_cloud_destination(destination: &str) -> bool {
    if destination.is_empty() || destination.len() > 240 {
        return false;
    }
    if destination.contains("..") || destination.contains('\\') {
        return false;
    }
    if destination.starts_with('/') || destination.contains(':') {
        return false;
    }
    if !destination.starts_with(CLOUD_PREFIX) {
        return false;
    }
    destination[CLOUD_PREFIX.len()..]
        .split('/')
        .all(|segment| !segment.is_empty() && !segment.contains(' ') && !segment.contains('\0'))
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Unique temporary directory for one cloud landing transaction.
fn unique_cloud_staging() -> Result<PathBuf, String> {
    let base = std::env::temp_dir();
    for attempt in 0..16u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let candidate = base.join(format!(
            "SidekickAI-Cloud-{}-{nanos}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("无法创建云端资源暂存目录：{error}"));
            }
        }
    }
    Err("无法分配云端资源暂存目录".into())
}

fn remove_quiet(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// Stage one asset's bytes under the staging root and verify integrity.
fn stage_one(staging_root: &Path, asset: &CloudAssetRequest, keys: &serde_json::Value) -> Result<PathBuf, String> {
    if !is_safe_cloud_destination(&asset.destination) {
        return Err(format!("云端资源目标路径非法：{}", asset.destination));
    }
    if !is_lower_hex_sha256(&asset.digest) {
        return Err(format!("云端资源摘要格式无效：{}", asset.asset_id));
    }
    if asset.size_bytes == 0 {
        return Err(format!("云端资源大小无效：{}", asset.asset_id));
    }

    let bytes: Vec<u8> = if asset.kind == "resource-package" {
        if asset.payload_json.is_empty() {
            return Err(format!("资源包缺少载荷：{}", asset.asset_id));
        }
        if asset.payload_json.len() as u64 > MAX_RESOURCE_PACKAGE_BYTES {
            return Err(format!(
                "资源包 {} 载荷超出大小上限（{} > {}）",
                asset.asset_id,
                asset.payload_json.len(),
                MAX_RESOURCE_PACKAGE_BYTES
            ));
        }
        // Prove the payload is well-formed JSON before any live write.
        serde_json::from_str::<serde_json::Value>(&asset.payload_json)
            .map_err(|error| format!("资源包 {} 载荷不是合法 JSON：{error}", asset.asset_id))?;
        let bytes = asset.payload_json.clone().into_bytes();
        if bytes.len() as u64 != asset.size_bytes {
            return Err(format!("资源信封大小不一致：{}", asset.asset_id));
        }
        if sha256_hex(&bytes) != asset.digest {
            return Err(format!("资源信封摘要不一致：{}", asset.asset_id));
        }
        verify_resource_proof_with_keys(asset, keys)?;
        bytes
    } else if asset.kind == "distribution" {
        let source = Path::new(&asset.source_path);
        let metadata = fs::metadata(source)
            .map_err(|error| format!("无法读取已下载资产 {}：{error}", asset.asset_id))?;
        if !metadata.is_file() {
            return Err(format!("已下载资产不是普通文件：{}", asset.asset_id));
        }
        if metadata.len() != asset.size_bytes {
            return Err(format!(
                "资产 {} 大小不符：期望 {}，实际 {}",
                asset.asset_id,
                asset.size_bytes,
                metadata.len()
            ));
        }
        let bytes =
            fs::read(source).map_err(|error| format!("读取资产 {} 失败：{error}", asset.asset_id))?;
        let digest = sha256_hex(&bytes);
        if digest != asset.digest {
            return Err(format!(
                "资产 {} 摘要不符：期望 {}，实际 {digest}",
                asset.asset_id, asset.digest
            ));
        }
        bytes
    } else {
        return Err(format!("未知云端资源类型：{}", asset.kind));
    };

    let staged_path = staging_root.join(&asset.destination);
    if let Some(parent) = staged_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建云端暂存目录 {}：{error}", parent.display()))?;
    }
    fs::write(&staged_path, &bytes)
        .map_err(|error| format!("写入云端暂存文件失败：{error}"))?;
    let written = fs::metadata(&staged_path)
        .map_err(|error| format!("读取云端暂存文件失败：{error}"))?
        .len();
    if written != bytes.len() as u64 {
        return Err(format!(
            "云端暂存文件长度异常：{} != {}",
            written,
            bytes.len()
        ));
    }
    Ok(staged_path)
}

/// Copy a staged file into the live install tree, creating parents.
fn commit_one(install_dir: &Path, staged_root: &Path, destination: &str) -> Result<(), String> {
    let staged = staged_root.join(destination);
    let live = install_dir.join(destination);
    if let Some(parent) = live.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建安装目录 {}：{error}", parent.display()))?;
    }
    // Write to a sibling temp name then rename onto the final path so a crash
    // never leaves a half-written JSON under the live tree.
    let temp = live.with_extension("landing-tmp");
    fs::copy(&staged, &temp)
        .map_err(|error| format!("写入云端资源 {} 失败：{error}", destination))?;
    fs::rename(&temp, &live).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("提交云端资源 {} 失败：{error}", destination)
    })?;
    Ok(())
}

/// Land every verified cloud asset into `install_dir`.
///
/// Returns Ok(()) when there is nothing to do or when every asset staged and
/// committed. Any error leaves no partial live cloud tree: staged copies are
/// removed, and destinations that were already committed in this call are
/// removed again so the surrounding install rollback sees a clean pre-cloud
/// state.
pub fn land_cloud_assets(
    install_dir: &Path,
    assets: &[CloudAssetRequest],
    status: &dyn Fn(&str),
) -> Result<(), String> {
    land_cloud_assets_with_keys(install_dir, assets, status, &trusted_resource_keys()?)
}

fn land_cloud_assets_with_keys(
    install_dir: &Path,
    assets: &[CloudAssetRequest],
    status: &dyn Fn(&str),
    keys: &serde_json::Value,
) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }

    status("正在校验云端资源…");
    let staging_root = unique_cloud_staging()?;
    let staged = (|| -> Result<Vec<String>, String> {
        let mut destinations = Vec::new();
        for asset in assets {
            stage_one(&staging_root, asset, keys)?;
            destinations.push(asset.destination.clone());
        }
        Ok(destinations)
    })();

    let destinations = match staged {
        Ok(destinations) => destinations,
        Err(error) => {
            remove_quiet(&staging_root);
            return Err(error);
        }
    };

    status("正在写入云端资源…");
    let mut committed: Vec<String> = Vec::new();
    for destination in &destinations {
        if let Err(error) = commit_one(install_dir, &staging_root, destination) {
            // Undo only the destinations this call already wrote. The install
            // tail treats this Err as a full install failure and restores the
            // pre-install tree from its own backup.
            for done in &committed {
                remove_quiet(&install_dir.join(done));
            }
            remove_quiet(&staging_root);
            return Err(error);
        }
        committed.push(destination.clone());
    }

    remove_quiet(&staging_root);
    status(&format!("已写入 {} 项云端资源", committed.len()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keys() -> serde_json::Value {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        serde_json::json!([{ "id": "fixture", "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()) } }])
    }

    fn land_test_assets(install: &Path, assets: &[CloudAssetRequest], status: &dyn Fn(&str)) -> Result<(), String> {
        land_cloud_assets_with_keys(install, assets, status, &test_keys())
    }

    fn asset(destination: &str) -> CloudAssetRequest {
        let payload = r#"{"formatVersion":1,"payload":{"displayName":"Oxy Dark","mode":"dark"},"resourceId":"oxy-dark","resourceType":"theme","version":"1.0.0"}"#;
        use ed25519_dalek::Signer;
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"oxy-resource-package","kid":"fixture"}"#);
        let signing_input = format!("{}.{}", header, URL_SAFE_NO_PAD.encode(payload.as_bytes()));
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let signed_token = format!("{}.{}", signing_input, URL_SAFE_NO_PAD.encode(key.sign(signing_input.as_bytes()).to_bytes()));
        CloudAssetRequest {
            asset_id: "theme/oxy-dark@1.0.0".into(),
            version: "1.0.0".into(),
            digest: sha256_hex(payload.as_bytes()),
            size_bytes: payload.len() as u64,
            kind: "resource-package".into(),
            destination: destination.into(),
            payload_json: payload.into(),
            source_path: String::new(),
            signed_token,
        }
    }

    fn temporary_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("sidekick-cloud-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_unsafe_destinations() {
        assert!(!is_safe_cloud_destination(""));
        assert!(!is_safe_cloud_destination("resources/cloud/../x.json"));
        assert!(!is_safe_cloud_destination("/resources/cloud/x.json"));
        assert!(!is_safe_cloud_destination(r"resources\cloud\x.json"));
        assert!(!is_safe_cloud_destination("resources/other/x.json"));
        assert!(is_safe_cloud_destination("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json"));
    }

    #[test]
    fn accepts_a_resource_from_the_actual_service_signing_cli() {
        let vector: serde_json::Value = serde_json::from_str(include_str!("../../../installer-shared/on-demand/fixtures/issuer-resource.json")).unwrap();
        let asset: CloudAssetRequest = serde_json::from_value(vector["asset"].clone()).unwrap();
        let keys = &vector["keys"];
        verify_resource_proof_with_keys(&asset, keys).unwrap();
        let root = temporary_root("issuer-vector");
        land_cloud_assets_with_keys(&root, &[asset.clone()], &|_| {}, keys).unwrap();
        assert_eq!(fs::read(root.join(&asset.destination)).unwrap(), asset.payload_json.as_bytes());
        let mut corrupted = asset;
        corrupted.version = "2.0.0".into();
        assert!(verify_resource_proof_with_keys(&corrupted, keys).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_catalog_uses_only_the_public_endpoint_and_rejects_redirects() {
        use std::io::{Read, Write};
        for (status, body, expected) in [("200 OK", r#"{"items":[]}"#, true), ("302 Found", r#"{"items":[]}"#, false)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = [0u8; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(request.starts_with("GET /api/public/v1/resource-packages?type=rule&limit=200 HTTP/1.1"));
                assert!(!request.to_ascii_lowercase().contains("authorization:"));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let result = fetch_public_json(reqwest::Url::parse(&format!("http://{address}/api/public/v1/resource-packages?type=rule&limit=200")).unwrap());
            assert_eq!(result.is_ok(), expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn signature_requires_pinned_trust_and_exact_signed_bytes() {
        let mut valid = asset("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json");
        assert!(verify_resource_proof_with_keys(&valid, &test_keys()).is_ok());
        assert!(verify_resource_proof_with_keys(&valid, &serde_json::json!([])).is_err());
        valid.payload_json = valid.payload_json.replace("Oxy Dark", "Modified");
        valid.digest = sha256_hex(valid.payload_json.as_bytes());
        valid.size_bytes = valid.payload_json.len() as u64;
        assert!(verify_resource_proof_with_keys(&valid, &test_keys()).is_err());
    }

    #[test]
    fn rejects_resource_envelope_digest_mismatch() {
        let root = temporary_root("resource-digest");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        let mut bad = asset("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json");
        bad.digest = "b".repeat(64);
        assert!(land_test_assets(&install, &[bad], &|_| {}).is_err());
        assert!(!install.join("resources").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lands_resource_packages_into_the_install_tree() {
        let root = temporary_root("land");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        let assets = vec![asset("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json")];
        land_test_assets(&install, &assets, &|_| {}).unwrap();
        let landed = install.join("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json");
        assert!(landed.is_file());
        let body = fs::read_to_string(&landed).unwrap();
        assert!(body.contains("Oxy Dark"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_invalid_payload_without_touching_the_install_tree() {
        let root = temporary_root("reject");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        let mut bad = asset("resources/cloud/theme/oxy-dark/oxy-dark-1.0.0.json");
        bad.payload_json = "{not-json".into();
        let error = land_test_assets(&install, &[bad], &|_| {}).unwrap_err();
        assert!(error.contains("JSON"));
        assert!(!install.join("resources").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_distribution_file_whose_digest_mismatches() {
        let root = temporary_root("digest");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        let downloaded = root.join("downloaded.bin");
        fs::write(&downloaded, b"hello-cloud").unwrap();
        let asset = CloudAssetRequest {
            asset_id: "e".repeat(64),
            version: "1.0.0".into(),
            digest: "b".repeat(64),
            size_bytes: 11,
            kind: "distribution".into(),
            destination: "resources/cloud/distribution/demo/demo.bin".into(),
            payload_json: String::new(),
            source_path: downloaded.to_string_lossy().into_owned(),
            signed_token: String::new(),
        };
        let error = land_test_assets(&install, &[asset], &|_| {}).unwrap_err();
        assert!(error.contains("摘要不符"));
        assert!(!install.join("resources").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_a_distribution_file_whose_digest_matches() {
        let root = temporary_root("digest-ok");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        let downloaded = root.join("downloaded.bin");
        let bytes = b"hello-cloud";
        fs::write(&downloaded, bytes).unwrap();
        let asset = CloudAssetRequest {
            asset_id: "e".repeat(64),
            version: "1.0.0".into(),
            digest: sha256_hex(bytes),
            size_bytes: bytes.len() as u64,
            kind: "distribution".into(),
            destination: "resources/cloud/distribution/demo/demo.bin".into(),
            payload_json: String::new(),
            source_path: downloaded.to_string_lossy().into_owned(),
            signed_token: String::new(),
        };
        land_test_assets(&install, &[asset], &|_| {}).unwrap();
        assert_eq!(
            fs::read(install.join("resources/cloud/distribution/demo/demo.bin")).unwrap(),
            bytes.to_vec()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_asset_list_is_a_no_op() {
        let root = temporary_root("noop");
        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        land_test_assets(&install, &[], &|_| {}).unwrap();
        assert!(!install.join("resources").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
