//! Relocated UI bootstrap and stale-relocation sweep.

use super::super::hashing::{sha256_file, write_atomic};
use super::super::identity::DirectoryIdentity;
use super::super::pinned::remove_tree_pinned;
use super::prepare::{create_operation_dir, operation_root, random_nonce};
use super::process::process_is_alive;
use super::super::{
    internal, RELOCATION_ORPHAN_AGE, RELOCATION_SWEEP_GRACE, REQUEST_NONCE_LEN, SHA256_HEX_LEN,
};
use serde::{Deserialize, Serialize};
use sidekickai_uninstall_core::path::{
    normalize_absolute_path, path_is_same_or_descendant, paths_equal, reject_reparse_points,
};
use sidekickai_uninstall_core::protocol::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `--relocated` bootstrap: written by the launcher before it hands control to a
/// copy of itself in the private operation root. It records where the user
/// really started the uninstaller so the relocated UI can still recommend that
/// installation.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelocationBootstrap {
    pub protocol_version: u32,
    pub nonce: String,
    pub source_exe: String,
    /// SHA-256 of the image that was copied. The relocated process verifies its
    /// own bytes against this, so a swapped file in the operation root cannot
    /// claim the bootstrap.
    pub source_sha256: String,
    /// Owning process, so a later run can tell a stale relocation from a live one.
    pub pid: u32,
}

/// Best-effort age of a relocation, preferring the bootstrap file's own mtime.
pub(super) fn relocation_age(directory: &Path) -> Option<Duration> {
    let bootstrap = directory.join("bootstrap.json");
    let path = if bootstrap.is_file() { bootstrap } else { directory.to_path_buf() };
    fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
}

