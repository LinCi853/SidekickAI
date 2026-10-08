use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::manifest::{InstallFeature, InstallOption};
use sidekickai_uninstall_core::distribution::{self, BodyDescriptor, SignedEnvelope, BODY_PROOF_TYPE};

pub(crate) const FOOTER_SIZE: u64 = 68;
const MAX_METADATA: u64 = 8 * 1024 * 1024;

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
    pub distribution_protocol_version: u32,
    pub distribution_mode: String,
    pub target_architecture: Option<String>,
    pub executable_architecture: String,
    pub supported_native_architectures: Vec<String>,
    pub distribution_proof: Option<SignedEnvelope>,
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

pub(crate) fn embedded_content_end(file: &mut File) -> Result<u64, String> {
    let size = file.metadata().map_err(|_| invalid())?.len();
    file.seek(SeekFrom::Start(0)).map_err(|_| invalid())?;
    let mut header = [0; 64];
    if file.read_exact(&mut header).is_err() { return Err(invalid()); }
    if &header[..2] != b"MZ" { return Ok(size); }
    let pe = u32::from_le_bytes(header[60..64].try_into().unwrap()) as u64;
    if pe < 64 || pe.checked_add(24).is_none_or(|end| end > size) { return Err(invalid()); }
    file.seek(SeekFrom::Start(pe)).map_err(|_| invalid())?;
    let mut coff = [0; 24];
    file.read_exact(&mut coff).map_err(|_| invalid())?;
    if &coff[..4] != b"PE\0\0" { return Err(invalid()); }
    let optional_size = u16::from_le_bytes(coff[20..22].try_into().unwrap()) as usize;
    if optional_size < 152 || optional_size > 4096 || pe + 24 + optional_size as u64 > size { return Err(invalid()); }
    let mut optional = vec![0; optional_size];
    file.read_exact(&mut optional).map_err(|_| invalid())?;
    let data_directory = match u16::from_le_bytes(optional[..2].try_into().unwrap()) {
        0x20b => 112,
        0x10b => 96,
        _ => return Err(invalid()),
    };
    if optional.len() < data_directory + 40 { return Err(invalid()); }
    let at = data_directory + 32;
    let offset = u32::from_le_bytes(optional[at..at + 4].try_into().unwrap()) as u64;
    let length = u32::from_le_bytes(optional[at + 4..at + 8].try_into().unwrap()) as u64;
    if offset == 0 && length == 0 { return Ok(size); }
    if offset % 8 != 0 || offset < pe + 24 + optional_size as u64 || length < 8 || length > 16 * 1024 * 1024
        || offset.checked_add(length) != Some(size) { return Err(invalid()); }
    let mut position = offset;
    while position < size {
        file.seek(SeekFrom::Start(position)).map_err(|_| invalid())?;
        let mut certificate = [0; 8];
        file.read_exact(&mut certificate).map_err(|_| invalid())?;
        let count = u32::from_le_bytes(certificate[..4].try_into().unwrap()) as u64;
        if count < 8 || u16::from_le_bytes(certificate[4..6].try_into().unwrap()) != 0x200
            || u16::from_le_bytes(certificate[6..8].try_into().unwrap()) != 2 { return Err(invalid()); }
        position = position.checked_add(count.checked_add(7).ok_or_else(invalid)? & !7).filter(|end| *end <= size).ok_or_else(invalid)?;
    }
    Ok(offset)
}

pub(crate) fn validate_host(metadata: &SetupMetadata) -> Result<&'static str, String> {
    let architecture = sidekickai_uninstall_core::architecture::native_architecture()?;
    if !metadata.supported_native_architectures.iter().any(|arch| arch == architecture)
        || metadata.target_architecture.as_deref().is_some_and(|target| target != architecture) {
        return Err("此安装包与 Windows 原生架构不匹配，请获取对应架构安装包。".into());
    }
    Ok(architecture)
}


