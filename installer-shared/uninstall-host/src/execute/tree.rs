//! Complete data-tree digests: change detection and the cross-language
//! export-tree digest binding.
use super::hashing::sha256_of_file;
use super::{internal, unsafe_path};
use sha2::{Digest, Sha256};
use sidekickai_uninstall_core::lock::windows_ordinal_upper;
use sidekickai_uninstall_core::protocol::{UninstallError, UninstallErrorCode, UninstallPhase};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
pub(super) fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(super) fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

/// Canonical key for one tree entry: the volume-relative path with one separator
/// spelling, folded with the same Windows ordinal uppercase the lock layer uses.
/// The fold is fail-closed: an unmappable identity is an error, never the
/// original text (which would let two spellings escape one digest).
fn tree_record_key(relative: &Path) -> Result<String, UninstallError> {
    let text = relative.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        windows_ordinal_upper(&text)
    }
    #[cfg(not(windows))]
    {
        Ok(text)
    }
}

/// One raw record from the complete data-tree walk. `path` keeps the on-disk
/// spelling; each digest function below decides how it is serialized.
struct TreeRecord {
    path: PathBuf,
    kind: u8,
    length: u64,
    sha256: String,
}

fn collect_tree_records(
    root: &Path,
    current: &Path,
    records: &mut Vec<TreeRecord>,
) -> Result<(), UninstallError> {
    let entries = fs::read_dir(current)
        .map_err(|e| unsafe_path(format!("无法枚举用户数据 {}：{e}", current.display())))?;
    for entry in entries {
        let entry = entry.map_err(|e| unsafe_path(format!("无法枚举用户数据：{e}")))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| unsafe_path(format!("无法检查用户数据 {}：{e}", path.display())))?;
        if metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
            return Err(UninstallError::new(
                UninstallErrorCode::PathReparsePoint,
                format!("用户数据包含重解析点：{}", path.display()),
                UninstallPhase::Validating,
                false,
                "",
            ));
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if metadata.is_dir() {
            records.push(TreeRecord { path: relative.to_path_buf(), kind: 1, length: 0, sha256: String::new() });
            collect_tree_records(root, &path, records)?;
        } else if metadata.is_file() {
            let hash = sha256_of_file(&path)
                .map_err(|e| unsafe_path(format!("无法计算用户数据 {} 的哈希：{e}", path.display())))?;
            records.push(TreeRecord { path: relative.to_path_buf(), kind: 2, length: metadata.len(), sha256: hash });
        } else {
            return Err(unsafe_path(format!("用户数据包含非常规文件：{}", path.display())));
        }
    }
    Ok(())
}

/// Digest of every entry below `root`: relative path, entry kind, length and file
/// bytes, in a deterministic order. Unlike `FileFingerprint`, overwriting an
/// existing data file (which does not change the directory mtime) changes this
/// digest.
pub(super) fn tree_digest(root: &Path) -> Result<String, UninstallError> {
    let mut records: Vec<TreeRecord> = Vec::new();
    collect_tree_records(root, root, &mut records)?;
    let mut folded: Vec<(String, u8, u64, String)> = Vec::with_capacity(records.len());
    for record in records {
        folded.push((tree_record_key(&record.path)?, record.kind, record.length, record.sha256));
    }
    folded.sort();
    let mut hasher = Sha256::new();
    for (path, kind, len, hash) in folded {
        hasher.update(path.as_bytes());
        hasher.update([kind]);
        hasher.update(len.to_le_bytes());
        hasher.update(hash.as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// A file length above this cannot round-trip through a JavaScript number, so it
/// would let the Node exporter and this host disagree on the same tree. Refusing
/// is fail-closed.
const MAX_SAFE_TREE_LENGTH: u64 = 9_007_199_254_740_991;

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Cross-language digest of the complete data tree (`export-tree-digest-v1`).
///
/// The canonical form is a whitespace-free JSON array with one tuple per entry,
/// sorted by the ASCII hex path: `[UTF8_HEX(relative path with '/' separators),
/// kind (1 directory / 2 file), length (0 for a directory), SHA-256 of the file
/// bytes ("" for a directory)]`. The returned digest is the SHA-256 of exactly
/// those JSON bytes.
///
/// Paths are hex-encoded from the raw UTF-8 name with no case or locale mapping,
/// so the Node exporter and this host agree on the same on-disk tree. Names that
/// are not valid UTF-8, links and reparse points fail closed. This digest binds a
/// deletion to the exporter-time tree, including files the selected backup
/// categories intentionally omit (they are change detection, not archive
/// content).
pub(crate) fn export_tree_digest(root: &Path) -> Result<String, UninstallError> {
    let mut records: Vec<TreeRecord> = Vec::new();
    collect_tree_records(root, root, &mut records)?;
    let mut tuples: Vec<(String, u8, u64, String)> = Vec::with_capacity(records.len());
    for record in records {
        let relative = record.path.to_str().ok_or_else(|| unsafe_path(format!(
            "用户数据包含无效的 UTF-8 名称：{}", record.path.display()
        )))?.replace('\\', "/");
        if record.length > MAX_SAFE_TREE_LENGTH {
            return Err(unsafe_path(format!("用户数据条目过大，无法生成摘要：{relative}")));
        }
        tuples.push((hex_encode(relative.as_bytes()), record.kind, record.length, record.sha256));
    }
    tuples.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical = serde_json::to_string(&tuples)
        .map_err(|error| internal(format!("无法序列化数据树摘要：{error}")))?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}
