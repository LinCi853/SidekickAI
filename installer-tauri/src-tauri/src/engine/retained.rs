use std::{fs, io::Read, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{
    GetFileInformationByHandle, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_WRITE_ATTRIBUTES,
    FileDispositionInfo, FILE_DISPOSITION_INFO,
}};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct DirectoryIdentity {
    volume_serial: u32,
    file_index_high: u32,
    file_index_low: u32,
    creation_time: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planned_file_moves_seal_regular_files_without_directory_suffixes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().join("build/verification").join(sidekickai_uninstall_core::random_id("installer-file-seal").unwrap());
        let backup = root.join("backup");
        fs::create_dir_all(&backup).unwrap();
        let source = root.join("LICENSE.electron.txt");
        fs::write(&source, b"runtime-license").unwrap();
        let seal = TreeSeal::planned_moves(&backup, &[(source.clone(), PathBuf::from("LICENSE.electron.txt"))]).unwrap();
        fs::rename(&source, backup.join("LICENSE.electron.txt")).unwrap();
        seal.verify(&backup, false).unwrap();
        seal.remove_verified(&backup).unwrap();
        assert!(!backup.exists());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn deletion_waits_for_a_shared_handle_to_close() {
        let root = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("installer-delete-pending").unwrap());
        fs::create_dir(&root).unwrap();
        let path = root.join("runtime.bin");
        fs::write(&path, b"runtime").unwrap();
        let observer = fs::OpenOptions::new().access_mode(0).share_mode(7).open(&path).unwrap();
        let guard = Guard::open(&path, true).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            drop(observer);
        });
        guard.delete(&path).unwrap();
        release.join().unwrap();
        assert!(!present(&path).unwrap());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn deletion_reports_a_handle_that_remains_open() {
        let root = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("installer-delete-held").unwrap());
        fs::create_dir(&root).unwrap();
        let path = root.join("runtime.bin");
        fs::write(&path, b"runtime").unwrap();
        let observer = fs::OpenOptions::new().access_mode(0).share_mode(7).open(&path).unwrap();
        let guard = Guard::open(&path, true).unwrap();
        assert!(guard.delete(&path).unwrap_err().contains("等待占用释放"));
        assert_eq!(observer.metadata().unwrap().len(), 7);
        drop(observer);
        assert!(!present(&path).unwrap());
        fs::remove_dir(root).unwrap();
    }
}

struct Guard {
    file: fs::File,
    identity: DirectoryIdentity,
    directory: bool,
}

impl Guard {
    fn open(path: &Path, deleting: bool) -> Result<Self, String> {
        let access = FILE_GENERIC_READ.0 | if deleting { DELETE.0 | FILE_WRITE_ATTRIBUTES.0 } else { 0 };
        let file = fs::OpenOptions::new().access_mode(access).share_mode(FILE_SHARE_READ.0)
            .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0).open(path)
            .map_err(|error| format!("无法锁定安装副本 {}：{error}", path.display()))?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(|error| format!("无法读取安装副本身份 {}：{error}", path.display()))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(format!("安装副本路径已变为重解析点，未操作：{}", path.display()));
        }
        Ok(Self { file, directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
            identity: DirectoryIdentity { volume_serial: info.dwVolumeSerialNumber,
                file_index_high: info.nFileIndexHigh, file_index_low: info.nFileIndexLow,
                creation_time: ((info.ftCreationTime.dwHighDateTime as u64) << 32) | info.ftCreationTime.dwLowDateTime as u64 } })
    }

    fn digest(&mut self) -> Result<Option<String>, String> {
        if self.directory { return Ok(None); }
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let size = self.file.read(&mut buffer).map_err(|error| error.to_string())?;
            if size == 0 { break; }
            hash.update(&buffer[..size]);
        }
        Ok(Some(format!("{:x}", hash.finalize())))
    }

    fn delete(self, path: &Path) -> Result<(), String> {
        let mut permissions = self.file.metadata().map_err(|error| error.to_string())?.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            self.file.set_permissions(permissions).map_err(|error| error.to_string())?;
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: windows::Win32::Foundation::BOOLEAN(1) };
        unsafe { SetFileInformationByHandle(HANDLE(self.file.as_raw_handle()), FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) }
            .map_err(|error| format!("无法清理已核验的安装副本 {}：{error}", path.display()))?;
        drop(self);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let reason = match fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Ok(_) => "删除尚未完成".to_string(),
                Err(error) if matches!(error.raw_os_error(), Some(5 | 32)) => error.to_string(),
                Err(error) => return Err(format!("无法确认安装副本清理结果 {}：{error}", path.display())),
            };
            if std::time::Instant::now() >= deadline {
                return Err(format!("安装副本正在等待占用释放：{}：{reason}", path.display()));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Entry {
    relative: PathBuf,
    identity: DirectoryIdentity,
    directory: bool,
    sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TreeSeal {
    pub(crate) identity: DirectoryIdentity,
    digest: String,
    entries: Vec<Entry>,
}

pub(crate) fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查安装副本 {}：{error}", path.display())),
    }
}

pub(crate) fn identity(path: &Path) -> Result<DirectoryIdentity, String> {
    let guard = Guard::open(path, false)?;
    if !guard.directory { return Err(format!("安装副本不是目录：{}", path.display())); }
    Ok(guard.identity.clone())
}