/// Remove relocation directories whose owning process is gone. A directory whose
/// process is still alive is never touched, a freshly written relocation is
/// protected by a grace period, and an unreadable bootstrap is only removed once
/// it is clearly abandoned. Unknown liveness is treated as alive.
pub fn sweep_stale_relocations() -> Result<usize, UninstallError> {
    let root = operation_root();
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(internal(format!("无法检查操作根目录：{error}"))),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() || !entry.file_name().to_string_lossy().starts_with("ui-") {
            continue;
        }
        let stale = match fs::read(directory.join("bootstrap.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RelocationBootstrap>(&bytes).ok())
        {
            Some(bootstrap) if bootstrap.pid != 0 => {
                !process_is_alive(bootstrap.pid)
                    && relocation_age(&directory).is_some_and(|age| age > RELOCATION_SWEEP_GRACE)
            }
            _ => relocation_age(&directory).is_some_and(|age| age > RELOCATION_ORPHAN_AGE),
        };
        if stale {
            // Sweep through the same no-reparse, handle-pinned remover the
            // worker uses, so a junction planted in a relocation directory is
            // never followed out of the private root.
            if let Ok(identity) = DirectoryIdentity::from_path(&directory) {
                if remove_tree_pinned(&directory, &identity).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

/// The UI must not delete a directory that contains its own running image, so a
/// copy is started from the private operation root and the original process
/// exits. Returns the relocated executable that should be started.
pub fn relocate_ui() -> Result<(PathBuf, PathBuf, String), UninstallError> {
    // Best-effort: abandoned relocations from earlier runs must not pile up.
    let _ = sweep_stale_relocations();
    let source = std::env::current_exe().map_err(|e| internal(format!("无法定位卸载器可执行文件：{e}")))?;
    let directory = create_operation_dir("ui")?;
    let relocated = directory.join("uninstaller-ui.exe");
    fs::copy(&source, &relocated).map_err(|e| internal(format!("无法重定位卸载器：{e}")))?;
    let source_hash = sha256_file(&source).map_err(internal)?;
    if sha256_file(&relocated).map_err(internal)? != source_hash {
        let _ = fs::remove_dir_all(&directory);
        return Err(internal("已重定位的卸载器与正在运行的可执行文件不匹配。"));
    }
    let nonce = random_nonce()?;
    let bootstrap = RelocationBootstrap {
        protocol_version: UNINSTALL_PROTOCOL_VERSION,
        nonce: nonce.clone(),
        source_exe: source.to_string_lossy().into_owned(),
        source_sha256: source_hash,
        pid: std::process::id(),
    };
    let path = directory.join("bootstrap.json");
    write_atomic(&path, &serde_json::to_vec(&bootstrap).map_err(|e| internal(e.to_string()))?)
        .map_err(internal)?;
    Ok((relocated, path, nonce))
}

/// Validate a `--relocated` bootstrap. The file alone is not authorization: it
/// must be a non-reparse file directly inside one private operation directory,
/// its nonce must be the exact hex shape, the running image must be exactly the
/// relocated `uninstaller-ui.exe` that the bootstrap hashed, and the recorded
/// origin must be a normalized absolute path outside the temporary area. Once
/// the running copy is confirmed, the bootstrap records its PID so a concurrent
/// or later sweep cannot mistake the live UI for a stale relocation.
pub fn read_relocation_bootstrap(path: &Path) -> Result<PathBuf, UninstallError> {
    if path.file_name().and_then(|name| name.to_str()) != Some("bootstrap.json") {
        return Err(internal("重定位引导文件必须命名为 bootstrap.json。"));
    }
    let directory = path.parent().ok_or_else(|| internal("重定位引导文件缺少目录。"))?;
    if !paths_equal(directory.parent().unwrap_or(Path::new("")), &operation_root()) {
        return Err(internal("重定位引导文件位于私有操作根之外。"));
    }
    if !path.is_file() {
        return Err(internal("重定位引导文件不是常规文件。"));
    }
    reject_reparse_points(path)?;
    let mut bootstrap: RelocationBootstrap = serde_json::from_slice(&fs::read(path).map_err(|e| internal(e.to_string()))?)
        .map_err(|e| internal(format!("重定位引导文件无效：{e}")))?;
    if bootstrap.protocol_version != UNINSTALL_PROTOCOL_VERSION
        || bootstrap.nonce.len() != REQUEST_NONCE_LEN
        || !bootstrap.nonce.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(internal("重定位引导文件对当前版本无效。"));
    }
    if bootstrap.source_sha256.len() != SHA256_HEX_LEN
        || !bootstrap.source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(internal("重定位引导文件缺少有效的源哈希。"));
    }
    let current = std::env::current_exe().map_err(|e| internal(e.to_string()))?;
    // The running image must be exactly the copy described by the bootstrap, not
    // merely somewhere below the operation directory.
    if !paths_equal(&current, &directory.join("uninstaller-ui.exe")) {
        return Err(internal("当前进程不是该引导文件对应的重定位副本。"));
    }
    reject_reparse_points(&current)?;
    let current_hash = sha256_file(&current).map_err(internal)?;
    if !current_hash.eq_ignore_ascii_case(&bootstrap.source_sha256) {
        return Err(internal("重定位副本与引导文件记录的哈希不匹配。"));
    }
    // The origin is normalized (absolute, no reparse component, no ambiguous
    // separators) and must not point back into the temporary relocation area.
    let source_dir = resolve_relocation_origin(&bootstrap.source_exe)?;
    let own_pid = std::process::id();
    if bootstrap.pid != own_pid {
        bootstrap.pid = own_pid;
        write_atomic(path, &serde_json::to_vec(&bootstrap).map_err(|e| internal(e.to_string()))?)
            .map_err(|e| internal(format!("无法刷新重定位属主：{e}")))?;
    }
    Ok(source_dir)
}

/// Normalize and vet the recorded launch origin without requiring the original
/// executable to still exist. Split out so the origin rules are directly
/// testable even though the running process is never the relocated copy in a
/// unit test.
pub(super) fn resolve_relocation_origin(source_exe: &str) -> Result<PathBuf, UninstallError> {
    let source = normalize_absolute_path(source_exe)?;
    let source_dir = source.as_path().parent().ok_or_else(|| internal("重定位源缺少目录。"))?;
    if path_is_same_or_descendant(source_dir, &operation_root()) {
        return Err(internal("重定位源指回临时区域。"));
    }
    Ok(source_dir.to_path_buf())
}
