use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sidekickai_uninstall_core::distribution::{self as contract, BodyDescriptor, ReleaseAsset, ReleaseDescriptor, SignedEnvelope, BODY_PROOF_TYPE, RELEASE_PROOF_TYPE};

mod download;
#[cfg(test)]
mod tests;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static READY: Mutex<Option<ReadyDistribution>> = Mutex::new(None);
static CURRENT_BODY: Mutex<Option<BodyDescriptor>> = Mutex::new(None);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedDistribution {
    pub source_path: String,
    pub body_proof: String,
    pub product_version: String,
    pub native_architecture: String,
    pub release_id: String,
    pub release_sha256: String,
    pub release_proof: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionProgress {
    pub phase: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
}

pub struct Selection {
    pub release: ReleaseDescriptor,
    pub envelope: SignedEnvelope,
    pub digest: String,
    pub asset: ReleaseAsset,
}

struct ReadyDistribution {
    value: PreparedDistribution,
    directory: PathBuf,
    _source: Option<File>,
}

impl Drop for ReadyDistribution {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.directory);
        self._source.take();
        if !path.as_os_str().is_empty() {
            if sidekickai_uninstall_core::path::validate_tree(&path).is_ok() { let _ = fs::remove_dir_all(path); }
        }
    }
}

struct ActiveOperation;
impl Drop for ActiveOperation { fn drop(&mut self) { ACTIVE.store(false, Ordering::SeqCst); } }

pub fn cancel() -> bool {
    let Ok(mut ready) = READY.lock() else { return false; };
    if !ACTIVE.load(Ordering::SeqCst) && ready.is_none() { return false; }
    CANCELLED.store(true, Ordering::SeqCst);
    ready.take();
    if let Ok(mut body) = CURRENT_BODY.lock() { body.take(); }
    true
}

pub fn precise_binding()->Result<Option<(String,String)>,String>{download::requested_binding()}

pub fn validate_arguments(arguments:&[String])->Result<bool,String>{
    if download::parse_requested_binding(arguments)?.is_none(){return Ok(false);}
    if !matches!(arguments.len(),4|6){return Err("精准发行参数数量无效。".into());}
    let mut flags=std::collections::BTreeSet::new();
    for pair in arguments.chunks_exact(2){if !matches!(pair[0].as_str(),"--release-id"|"--release-sha256"|"--release-proof")||!flags.insert(&pair[0])
        || pair[0]=="--release-proof"&&!Path::new(&pair[1]).is_absolute(){return Err("精准发行参数无效。".into());}}
    Ok(true)
}

pub fn cancelled() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) { Err("已取消下载；当前安装和资料未修改。".into()) } else { Ok(()) }
}

fn commit_ready(ready: ReadyDistribution, body: BodyDescriptor) -> Result<(), String> {
    let mut state = READY.lock().map_err(|_| "本体暂存状态不可用。")?;
    cancelled()?;
    *CURRENT_BODY.lock().map_err(|_| "本体状态不可用。")? = Some(body);
    *state = Some(ready);
    Ok(())
}

pub fn product_version() -> Option<String> {
    CURRENT_BODY.lock().ok().and_then(|body| body.as_ref().map(|body| body.product_version.clone()))
}

pub fn body() -> Result<BodyDescriptor, String> {
    CURRENT_BODY.lock().map_err(|_| "本体状态不可用。")?.clone().ok_or("尚未准备已核验本体。".into())
}

fn temporary_directory(base: &Path) -> Result<PathBuf, String> {
    sidekickai_uninstall_core::path::reject_reparse_points(base).map_err(|error| error.message)?;
    fs::create_dir_all(base).map_err(|error| error.to_string())?;
    let directory = base.join(sidekickai_uninstall_core::random_id("SidekickAI-Distribution").map_err(|error| error.message)?);
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    contract::harden_private_directory(&directory)?;
    Ok(directory)
}

