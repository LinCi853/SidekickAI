use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::{Client, Response};
use reqwest::{header, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sidekickai_uninstall_core::distribution::{self as contract, ChannelDescriptor, ReleaseDescriptor, CHANNEL_PROOF_TYPE, RELEASE_PROOF_TYPE};

use super::{DistributionProgress, Selection};

const PUBLIC_PATH: &str = "/api/public/application-distribution/v1";

fn client() -> Result<Client, String> {
    Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30)).build().map_err(|error| error.to_string())
}

fn origin() -> Result<Url, String> {
    let value = Url::parse(env!("SIDEKICK_OXY_ORIGIN")).map_err(|_| "发行服务地址未配置。")?;
    let loopback = matches!(value.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !value.username().is_empty() || value.password().is_some() || value.query().is_some() || value.fragment().is_some()
        || value.path() != "/" || value.scheme() != "https" && !(value.scheme() == "http" && loopback) {
        return Err("发行服务地址不符合可信来源约束。".into());
    }
    Ok(value)
}

pub(super) fn parse_requested_binding(arguments: &[String]) -> Result<Option<(String, String)>, String> {
    let mut id = None;
    let mut digest = None;
    let mut index = 0;
    while index < arguments.len() {
        let target = match arguments[index].as_str() { "--release-id" => Some(&mut id), "--release-sha256" => Some(&mut digest), _ => None };
        if let Some(target) = target {
            if target.is_some() || index + 1 >= arguments.len() { return Err("精准发行参数缺失或重复。".into()); }
            index += 1;
            *target = Some(arguments[index].clone());
        }
        index += 1;
    }
    match (id, digest) {
        (None, None) => Ok(None),
        (Some(id), Some(digest)) if contract::valid_release_id(&id) && contract::valid_digest(&digest) => Ok(Some((id, digest))),
        _ => Err("精准发行参数不完整或无效。".into()),
    }
}

pub(super) fn requested_binding() -> Result<Option<(String, String)>, String> {
    parse_requested_binding(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn requested_proof() -> Result<Option<contract::SignedEnvelope>, String> {
    let arguments:Vec<_>=std::env::args().skip(1).collect();
    let indices:Vec<_>=arguments.iter().enumerate().filter(|(_,value)|value.as_str()=="--release-proof").map(|(index,_)|index).collect();
    match indices.as_slice() {
        []=>Ok(None),
        [index]=>{let path=arguments.get(index+1).ok_or("发行证明参数缺少文件路径。")?; Ok(Some(contract::read_envelope(Path::new(path))?))},
        _=>Err("发行证明参数重复。".into()),
    }
}

fn fetch_proof(client: &Client, url: Url) -> Result<contract::SignedEnvelope, String> {
    super::cancelled()?;
    let mut response = client.get(url).header(header::CACHE_CONTROL, "no-store").header(header::ACCEPT_ENCODING, "identity")
        .send().map_err(|error| format!("无法获取发行证明：{error}"))?;
    if response.status() != StatusCode::OK { return Err(format!("发行证明暂不可用（{}）。", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length > contract::MAX_PROOF_BYTES) { return Err("发行证明超过大小限制。".into()); }
    let mut bytes = Vec::new();
    response.by_ref().take(contract::MAX_PROOF_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    contract::parse_envelope(&bytes)
}

fn cache_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("无法定位发行下载缓存。")?;
    let root = PathBuf::from(base).join("SidekickAI").join("Distribution").join(sidekickai_uninstall_core::product::edition_id());
    sidekickai_uninstall_core::path::reject_reparse_points(&root).map_err(|error| error.message)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    contract::harden_private_directory(&root)?;
    Ok(root)
}

fn cache_lock(path: &Path) -> Result<File, String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
    options.open(path).map_err(|_| "另一项发行下载正在使用此缓存，请稍后重试。".into())
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let temporary = path.with_extension("new");
    sidekickai_uninstall_core::path::reject_reparse_points(&temporary).map_err(|error| error.message)?;
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    drop(file);
    #[cfg(windows)] {
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}};
        let source = crate::elevate::wide(&temporary.to_string_lossy());
        let destination = crate::elevate::wide(&path.to_string_lossy());
        unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }.map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))] fs::rename(temporary, path).map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn select_release() -> Result<Selection, String> {
    let client = client()?;
    let origin = origin()?;
    let edition = sidekickai_uninstall_core::product::edition_id();
    let requested = requested_binding()?;
    let (id, expected_digest) = match requested {
        Some(binding) => binding,
        None => {
            let channel = contract::version_channel(&crate::setup_metadata::current()?.product_version);
            let root = cache_root()?;
            let origin_digest = format!("{:x}", Sha256::digest(origin.as_str().as_bytes()));
            let sequence_path = root.join(format!("sequence-{origin_digest}-{channel}.json"));
            let _lock = cache_lock(&sequence_path.with_extension("lock"))?;
            let previous = if sequence_path.exists() {
                sidekickai_uninstall_core::path::reject_reparse_points(&sequence_path).map_err(|error| error.message)?;
                let bytes = fs::read(&sequence_path).map_err(|error| error.to_string())?;
                if bytes.len() > 64 { return Err("发行序列记录无效。".into()); }
                serde_json::from_slice::<u64>(&bytes).map_err(|_| "发行序列记录无效。")?
            } else { 0 };
            let envelope = fetch_proof(&client, origin.join(&format!("{PUBLIC_PATH}/channels/{edition}/{channel}")).map_err(|error| error.to_string())?)?;
            let selection: ChannelDescriptor = contract::verify_envelope(&envelope, CHANNEL_PROOF_TYPE)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs();
            contract::validate_channel(&selection, edition, channel, now, previous)?;
            save_json(&sequence_path, &selection.sequence)?;
            match (selection.release_id, selection.release_manifest_sha256) {
                (Some(id), Some(digest)) => (id, digest),
                _ => return Err("当前发行已暂停，请稍后重试或选择完整本地载荷。".into()),
            }
        },
    };
    let envelope = if let Some(proof)=requested_proof()? {proof} else {
        fetch_proof(&client, origin.join(&format!("{PUBLIC_PATH}/releases/{id}")).map_err(|error| error.to_string())?)?
    };
    let release: ReleaseDescriptor = contract::verify_envelope(&envelope, RELEASE_PROOF_TYPE)?;
    contract::validate_release(&release, edition)?;
    let digest = contract::content_digest(&envelope.payload)?;
    if release.release_id != id || digest != expected_digest { return Err("发行集合与本次选择不一致。".into()); }
    let architecture = sidekickai_uninstall_core::architecture::native_architecture()?;
    let role = if edition == "community" { "application-payload" } else { "offline-installer" };
    let asset = release.assets.iter().find(|asset| asset.role == role && asset.supported_native_architectures == [architecture.to_string()])
        .cloned().ok_or("发行缺少 Windows 原生架构资产。")?;
    Ok(Selection { release, envelope, digest, asset })
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadIdentity {
    protocol_version: u32,
    origin: String,
    release_id: String,
    release_manifest_sha256: String,
    body_proof_sha256: Option<String>,
    native_architecture: String,
    asset_id: String,
    size_bytes: u64,
    sha256: String,
}

impl DownloadIdentity {
    fn new(selection: &Selection, origin: &Url) -> Result<Self, String> {
        let [architecture] = selection.asset.supported_native_architectures.as_slice() else { return Err("下载资产必须绑定单一原生架构。".into()); };
        Ok(Self { protocol_version: 1, origin: origin.to_string(), release_id: selection.release.release_id.clone(),
            release_manifest_sha256: selection.digest.clone(), body_proof_sha256: selection.asset.body_proof_sha256.clone(),
            native_architecture: architecture.clone(), asset_id: selection.asset.asset_id.clone(),
            size_bytes: selection.asset.size_bytes, sha256: selection.asset.sha256.clone() })
    }
}

pub(super) fn validate_download_response(response: &Response, offset: u64, size: u64, sha256: &str) -> Result<bool, String> {
    let expected = format!("\"{sha256}\"");
    if response.headers().get(header::ETAG).and_then(|value| value.to_str().ok()) != Some(expected.as_str())
        || response.headers().get(header::CONTENT_ENCODING).is_some_and(|value| value != "identity") {
        return Err("发行下载的资产标识或编码无效。".into());
    }
    if response.status() == StatusCode::OK {
        if response.content_length() != Some(size) || response.headers().contains_key(header::CONTENT_RANGE) { return Err("发行下载大小无效。".into()); }
        return Ok(false);
    }
    if response.status() == StatusCode::PARTIAL_CONTENT && offset > 0 {
        let range = format!("bytes {offset}-{}/{size}", size - 1);
        if response.content_length() == Some(size - offset)
            && response.headers().get(header::CONTENT_RANGE).and_then(|value| value.to_str().ok()) == Some(range.as_str()) { return Ok(true); }
    }
    Err(format!("发行下载不可用或续传范围无效（{}）。", response.status().as_u16()))
}

pub(super) fn download_asset(selection: &Selection, progress: &impl Fn(DistributionProgress), cancelled: &AtomicBool) -> Result<PathBuf, String> {
    download_asset_at(selection, origin()?, &cache_root()?, progress, cancelled)
}

fn download_asset_at(selection: &Selection, origin: Url, root: &Path, progress: &impl Fn(DistributionProgress), cancelled: &AtomicBool) -> Result<PathBuf, String> {
    download_asset_using(&client()?, selection, origin, root, progress, cancelled)
}

fn download_asset_using(client: &Client, selection: &Selection, origin: Url, root: &Path, progress: &impl Fn(DistributionProgress), cancelled: &AtomicBool) -> Result<PathBuf, String> {
    let asset = &selection.asset;
    let _lock = cache_lock(&root.join(format!("{}.lock", asset.asset_id)))?;
    let partial = root.join(format!("{}.part", asset.asset_id));
    let complete = root.join(format!("{}.zip", asset.asset_id));
    let journal = root.join(format!("{}.json", asset.asset_id));
    for path in [&partial, &complete, &journal] { sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?; }
    if complete.exists() {
        if contract::verify_file(&complete, asset.size_bytes, &asset.sha256).is_ok() { return Ok(complete); }
        fs::remove_file(&complete).map_err(|error| error.to_string())?;
    }
    let identity = DownloadIdentity::new(selection, &origin)?;
    let matches = fs::metadata(&journal).is_ok_and(|meta| meta.is_file() && meta.len() <= 4096)
        && fs::read(&journal).ok().and_then(|bytes| serde_json::from_slice::<DownloadIdentity>(&bytes).ok()).as_ref() == Some(&identity);
    if partial.exists() && matches && fs::metadata(&partial).is_ok_and(|meta| meta.is_file() && meta.len() == asset.size_bytes)
        && contract::verify_file(&partial, asset.size_bytes, &asset.sha256).is_ok() {
        fs::rename(&partial, &complete).map_err(|error| error.to_string())?;
        fs::remove_file(&journal).map_err(|error| error.to_string())?;
        return Ok(complete);
    }
    if partial.exists() && (!matches || !fs::metadata(&partial).is_ok_and(|meta| meta.is_file() && meta.len() < asset.size_bytes)) {
        fs::remove_file(&partial).map_err(|error| error.to_string())?;
    }
    save_json(&journal, &identity)?;
    let mut offset = fs::metadata(&partial).map(|meta| meta.len()).unwrap_or_default();
    'transfer: loop {
    if cancelled.load(Ordering::SeqCst) { return Err("已取消下载；续传信息已保留。".into()); }
    let started=offset;
    let mut request = client.get(origin.join(&format!("{PUBLIC_PATH}/assets/{}", asset.asset_id)).map_err(|error| error.to_string())?)
        .header(header::CACHE_CONTROL, "no-store").header(header::ACCEPT_ENCODING, "identity");
    if offset > 0 { request = request.header(header::RANGE, format!("bytes={offset}-")).header(header::IF_RANGE, format!("\"{}\"", asset.sha256)); }
    let mut response = request.send().map_err(|error| format!("下载尚未完成，可继续重试：{error}"))?;
    let resumed = match validate_download_response(&response, offset, asset.size_bytes, &asset.sha256) {
        Ok(resumed) => resumed,
        Err(error) => { if partial.exists() { fs::remove_file(&partial).map_err(|error| error.to_string())?; } return Err(error); },
    };
    if !resumed { offset = 0; }
    let mut output = fs::OpenOptions::new().write(true).create(true).append(resumed).truncate(!resumed).open(&partial).map_err(|error| error.to_string())?;
    let mut bytes = [0; 64 * 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) { output.sync_all().map_err(|error| error.to_string())?; return Err("已取消下载；已核验的续传信息已保留。".into()); }
        let count = match response.read(&mut bytes) { Ok(count) => count, Err(error) => {
            output.sync_all().map_err(|error| error.to_string())?;
            if offset>started {drop(output);continue 'transfer;}
            return Err(format!("下载中断，重试可续传：{error}"));
        } };
        if count == 0 { break; }
        if offset.checked_add(count as u64).is_none_or(|end| end > asset.size_bytes) { drop(output); fs::remove_file(&partial).map_err(|error| error.to_string())?; return Err("下载超过已签名资产大小。".into()); }
        output.write_all(&bytes[..count]).map_err(|error| error.to_string())?;
        offset += count as u64;
        progress(DistributionProgress { phase: "downloading", downloaded_bytes: offset, total_bytes: asset.size_bytes, message: "正在下载当前架构的应用本体…".into() });
    }
    output.sync_all().map_err(|error| error.to_string())?;
    drop(output);
    if offset != asset.size_bytes {
        if offset>started {continue 'transfer;}
        return Err("下载尚未完成，重试可续传。".into());
    }
    break;
    }
    if let Err(error) = contract::verify_file(&partial, asset.size_bytes, &asset.sha256) {
        fs::remove_file(&partial).map_err(|error| error.to_string())?;
        return Err(error);
    }
    fs::rename(&partial, &complete).map_err(|error| error.to_string())?;
    fs::remove_file(&journal).map_err(|error| error.to_string())?;
    Ok(complete)
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod transfer_tests;
