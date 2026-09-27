//! Content hashing and atomic file writes used by the operation pipeline.
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

pub(super) const TREE_HASH_BUFFER: usize = 64 * 1024;

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

/// Streaming variant used for the data-tree digest, so a large user-data file
/// is never read into memory as a whole.
pub(super) fn sha256_of_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; TREE_HASH_BUFFER];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