fn pin_file(path: &Path) -> Result<File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn copy_range(source: &mut File, offset: u64, length: u64, target: &Path) -> Result<(), String> {
    source.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|error| error.to_string())?;
    let copied = std::io::copy(&mut source.take(length), &mut target).map_err(|error| error.to_string())?;
    if copied != length { return Err("发行归档被截断。".into()); }
    target.sync_all().map_err(|error| error.to_string())
}

pub fn verify_body(envelope: &SignedEnvelope) -> Result<BodyDescriptor, String> {
    let body: BodyDescriptor = contract::verify_envelope(envelope, BODY_PROOF_TYPE)?;
    let architecture = sidekickai_uninstall_core::architecture::native_architecture()?;
    contract::validate_body(&body, sidekickai_uninstall_core::product::edition_id(), architecture, "installed")?;
    let metadata = crate::setup_metadata::current()?;
    crate::setup_metadata::validate_host(metadata)?;
    if metadata.distribution_mode == "offline" {
        let proof = metadata.distribution_proof.as_ref().ok_or("离线安装器缺少本体证明。")?;
        if contract::content_digest(&envelope.payload)? != contract::content_digest(&proof.payload)? { return Err("本体不属于此离线安装器。".into()); }
    }
    Ok(body)
}

pub fn verify_release_binding(proof: &str, id: &str, digest: &str, body: &SignedEnvelope) -> Result<(), String> {
    if id.is_empty() && digest.is_empty() && proof.is_empty() { return Ok(()); }
    if !contract::valid_release_id(id) || !contract::valid_digest(digest) || proof.is_empty() { return Err("发行绑定缺失或无效。".into()); }
    let envelope = contract::parse_envelope(proof.as_bytes())?;
    let release: ReleaseDescriptor = contract::verify_envelope(&envelope, RELEASE_PROOF_TYPE)?;
    contract::validate_release(&release, sidekickai_uninstall_core::product::edition_id())?;
    if release.release_id != id || contract::content_digest(&envelope.payload)? != digest
        || release.product_version != body.payload["productVersion"].as_str().unwrap_or_default() {
        return Err("发行集合不属于本次安装。".into());
    }
    let architecture = sidekickai_uninstall_core::architecture::native_architecture()?;
    let body_digest = contract::content_digest(&body.payload)?;
    let role = if crate::setup_metadata::current()?.distribution_mode == "online" { "application-payload" } else { "offline-installer" };
    if !release.assets.iter().any(|asset| asset.role == role && asset.supported_native_architectures == [architecture.to_string()]
        && asset.body_proof_sha256.as_deref() == Some(body_digest.as_str())) {
        return Err("发行集合没有绑定当前架构的准确本体。".into());
    }
    Ok(())
}

pub fn apply_request(request: &crate::manifest::InstallRequest) -> Result<BodyDescriptor, String> {
    let proof = contract::parse_envelope(request.distribution_body_proof.as_bytes())?;
    let body = verify_body(&proof)?;
    if request.distribution_product_version != body.product_version || request.distribution_source_path.is_empty() {
        return Err("安装请求的本体版本或暂存位置无效。".into());
    }
    verify_release_binding(&request.distribution_release_proof, &request.distribution_release_id, &request.distribution_release_sha256, &proof)?;
    let archive = body.archive.as_ref().ok_or("本体归档描述缺失。")?;
    contract::verify_file(Path::new(&request.distribution_source_path), archive.size_bytes, &archive.sha256)?;
    *CURRENT_BODY.lock().map_err(|_| "本体状态不可用。")? = Some(body.clone());
    Ok(body)
}

