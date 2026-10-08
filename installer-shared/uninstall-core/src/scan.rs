//! Installation discovery primitives and opaque scan-token storage.
//!
//! Platform-specific registry/process enumeration belongs in the host wrapper.
//! This module gives both Tauri entry points one safe identity/token model.

use crate::path::{normalize_absolute_path, normalize_target_path, NormalizedAbsolutePath};
use crate::protocol::{
    validate_location, IdentityConfidence, InstallScope, UninstallArch, UninstallError,
    UninstallErrorCode, UninstallLocation, UninstallPhase, UninstallScanResponse,
    UninstallTargetId,
};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const TOKEN_BYTES: usize = 32;
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetIdentity {
    pub path: NormalizedAbsolutePath,
    pub scope: InstallScope,
    pub registered_roots: Vec<String>,
    pub arch: UninstallArch,
    pub executable_path: Option<NormalizedAbsolutePath>,
    pub resources_path: Option<NormalizedAbsolutePath>,
    pub identity_confidence: IdentityConfidence,
    pub fingerprint: FileFingerprint,
}

impl TargetIdentity {
    pub fn from_location(location: &UninstallLocation) -> Result<Self, UninstallError> {
        validate_location(location)?;
        let path = normalize_target_path(&location.path)?;
        let executable_path = crate::product::application_executable(path.as_path());
        let resources_path = path.as_path().join("resources").join("app.asar");
        let executable_path = if executable_path.is_file() {
            Some(normalize_absolute_path(executable_path)?)
        } else {
            None
        };
        let resources_path = if resources_path.is_file() {
            Some(normalize_absolute_path(resources_path)?)
        } else {
            None
        };
        Ok(Self {
            fingerprint: FileFingerprint::from_path(path.as_path())?,
            path,
            scope: location.scope.clone(),
            registered_roots: location.registered_roots.clone(),
            arch: location.arch.clone(),
            executable_path,
            resources_path,
            identity_confidence: location.identity_confidence.clone(),
        })
    }