pub(crate) fn read_layout(file: &mut File) -> Result<Layout, String> {
    let file_size = file.metadata().map_err(|_| invalid())?.len();
    if file_size <= FOOTER_SIZE { return Err(invalid()); }
    let content_end = embedded_content_end(file)?;
    let mut footer_end = content_end;
    let mut footer = [0u8; FOOTER_SIZE as usize];
    let mut found = false;
    for padding in 0..=7 {
        if content_end < FOOTER_SIZE + padding { break; }
        let end = content_end - padding;
        file.seek(SeekFrom::Start(end - FOOTER_SIZE)).map_err(|_| invalid())?;
        file.read_exact(&mut footer).map_err(|_| invalid())?;
        if &footer[..8] == b"SKSETUP3" && u32::from_le_bytes(footer[64..68].try_into().unwrap()) == FOOTER_SIZE as u32 {
            let mut trailing = [0; 7];
            file.read_exact(&mut trailing[..padding as usize]).map_err(|_| invalid())?;
            if trailing[..padding as usize].iter().all(|byte| *byte == 0) { footer_end = end; found = true; break; }
        }
    }
    if !found { return Err(invalid()); }
    let size = |at| u64::from_le_bytes(footer[at..at + 8].try_into().unwrap());
    let (payload_size, extractor_size, metadata_size) = (size(8), size(16), size(24));
    if payload_size > distribution::MAX_ASSET_BYTES || extractor_size != 0 || metadata_size == 0 || metadata_size > MAX_METADATA {
        return Err(invalid());
    }
    let suffix = payload_size.checked_add(extractor_size).and_then(|size| size.checked_add(metadata_size))
        .and_then(|size| size.checked_add(FOOTER_SIZE)).ok_or_else(invalid)?;
    let payload_offset = footer_end.checked_sub(suffix).filter(|offset| *offset > 0).ok_or_else(invalid)?;
    let metadata_offset = footer_end - FOOTER_SIZE - metadata_size;
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
    if value.schema_version != 3 || value.edition != product::edition_id() || !valid_version(&value.product_version)
        || value.component_version != env!("CARGO_PKG_VERSION") || value.uninstall_protocol_version != 2
        || value.distribution_protocol_version != 1 || !distribution::valid_architecture(&value.executable_architecture)
        || value.supported_native_architectures.is_empty() || value.supported_native_architectures.len() > 2
        || value.supported_native_architectures.iter().any(|arch| !distribution::valid_architecture(arch))
        || value.supported_native_architectures.iter().collect::<std::collections::BTreeSet<_>>().len() != value.supported_native_architectures.len()
        || value.extractor.is_some()
        || value.features.len() > 128 || value.options.len() > 128 { return Err(invalid()); }
    match value.distribution_mode.as_str() {
        "online" if value.edition == "community" && value.target_architecture.is_none() && value.distribution_proof.is_none()
            && value.payload.is_none() && value.executable_architecture == "x64"
            && value.supported_native_architectures.len() == 2
            && ["x64", "arm64"].iter().all(|arch| value.supported_native_architectures.iter().any(|supported| supported == arch)) => {},
        "offline" => {
            let target = value.target_architecture.as_deref().ok_or_else(invalid)?;
            if target != value.executable_architecture || value.supported_native_architectures != [target.to_string()]
                || !distribution::valid_architecture(target) || value.payload.as_ref().is_none_or(|blob| blob.size == 0 || !valid_digest(&blob.sha256)) {
                return Err(invalid());
            }
            let proof = value.distribution_proof.as_ref().ok_or_else(invalid)?;
            let mut keys = distribution::trusted_keys()?;
            #[cfg(test)]
            if let Some(keys) = keys.as_array_mut() { keys.push(tests::test_trust()); }
            let body: BodyDescriptor = distribution::verify_envelope_with_keys(proof, BODY_PROOF_TYPE, &keys)?;
            distribution::validate_body(&body, &value.edition, target, "installed")?;
            let archive = body.archive.as_ref().ok_or_else(invalid)?;
            let payload = value.payload.as_ref().ok_or_else(invalid)?;
            if body.product_version != value.product_version || archive.sha256 != payload.sha256 || archive.size_bytes != payload.size { return Err(invalid()); }
        },
        _ => return Err(invalid()),
    }
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
    if value.payload.as_ref().map_or(0, |descriptor| descriptor.size) != layout.payload_size || layout.extractor_size != 0 { return Err(invalid()); }
    if file.metadata().map_err(|_| invalid())?.len() != layout.file_size { return Err(invalid()); }
    Ok(value)
}

fn read_current() -> Result<SetupMetadata, String> {
    #[cfg(test)]
    if let Some(executable) = std::env::var_os("SIDEKICK_INSTALLER_ACCEPTANCE_SETUP") {
        let executable = Path::new(&executable);
        if !executable.is_absolute() { return Err(invalid()); }
        let mut file = File::open(executable).map_err(|_| invalid())?;
        let layout = read_layout(&mut file)?;
        return read_from(&mut file, &layout);
    }
    let exe = std::env::current_exe().map_err(|_| invalid())?;
    let mut file = File::open(exe).map_err(|_| invalid())?;
    #[cfg(debug_assertions)]
    {
        let length = file.metadata().map_err(|_| invalid())?.len();
        let mut magic = [0; 8];
        let embedded = length >= FOOTER_SIZE && file.seek(SeekFrom::End(-(FOOTER_SIZE as i64))).is_ok()
            && file.read_exact(&mut magic).is_ok() && &magic == b"SKSETUP3";
        if !embedded {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/setup-metadata.json");
            let file = File::open(path).map_err(|_| invalid())?;
            if file.metadata().map_err(|_| invalid())?.len() > MAX_METADATA { return Err(invalid()); }
            let mut value: SetupMetadata = serde_json::from_reader(file).map_err(|_| invalid())?;
            #[cfg(test)]
            tests::complete_draft(&mut value);
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

#[cfg(test)]
pub(crate) mod tests;
