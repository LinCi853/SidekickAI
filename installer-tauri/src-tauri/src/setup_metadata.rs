use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::manifest::{InstallFeature, InstallOption};

pub(crate) const FOOTER_SIZE: u64 = 68;
const MAX_METADATA: u64 = 1024 * 1024;
const MAX_EXTRACTOR: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BlobDescriptor {
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetupMetadata {
    pub schema_version: u32,
    pub edition: String,
    pub product_version: String,
    pub component_version: String,
    pub uninstall_protocol_version: u32,
    pub features: Vec<InstallFeature>,
    pub options: Vec<InstallOption>,
    pub payload: Option<BlobDescriptor>,
    pub extractor: Option<BlobDescriptor>,
}

pub(crate) struct Layout {
    pub payload_offset: u64,
    pub payload_size: u64,
    pub extractor_size: u64,
    pub metadata_offset: u64,
    pub metadata_size: u64,
    pub metadata_digest: [u8; 32],
    pub file_size: u64,
}

fn invalid() -> String { "安装包元数据无效或不兼容，请重新获取安装包。".into() }

pub(crate) fn read_layout(file: &mut File) -> Result<Layout, String> {
    let file_size = file.metadata().map_err(|_| invalid())?.len();
    if file_size <= FOOTER_SIZE { return Err(invalid()); }
    file.seek(SeekFrom::End(-(FOOTER_SIZE as i64))).map_err(|_| invalid())?;
    let mut footer = [0u8; FOOTER_SIZE as usize];
    file.read_exact(&mut footer).map_err(|_| invalid())?;
    if &footer[..8] != b"SKPAYLD2" || u32::from_le_bytes(footer[64..68].try_into().unwrap()) != FOOTER_SIZE as u32 {
        return Err(invalid());
    }
    let size = |at| u64::from_le_bytes(footer[at..at + 8].try_into().unwrap());
    let (payload_size, extractor_size, metadata_size) = (size(8), size(16), size(24));
    if payload_size == 0 || extractor_size == 0 || extractor_size > MAX_EXTRACTOR || metadata_size == 0 || metadata_size > MAX_METADATA {
        return Err(invalid());
    }
    let suffix = payload_size.checked_add(extractor_size).and_then(|size| size.checked_add(metadata_size))
        .and_then(|size| size.checked_add(FOOTER_SIZE)).ok_or_else(invalid)?;
    let payload_offset = file_size.checked_sub(suffix).filter(|offset| *offset > 0).ok_or_else(invalid)?;
    let metadata_offset = file_size - FOOTER_SIZE - metadata_size;
    Ok(Layout { payload_offset, payload_size, extractor_size, metadata_offset, metadata_size,
        metadata_digest: footer[32..64].try_into().unwrap(), file_size })
}

fn valid_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+')) { return false; }
    let numeric = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = numeric.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn validate(value: &SetupMetadata) -> Result<(), String> {
    use sidekickai_uninstall_core::product;
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../../maintenance/component-contract.json")).map_err(|_| invalid())?;
    if value.schema_version != 2 || value.edition != product::edition_id() || !valid_version(&value.product_version)
        || value.component_version != env!("CARGO_PKG_VERSION") || value.uninstall_protocol_version != 1
        || value.features.len() > 128 || value.options.len() > 128 { return Err(invalid()); }
    let mut ids = std::collections::HashSet::new();
    for feature in &value.features {
        if !ids.insert(&feature.id) || !contract["supportedFeatures"].as_array().is_some_and(|features| features.iter().any(|id| id.as_str() == Some(&feature.id)))
            || !matches!(feature.category.as_str(), "stable" | "dev") || !matches!(feature.size_level.as_str(), "small" | "large") { return Err(invalid()); }
    }
    ids.clear();
    for option in &value.options {
        let supported = &contract["supportedOptions"][&option.id];
        if !ids.insert(&option.id) || supported["type"].as_str() != Some(option.opt_type.as_str())
            || option.page.as_deref().is_some_and(|page| !matches!(page, "behavior" | "logging")) { return Err(invalid()); }
        match option.opt_type.as_str() {
            "boolean" if option.default_value.is_boolean() && option.choices.is_none() => {},
            "choice" => {
                let choices = option.choices.as_ref().filter(|choices| !choices.is_empty() && choices.len() <= 128).ok_or_else(invalid)?;
                let mut values = std::collections::HashSet::new();
                if !choices.iter().any(|choice| option.default_value.as_str() == Some(&choice.value))
                    || choices.iter().any(|choice| !values.insert(&choice.value) || !supported["values"].as_array()
                        .is_some_and(|allowed| allowed.iter().any(|value| value.as_str() == Some(&choice.value)))) { return Err(invalid()); }
            },
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

pub(crate) fn read_from(file: &mut File, layout: &Layout) -> Result<SetupMetadata, String> {
    file.seek(SeekFrom::Start(layout.metadata_offset)).map_err(|_| invalid())?;
    let mut bytes = vec![0; layout.metadata_size as usize];
    file.read_exact(&mut bytes).map_err(|_| invalid())?;
    if Sha256::digest(&bytes)[..] != layout.metadata_digest { return Err(invalid()); }
    let value: SetupMetadata = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    validate(&value)?;
    for (descriptor, size) in [(&value.payload, layout.payload_size), (&value.extractor, layout.extractor_size)] {
        if !descriptor.as_ref().is_some_and(|descriptor| descriptor.size == size && valid_digest(&descriptor.sha256)) { return Err(invalid()); }
    }
    if file.metadata().map_err(|_| invalid())?.len() != layout.file_size { return Err(invalid()); }
    Ok(value)
}

fn read_current() -> Result<SetupMetadata, String> {
    let exe = std::env::current_exe().map_err(|_| invalid())?;
    let mut file = File::open(exe).map_err(|_| invalid())?;
    #[cfg(debug_assertions)]
    {
        let length = file.metadata().map_err(|_| invalid())?.len();
        let mut magic = [0; 8];
        let embedded = length >= FOOTER_SIZE && file.seek(SeekFrom::End(-(FOOTER_SIZE as i64))).is_ok()
            && file.read_exact(&mut magic).is_ok() && &magic == b"SKPAYLD2";
        if !embedded {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/setup-metadata.json");
            let file = File::open(path).map_err(|_| invalid())?;
            if file.metadata().map_err(|_| invalid())?.len() > MAX_METADATA { return Err(invalid()); }
            let value: SetupMetadata = serde_json::from_reader(file).map_err(|_| invalid())?;
            validate(&value)?;
            return Ok(value);
        }
    }
    let layout = read_layout(&mut file)?;
    read_from(&mut file, &layout)
}

pub(crate) fn current() -> Result<&'static SetupMetadata, String> {
    static VALUE: OnceLock<Result<SetupMetadata, String>> = OnceLock::new();
    VALUE.get_or_init(read_current).as_ref().map_err(Clone::clone)
}

pub(crate) fn verify_blob(path: &Path, descriptor: &BlobDescriptor) -> Result<(), String> {
    let mut file = File::open(path).map_err(|_| invalid())?;
    if file.metadata().map_err(|_| invalid())?.len() != descriptor.size { return Err(invalid()); }
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| invalid())?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != descriptor.sha256 { return Err("安装载荷或解压工具校验失败，尚未安装。".into()); }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