    pub fn verify_unchanged(&self) -> Result<(), UninstallError> {
        let current = FileFingerprint::from_path(self.path.as_path())?;
        if current != self.fingerprint {
            return Err(UninstallError::new(
                UninstallErrorCode::TargetChanged,
                "卸载目标在扫描后已变化",
                UninstallPhase::Validating,
                false,
                "",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub exists: bool,
    pub is_directory: bool,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub core_files: Vec<CoreFileFingerprint>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreFileFingerprint {
    pub relative_path: String,
    pub exists: bool,
    pub is_file: bool,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub sha256: Option<String>,
}

impl FileFingerprint {
    pub fn from_path(path: &Path) -> Result<Self, UninstallError> {
        let mut fingerprint = match fs::symlink_metadata(path) {
            Ok(metadata) => Self {
                exists: true,
                is_directory: metadata.is_dir(),
                len: metadata.len(),
                modified: metadata.modified().ok(),
                core_files: Vec::new(),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self {
                exists: false,
                is_directory: false,
                len: 0,
                modified: None,
                core_files: Vec::new(),
            },
            Err(error) => {
                return Err(UninstallError::new(
                    UninstallErrorCode::UnsafePath,
                    format!("无法检查目标标识：{error}"),
                    UninstallPhase::Scanning,
                    false,
                    "",
                ))
            }
        };
        if fingerprint.is_directory {
            let mut names = vec!["SidekickAI.exe", "resources\\app.asar", "uninstall.exe", crate::product::INSTALL_RECEIPT,
                "distribution-proof.json", "maintenance\\distribution-receipt.json"];
            names.extend(crate::product::product().editions.values().map(|edition| edition.legacy_executable.as_str()));
            names.sort();
            names.dedup();
            for relative_path in names {
                let child = path.join(relative_path);
                let child_fingerprint = match fs::symlink_metadata(&child) {
                    Ok(metadata) => CoreFileFingerprint {
                        relative_path: relative_path.to_string(),
                        exists: true,
                        is_file: metadata.is_file(),
                        len: metadata.len(),
                        modified: metadata.modified().ok(),
                        sha256: if metadata.is_file() { Some(hash_file(&child)?) } else { None },
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        CoreFileFingerprint {
                            relative_path: relative_path.to_string(),
                            exists: false,
                            is_file: false,
                            len: 0,
                            modified: None,
                            sha256: None,
                        }
                    }
                    Err(error) => {
                        return Err(UninstallError::new(
                            UninstallErrorCode::UnsafePath,
                            format!("无法检查目标核心文件：{error}"),
                            UninstallPhase::Scanning,
                            false,
                            "",
                        ))
                    }
                };
                fingerprint.core_files.push(child_fingerprint);
            }
        }
        Ok(fingerprint)
    }
}

#[derive(Clone, Debug)]
pub struct ScannedTarget {
    pub id: UninstallTargetId,
    pub identity: TargetIdentity,
}

#[derive(Clone, Debug)]
struct ScanRecord {
    scan_id: String,
    created_at: SystemTime,
    targets: HashMap<String, ScannedTarget>,
    response: UninstallScanResponse,
}

#[derive(Default)]
struct ScanState {
    current: Option<ScanRecord>,
}

static SCAN_STATE: OnceLock<Mutex<ScanState>> = OnceLock::new();

fn scan_state() -> &'static Mutex<ScanState> {
    SCAN_STATE.get_or_init(|| Mutex::new(ScanState::default()))
}

/// Register a scan and invalidate all previous tokens in this process.
pub fn register_scan(
    scan_id: impl Into<String>,
    generated_at: impl Into<String>,
    locations: Vec<UninstallLocation>,
    data_roots: Vec<crate::protocol::DataRoot>,
    recommended_target_id: Option<UninstallTargetId>,
) -> Result<UninstallScanResponse, UninstallError> {
    let scan_id = scan_id.into();
    if scan_id.is_empty() {
        return Err(UninstallError::invalid_request("scanId 为空"));
    }
    let mut targets = HashMap::new();
    let mut id_map = HashMap::new();
    let mut output_locations = Vec::with_capacity(locations.len());
    for mut location in locations {
        validate_location(&location)?;
        let old_token = location.id.token.clone();
        let identity = TargetIdentity::from_location(&location)?;
        let token = opaque_token()?;
        location.id = UninstallTargetId {
            token: token.clone(),
        };
        if id_map.insert(old_token, location.id.clone()).is_some() {
            return Err(UninstallError::invalid_request("发现结果标识重复"));
        }
        if location.removable {
            targets.insert(
                token,
                ScannedTarget {
                    id: location.id.clone(),
                    identity,
                },
            );
        }
        output_locations.push(location);
    }
    let recommended_target_id = recommended_target_id.and_then(|id| id_map.get(&id.token).cloned());
    let mut data_roots = data_roots;
    for root in &mut data_roots {
        root.associated_target_ids = root.associated_target_ids.iter().map(|id| {
            id_map.get(&id.token).cloned().ok_or_else(|| UninstallError::invalid_request("数据根引用了未知目标"))
        }).collect::<Result<Vec<_>, _>>()?;
    }
    let response = UninstallScanResponse {
        recovery_tasks: Vec::new(),
        scan_id: scan_id.clone(),
        generated_at: generated_at.into(),
        locations: output_locations,
        recommended_target_id,
        data_roots,
    };
    let mut guard = scan_state()
        .lock()
        .map_err(|_| internal_error("扫描互斥锁已损坏"))?;
    guard.current = Some(ScanRecord {
        scan_id,
        created_at: SystemTime::now(),
        targets,
        response: response.clone(),
    });
    Ok(response)
}

pub fn current_scan() -> Option<UninstallScanResponse> {
    let guard = scan_state().lock().ok()?;
    let record = guard.current.as_ref()?;
    if record.created_at.elapsed().ok()? > TOKEN_TTL {
        return None;
    }
    Some(record.response.clone())
}

pub fn resolve_target(
    scan_id: &str,
    target_id: &UninstallTargetId,
) -> Result<ScannedTarget, UninstallError> {
    let guard = scan_state()
        .lock()
        .map_err(|_| internal_error("扫描互斥锁已损坏"))?;
    let record = guard.current.as_ref().ok_or_else(|| {
        UninstallError::new(
            UninstallErrorCode::NoTarget,
            "当前没有进行中的扫描",
            UninstallPhase::Validating,
            true,
            "",
        )
    })?;
    if record.scan_id != scan_id
        || record
            .created_at
            .elapsed()
            .unwrap_or(TOKEN_TTL + Duration::from_secs(1))
            > TOKEN_TTL
    {
        return Err(UninstallError::new(
            UninstallErrorCode::TargetNotConfirmed,
            "扫描令牌已过期或属于其他扫描",
            UninstallPhase::Validating,
            true,
            "",
        ));
    }
    let target = record
        .targets
        .get(&target_id.token)
        .cloned()
        .ok_or_else(|| {
            UninstallError::new(
                UninstallErrorCode::TargetNotConfirmed,
                "目标令牌不是由当前扫描签发",
                UninstallPhase::Validating,
                false,
                "",
            )
        })?;
    target.identity.verify_unchanged()?;
    Ok(target)
}

pub fn resolve_targets(
    scan_id: &str,
    primary: &UninstallTargetId,
    additional: &[UninstallTargetId],
) -> Result<Vec<ScannedTarget>, UninstallError> {
    let mut tokens = Vec::with_capacity(additional.len() + 1);
    tokens.push(primary.clone());
    tokens.extend(additional.iter().cloned());
    let mut unique = HashMap::new();
    for token in tokens {
        unique.entry(token.token.clone()).or_insert(token);
    }
    let mut targets = Vec::with_capacity(unique.len());
    for token in unique.values() {
        targets.push(resolve_target(scan_id, token)?);
    }
    Ok(targets)
}

fn hash_file(path: &Path) -> Result<String, UninstallError> {
    crate::path::reject_reparse_points(path)?;
    let mut file = fs::File::open(path).map_err(|e| internal_error(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(|e| internal_error(e.to_string()))?;
        if read == 0 { break; }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn opaque_token() -> Result<String, UninstallError> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom(&mut bytes)
        .map_err(|error| internal_error(format!("无法创建扫描令牌：{error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn internal_error(message: impl Into<String>) -> UninstallError {
    UninstallError::new(
        UninstallErrorCode::Internal,
        message,
        UninstallPhase::Scanning,
        true,
        "",
    )
}

#[allow(dead_code)]
fn _path_buf(_: PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{IdentityConfidence, InstallScope, UninstallArch, UninstallEntry};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (PathBuf, UninstallLocation) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sidekick-uninstall-scan-{nonce}"));
        fs::create_dir_all(root.join("resources")).unwrap();
        fs::write(root.join("SidekickAI.exe"), b"fixture").unwrap();
        fs::write(root.join("resources").join("app.asar"), b"fixture").unwrap();
        let location = UninstallLocation {
            edition: crate::product::edition_id().into(),
            id: UninstallTargetId {
                token: "placeholder".into(),
            },
            path: root.to_string_lossy().into_owned(),
            display_path: root.to_string_lossy().into_owned(),
            source: vec![UninstallEntry::Installed],
            scope: InstallScope::Portable,
            arch: UninstallArch::Unknown,
            version: None,
            registered: false,
            registered_roots: vec![],
            executable_present: true,
            resources_present: true,
            identity_confidence: IdentityConfidence::Strong,
            running_pids: vec![],
            removable: true,
            non_removable_reason: None,
            recommended: true,
        };
        (root, location)
    }

    #[test]
    fn tokens_are_opaque_and_duplicate_tokens_are_deduplicated() {
        let (root, location) = fixture();
        let data = crate::protocol::DataRoot {
            path: root.join("data").to_string_lossy().into_owned(), source: "fixture".into(),
            removable: true, associated_target_ids: vec![location.id.clone()],
        };
        let response = register_scan("scan-token-test", "now", vec![location.clone()], vec![data], Some(location.id.clone())).unwrap();
        let id = response.locations[0].id.clone();
        let targets = resolve_targets("scan-token-test", &id, &[id.clone(), id.clone()]).unwrap();
        assert_eq!(targets.len(), 1);
        assert_ne!(id.token, "placeholder");
        assert_eq!(response.recommended_target_id, Some(id.clone()));
        assert_eq!(response.data_roots[0].associated_target_ids, vec![id.clone()]);
        fs::write(root.join("resources").join("app.asar"), b"changed core file").unwrap();
        assert_eq!(resolve_target("scan-token-test", &id).unwrap_err().code, UninstallErrorCode::TargetChanged);
        let mut disabled = location;
        disabled.removable = false;
        disabled.non_removable_reason = Some(UninstallErrorCode::TargetNotInstall);
        let response = register_scan("disabled", "now", vec![disabled], vec![], None).unwrap();
        assert!(resolve_target("scan-token-test", &id).is_err());
        assert_eq!(resolve_target("disabled", &response.locations[0].id).unwrap_err().code, UninstallErrorCode::TargetNotConfirmed);
        assert!(root.is_absolute());
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("sidekick-uninstall-scan-"));
        fs::remove_dir_all(root).unwrap();
    }
}