fn extract_container(path: &Path, destination: &Path) -> Result<(PathBuf, SignedEnvelope), String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let source = pin_file(path)?;
    if source.metadata().map_err(|error| error.to_string())?.len() > contract::MAX_ASSET_BYTES { return Err("发行封装超出大小限制。".into()); }
    let mut zip = zip::ZipArchive::new(source).map_err(|_| "本地载荷不是已签名发行封装。")?;
    if zip.len() != 2 { return Err("发行封装必须只包含本体证明与应用归档。".into()); }
    let mut names = std::collections::BTreeSet::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|error| error.to_string())?;
        if !matches!(entry.name(), "body-proof.json" | "application.zip") || !names.insert(entry.name().to_string())
            || entry.is_dir() || entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000) {
            return Err("发行封装包含未声明或不安全的内容。".into());
        }
    }
    let proof = {
        let mut entry = zip.by_name("body-proof.json").map_err(|error| error.to_string())?;
        if entry.size() > contract::MAX_PROOF_BYTES { return Err("本体证明过大。".into()); }
        let mut bytes = Vec::new();
        entry.by_ref().take(contract::MAX_PROOF_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        contract::parse_envelope(&bytes)?
    };
    let body = verify_body(&proof)?;
    let archive = body.archive.as_ref().ok_or("本体归档描述缺失。")?;
    let mut entry = zip.by_name("application.zip").map_err(|error| error.to_string())?;
    if entry.size() != archive.size_bytes { return Err("发行封装的本体归档大小不匹配。".into()); }
    let target = destination.join("application.zip");
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|error| error.to_string())?;
    let count = std::io::copy(&mut entry.by_ref().take(archive.size_bytes + 1), &mut output).map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    if count != archive.size_bytes { return Err("发行封装的本体归档被截断。".into()); }
    contract::verify_file(&target, archive.size_bytes, &archive.sha256)?;
    Ok((target, proof))
}

fn embedded_payload(directory: &Path) -> Result<(PathBuf, SignedEnvelope), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut file = pin_file(&executable)?;
    let layout = crate::setup_metadata::read_layout(&mut file)?;
    let metadata = crate::setup_metadata::read_from(&mut file, &layout)?;
    let proof = metadata.distribution_proof.ok_or("离线安装器缺少本体证明。")?;
    let target = directory.join("application.zip");
    copy_range(&mut file, layout.payload_offset, layout.payload_size, &target)?;
    let body = verify_body(&proof)?;
    let archive = body.archive.ok_or("本体归档描述缺失。")?;
    contract::verify_file(&target, archive.size_bytes, &archive.sha256)?;
    Ok((target, proof))
}

pub fn prepare(local_path: Option<&str>, progress: &impl Fn(DistributionProgress)) -> Result<PreparedDistribution, String> {
    {
        let _ready = READY.lock().map_err(|_| "本体暂存状态不可用。")?;
        if ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("另一项本体获取仍在进行。".into()); }
        CANCELLED.store(false, Ordering::SeqCst);
    }
    let _active = ActiveOperation;
    let metadata = crate::setup_metadata::current()?;
    let architecture = crate::setup_metadata::validate_host(metadata)?;
    let directory = temporary_directory(&std::env::temp_dir())?;
    let result = (|| {
        progress(DistributionProgress { phase: "selecting", downloaded_bytes: 0, total_bytes: 0, message: "正在核对本次发行…".into() });
        let binding = download::requested_binding()?;
        let selection = if binding.is_some() || local_path.is_none() && metadata.distribution_mode == "online" { Some(download::select_release()?) } else { None };
        let (source, proof) = if let Some(local_path) = local_path.filter(|path| !path.is_empty()) {
            if metadata.distribution_mode != "online" { return Err("离线安装器不接受另一载荷旁载。".into()); }
            extract_container(Path::new(local_path), &directory)?
        } else if metadata.distribution_mode == "offline" {
            embedded_payload(&directory)?
        } else {
            let selection = selection.as_ref().ok_or("没有选定完整发行。")?;
            let cached = download::download_asset(selection, progress, &CANCELLED)?;
            extract_container(&cached, &directory)?
        };
        cancelled()?;
        let body = verify_body(&proof)?;
        let archive = body.archive.as_ref().ok_or("本体归档描述缺失。")?;
        let archive_size = archive.size_bytes;
        progress(DistributionProgress { phase: "verifying", downloaded_bytes: archive.size_bytes, total_bytes: archive.size_bytes, message: "正在校验应用与恢复资源…".into() });
        crate::engine::check_distribution_space(&directory, archive.expanded_bytes)?;
        let check = directory.join("verified");
        fs::create_dir(&check).map_err(|error| error.to_string())?;
        contract::extract_verified_zip(&source, &body.files, &check)?;
        fs::remove_dir_all(&check).map_err(|error| error.to_string())?;
        cancelled()?;
        let release_id = selection.as_ref().map(|selection| selection.release.release_id.clone()).unwrap_or_default();
        let release_sha256 = selection.as_ref().map(|selection| selection.digest.clone()).unwrap_or_default();
        let release_proof = selection.as_ref().map(|selection| serde_json::to_string(&selection.envelope)).transpose().map_err(|error| error.to_string())?.unwrap_or_default();
        let body_proof = serde_json::to_string(&proof).map_err(|error| error.to_string())?;
        verify_release_binding(&release_proof, &release_id, &release_sha256, &proof)?;
        let value = PreparedDistribution {
            source_path: source.to_string_lossy().into_owned(), body_proof, product_version: body.product_version.clone(),
            native_architecture: architecture.into(), release_id, release_sha256, release_proof,
        };
        let ready = ReadyDistribution { value: value.clone(), _source: Some(pin_file(&source)?), directory: directory.clone() };
        commit_ready(ready, body)?;
        progress(DistributionProgress { phase: "ready", downloaded_bytes: archive_size, total_bytes: archive_size, message: "本体已核验，正在准备安装。".into() });
        Ok(value)
    })();
    if result.is_err() && sidekickai_uninstall_core::path::validate_tree(&directory).is_ok() { let _ = fs::remove_dir_all(directory); }
    result
}

