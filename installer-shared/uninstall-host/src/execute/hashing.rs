//! Content hashing and atomic file writes used by the operation pipeline.
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

pub(super) const TREE_HASH_BUFFER: usize = 64 * 1024;

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    drop(file);
    replace_durable(&temporary, path)
}

#[cfg(windows)]
fn replace_durable(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source = source.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let target = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn replace_durable(source: &Path, target: &Path) -> Result<(), String> { fs::rename(source, target).map_err(|error| error.to_string()) }

pub fn sha256_file(path: &Path) -> Result<String, String> {
    sha256_of_file(path)
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