fn scan(root: &Path, relative: &Path, entries: &mut Vec<Entry>) -> Result<(), String> {
    let path = if relative.as_os_str().is_empty() { root.to_path_buf() } else { root.join(relative) };
    let mut guard = Guard::open(&path, false)?;
    entries.push(Entry { relative: relative.to_path_buf(), identity: guard.identity.clone(),
        directory: guard.directory, sha256: guard.digest()? });
    if guard.directory {
        let mut names = fs::read_dir(&path).map_err(|error| error.to_string())?
            .map(|entry| entry.map(|entry| entry.file_name())).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        names.sort();
        for name in names { scan(root, &relative.join(name), entries)?; }
    }
    Ok(())
}

impl TreeSeal {
    fn validate_manifest(&self) -> Result<(), String> {
        let Some(root) = self.entries.first() else { return Err("安装副本清单为空。".into()); };
        if !root.relative.as_os_str().is_empty() || !root.directory || root.identity != self.identity {
            return Err("安装副本清单根身份不匹配。".into());
        }
        let mut names = std::collections::HashSet::new();
        for (index, entry) in self.entries.iter().enumerate() {
            if (index > 0 && entry.relative.as_os_str().is_empty())
                || !entry.relative.components().all(|part| matches!(part, std::path::Component::Normal(_)))
                || !names.insert(&entry.relative) {
                return Err("安装副本清单含越界或重复路径，未操作。".into());
            }
        }
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&self.entries).map_err(|error| error.to_string())?));
        if digest != self.digest { return Err("安装副本清单摘要不匹配，未操作。".into()); }
        Ok(())
    }

    pub(crate) fn capture(path: &Path) -> Result<Self, String> {
        sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
        let mut entries = Vec::new();
        scan(path, Path::new(""), &mut entries)?;
        if !entries[0].directory { return Err(format!("安装副本不是目录：{}", path.display())); }
        entries.sort_by(|left, right| left.relative.cmp(&right.relative));
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&entries).map_err(|error| error.to_string())?));
        Ok(Self { identity: entries[0].identity.clone(), digest, entries })
    }

    pub(crate) fn planned_moves(path: &Path, sources: &[(PathBuf, PathBuf)]) -> Result<Self, String> {
        let mut seal = Self::capture(path)?;
        let mut parents = std::collections::HashSet::from([PathBuf::new()]);
        for (_, destination) in sources {
            if destination.as_os_str().is_empty() || !destination.components().all(|part| matches!(part, std::path::Component::Normal(_))) {
                return Err("安装副本移动计划含越界路径。".into());
            }
            let mut parent = destination.parent();
            while let Some(path) = parent { parents.insert(path.to_path_buf()); parent = path.parent(); }
        }
        if seal.entries.iter().any(|entry| !entry.directory || !parents.contains(&entry.relative)) {
            return Err("安装副本准备目录出现未登记内容，未移动原文件。".into());
        }
        for (source, destination) in sources {
            let destination: PathBuf = destination.components().collect();
            let mut entries = Vec::new();
            scan(source, Path::new(""), &mut entries)?;
            for mut entry in entries {
                entry.relative = if entry.relative.as_os_str().is_empty() { destination.clone() } else { destination.join(&entry.relative) };
                seal.entries.push(entry);
            }
        }
        seal.entries.sort_by(|left, right| left.relative.cmp(&right.relative));
        seal.digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&seal.entries).map_err(|error| error.to_string())?));
        seal.validate_manifest()?;
        Ok(seal)
    }

    pub(crate) fn without(&self, roots: &[PathBuf]) -> Result<Self, String> {
        self.validate_manifest()?;
        for root in roots {
            if root.as_os_str().is_empty() || !root.components().all(|part| matches!(part, std::path::Component::Normal(_)))
                || !self.entries.iter().any(|entry| &entry.relative == root) {
                return Err("资料移动不属于已封存安装副本，未操作。".into());
            }
        }
        let entries = self.entries.iter().filter(|entry| !roots.iter().any(|root| entry.relative.starts_with(root))).cloned().collect::<Vec<_>>();
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&entries).map_err(|error| error.to_string())?));
        Ok(Self { identity: self.identity.clone(), digest, entries })
    }

    pub(crate) fn verify(&self, path: &Path, cleanup_started: bool) -> Result<(), String> {
        self.validate_manifest()?;
        let current = Self::capture(path)?;
        let unchanged = current.identity == self.identity && if cleanup_started {
            let expected = self.entries.iter().map(|entry| (entry.relative.as_path(), entry)).collect::<std::collections::HashMap<_, _>>();
            current.entries.iter().all(|entry| expected.get(entry.relative.as_path()).is_some_and(|expected| *expected == entry))
        } else { current.digest == self.digest };
        if !unchanged { return Err(format!("安装副本身份或内容已被外部修改，已保留：{}", path.display())); }
        Ok(())
    }

    pub(crate) fn remove_verified(&self, path: &Path) -> Result<(), String> {
        self.validate_manifest()?;
        self.remove_entry(path, &self.entries[0])
    }

    fn remove_entry(&self, root: &Path, expected: &Entry) -> Result<(), String> {
        let path = root.join(&expected.relative);
        if !present(&path)? { return Ok(()); }
        let mut guard = Guard::open(&path, true)?;
        if guard.identity != expected.identity || guard.directory != expected.directory || guard.digest()? != expected.sha256 {
            return Err(format!("安装副本条目已变化，未删除：{}", path.display()));
        }
        if expected.directory {
            for child in self.entries.iter().filter(|entry| !entry.relative.as_os_str().is_empty() && entry.relative.parent() == Some(expected.relative.as_path())) {
                self.remove_entry(root, child)?;
            }
            if fs::read_dir(&path).map_err(|error| error.to_string())?.next().is_some() {
                return Err(format!("安装副本含未登记内容，已保留：{}", path.display()));
            }
        }
        guard.delete(&path)
    }
}