pub fn ready() -> Result<Option<PreparedDistribution>, String> {
    READY.lock().map_err(|_| "本体暂存状态不可用。".into()).map(|ready| ready.as_ref().map(|ready| ready.value.clone()))
}

pub fn clear_ready() {
    if let Ok(mut ready) = READY.lock() { ready.take(); }
}

pub fn adopt_prepared(value: PreparedDistribution) -> Result<(), String> {
    if READY.lock().map_err(|_| "本体暂存状态不可用。")?.as_ref().is_some_and(|ready| ready.value.source_path == value.source_path) { return Ok(()); }
    let source = pin_file(Path::new(&value.source_path))?;
    *READY.lock().map_err(|_| "本体暂存状态不可用。")? = Some(ReadyDistribution { value, directory: PathBuf::new(), _source: Some(source) });
    Ok(())
}

pub fn write_receipt(request: &crate::manifest::InstallRequest, root: &Path) -> Result<(), String> {
    if request.distribution_body_proof.is_empty() { return Ok(()); }
    let proof = contract::parse_envelope(request.distribution_body_proof.as_bytes())?;
    let body = verify_body(&proof)?;
    verify_release_binding(&request.distribution_release_proof, &request.distribution_release_id, &request.distribution_release_sha256, &proof)?;
    contract::verify_declared_files(root, &body.files)?;
    crate::engine::write_distribution_proof(root, request.distribution_body_proof.as_bytes())?;
    let optional = |value: &String| if value.is_empty() { None } else { Some(value.clone()) };
    let receipt = serde_json::json!({ "protocolVersion":1, "edition":body.edition, "productVersion":body.product_version,
        "nativeArchitecture":sidekickai_uninstall_core::architecture::native_architecture()?,
        "bodyProofSha256":contract::content_digest(&proof.payload)?, "releaseId":optional(&request.distribution_release_id),
        "releaseManifestSha256":optional(&request.distribution_release_sha256), "installationId":crate::manifest::new_installation_id() });
    crate::engine::write_distribution_receipt(root, serde_json::to_vec(&receipt).map_err(|error| error.to_string())?)
}

pub fn selection_info() -> Result<serde_json::Value, String> {
    let selection = download::select_release()?;
    Ok(serde_json::json!({
        "productVersion":selection.release.product_version,
        "nativeArchitecture":sidekickai_uninstall_core::architecture::native_architecture()?,
        "releaseId":selection.release.release_id,
        "releaseSha256":selection.digest,
    }))
}
