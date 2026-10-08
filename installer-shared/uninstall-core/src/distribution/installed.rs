use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationReceipt {
    pub protocol_version: u32,
    pub edition: String,
    pub product_version: String,
    pub native_architecture: String,
    pub body_proof_sha256: String,
    #[serde(deserialize_with = "required_nullable")]
    pub release_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub release_manifest_sha256: Option<String>,
    pub installation_id: String,
}

#[derive(Clone, Debug)]
pub struct InstalledIdentity {
    pub body: BodyDescriptor,
    pub receipt: InstallationReceipt,
}

fn bounded_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    crate::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let file = File::open(path).map_err(|_| "该安装缺少新发行合同身份；请使用原安装的维护入口。")?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err("安装发行身份不是受限普通文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit { return Err("安装发行身份超过大小限制。".into()); }
    Ok(bytes)
}

pub fn verify_installed_identity(root: &Path) -> Result<InstalledIdentity, String> {
    verify_installed_identity_with_keys(root, &trusted_keys()?)
}

pub fn verify_installed_identity_with_keys(root: &Path, keys: &Value) -> Result<InstalledIdentity, String> {
    if root.join("portable.txt").exists() { return Err("绿色版本不登记安装维护身份。".into()); }
    let proof = parse_envelope(&bounded_file(&root.join("distribution-proof.json"), MAX_PROOF_BYTES)?)?;
    let body: BodyDescriptor = verify_envelope_with_keys(&proof, BODY_PROOF_TYPE, keys)?;
    let bytes = bounded_file(&root.join("maintenance/distribution-receipt.json"), 64 * 1024)?;
    let receipt: InstallationReceipt = serde_json::from_slice(&bytes).map_err(|_| "安装发行记录格式无效。")?;
    validate_body(&body, &receipt.edition, &receipt.native_architecture, "installed")?;
    if receipt.protocol_version != 1 || receipt.product_version != body.product_version
        || receipt.body_proof_sha256 != content_digest(&proof.payload)?
        || receipt.installation_id.is_empty() || receipt.installation_id.len() > 256
        || !receipt.installation_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("安装发行记录与已签名本体不一致。".into());
    }
    match (&receipt.release_id, &receipt.release_manifest_sha256) {
        (None, None) => {},
        (Some(id), Some(digest)) if valid_release_id(id) && valid_digest(digest) => {},
        _ => return Err("安装发行集合绑定无效。".into()),
    }
    let (registration, _) = crate::product::read_install_receipt(root)?;
    if registration.edition != body.edition || registration.version != body.product_version || registration.arch != receipt.native_architecture {
        return Err("安装登记与已签名本体不一致。".into());
    }
    if let Ok(package) = crate::product::package_identity(&root.join("resources/app.asar")) {
        if package.name != crate::product::product().editions[&body.edition].package_name {
            return Err("安装应用的产品路线与签名身份不一致。".into());
        }
    }
    Ok(InstalledIdentity { body, receipt })
}
