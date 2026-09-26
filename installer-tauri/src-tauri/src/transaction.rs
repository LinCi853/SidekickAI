use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const OWNER: &str = "sidekick-open-source-install.json";
pub const PAYLOAD: &str = "sidekick-open-source-payload.json";
pub const EDITION: &str = "sidekickai-opensource";
pub const EXECUTABLE: &str = "SidekickAI-OpenSource.exe";

/// Resolve the existing ancestor so short names and extended paths share one identity.
pub fn path_identity(path: &Path) -> Result<PathBuf, String> {
    plain_path(path)?;
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(ancestor.file_name().ok_or("无法确认路径名称")?.to_owned());
                ancestor = ancestor.parent().ok_or("无法确认路径归属")?;
            }
            Err(error) => return Err(format!("无法确认路径 {}：{}", ancestor.display(), error)),
        }
    }
    let mut resolved = fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(PathBuf::from(resolved.to_string_lossy().to_lowercase()))
}

pub fn paths_overlap(left: &Path, right: &Path) -> Result<bool, String> {
    let left = path_identity(left)?;
    let right = path_identity(right)?;
    Ok(left.starts_with(&right) || right.starts_with(&left))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ownership {
    pub schema: u32,
    pub edition: String,
    pub version: String,
    pub arch: String,
    pub for_all_users: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadManifest {
    pub schema: u32,
    pub edition: String,
    pub version: String,
    pub arch: String,
    pub files: BTreeMap<String, String>,
}

pub fn plain_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.components().count() < 3
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("请选择独立的绝对安装目录，不能使用磁盘根目录或相对路径".into());
    }
    for component in path.components() {
        match component {
            Component::Prefix(prefix)
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                ) =>
            {
                return Err("请选择本机磁盘上的独立目录，不支持设备或网络路径".into());
            }
            Component::Normal(name) => {
                let name = name.to_str().ok_or("路径包含无法识别的字符")?;
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
                    .contains(&stem.as_str())
                    || ["COM", "LPT"].iter().any(|prefix| {
                        stem.strip_prefix(prefix).is_some_and(|suffix| {
                            ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"]
                                .contains(&suffix)
                        })
                    });
                if name.ends_with(['.', ' '])
                    || reserved
                    || name
                        .chars()
                        .any(|ch| ch < ' ' || ['<', '>', ':', '"', '|', '?', '*'].contains(&ch))
                {
                    return Err(format!(
                        "路径名称不安全，请移除末尾点、空格或设备名称：{}",
                        name
                    ));
                }
            }
            _ => {}
        }
    }
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
                return Err(format!(
                    "不允许通过目录联接或符号链接操作：{}",
                    ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

pub fn plain_tree(path: &Path) -> Result<(), String> {
    plain_path(path)?;
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            plain_tree(&entry.map_err(|error| error.to_string())?.path())?;
        }
    }
    Ok(())
}

pub fn ownership(path: &Path) -> Result<Ownership, String> {
    plain_path(path)?;
    let document: Ownership = serde_json::from_slice(
        &fs::read(path.join(OWNER))
            .map_err(|_| "目录缺少开源版安装标记，未修改其中的文件".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if document.schema != 1
        || document.edition != EDITION
        || document.version.is_empty()
        || !["x64", "arm64"].contains(&document.arch.as_str())
    {
        return Err("该目录不属于受支持的开源版安装".into());
    }
    if path.join("portable.txt").exists() || path.join("data").exists() {
        return Err("目录包含便携版标记或本地数据，请保留该目录并选择独立安装位置".into());
    }
    Ok(document)
}

pub fn destination(path: &Path) -> Result<Option<Ownership>, String> {
    plain_path(path)?;
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_dir() {
        return Err("安装位置不是目录".into());
    }
    if fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        return Ok(None);
    }
    let owner = ownership(path)?;
    plain_tree(path)?;
    Ok(Some(owner))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("无法读取 {}：{}", path.display(), error))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn collect_files(root: &Path, path: &Path, found: &mut BTreeSet<String>) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        plain_path(&path)?;
        if path.is_dir() {
            collect_files(root, &path, found)?;
        } else {
            found.insert(
                path.strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    Ok(())
}

pub fn validate_payload(path: &Path, expected_arch: &str) -> Result<PayloadManifest, String> {
    plain_tree(path)?;
    let manifest: PayloadManifest = serde_json::from_slice(
        &fs::read(path.join(PAYLOAD)).map_err(|error| format!("缺少完整载荷清单：{}", error))?,
    )
    .map_err(|error| error.to_string())?;
    if manifest.schema != 1
        || manifest.edition != EDITION
        || manifest.arch != expected_arch
        || manifest.version != env!("CARGO_PKG_VERSION")
    {
        return Err("载荷身份、版本或处理器架构不匹配".into());
    }
    for required in [
        EXECUTABLE,
        "resources/app.asar",
        "icudtl.dat",
        "resources.pak",
        "libEGL.dll",
        "libGLESv2.dll",
        "locales/en-US.pak",
    ] {
        if !manifest.files.contains_key(required) {
            return Err(format!("载荷缺少运行文件：{}", required));
        }
    }
    let mut actual = BTreeSet::new();
    collect_files(path, path, &mut actual)?;
    actual.remove(PAYLOAD);
    if actual != manifest.files.keys().cloned().collect() {
        return Err("载荷文件列表与清单不一致".into());
    }
    for (relative, expected) in &manifest.files {
        if relative.contains(':')
            || relative.contains('\\')
            || !Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("载荷路径不合法".into());
        }
        if expected.len() != 64 || hash_file(&path.join(relative))? != *expected {
            return Err(format!("载荷校验失败：{}", relative));
        }
    }
    Ok(manifest)
}

pub fn ensure_unlocked(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    plain_tree(path)?;
    let mut files = BTreeSet::new();
    collect_files(path, path, &mut files)?;
    for relative in files {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(path.join(&relative))
            .map_err(|error| {
                format!(
                    "文件仍被占用或不可写，原目录已保留：{}（{}）",
                    relative, error
                )
            })?;
    }
    Ok(())
}

pub fn sibling(path: &Path, purpose: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("缺少父目录")?;
    let name = path.file_name().ok_or("缺少目录名")?.to_string_lossy();
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
    Ok(parent.join(format!(
        ".{}-{}-{:016x}",
        name,
        purpose,
        u64::from_le_bytes(random)
    )))
}

pub fn ensure_no_pending_transaction(target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("缺少父目录")?;
    for name in [
        ".sidekick-open-source-transaction.json",
        ".sidekick-open-source-uninstall.json",
    ] {
        let journal = parent.join(name);
        match fs::symlink_metadata(&journal) {
            Ok(_) => {
                return Err(format!(
                    "检测到未完成的事务，请根据记录恢复后重试：{}",
                    journal.display()
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法检查恢复记录：{}（{}）",
                    journal.display(),
                    error
                ))
            }
        }
    }
    Ok(())
}

/** A directory replacement either completes or retains an explicit recovery journal. */
pub fn replace_install(
    staged: &Path,
    target: &Path,
    integration: &Path,
    finalize: impl FnOnce() -> Result<(), String>,
    restore_integration: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    ensure_no_pending_transaction(target)?;
    destination(target)?;
    let backup = sibling(target, "recovery")?;
    let journal = target
        .parent()
        .ok_or("缺少父目录")?
        .join(".sidekick-open-source-transaction.json");
    if journal.exists() {
        return Err(format!(
            "检测到未完成的安装事务，请根据记录恢复后重试：{}",
            journal.display()
        ));
    }
    let had_old = target.exists();
    if had_old {
        ensure_unlocked(target)?;
    }
    let record = serde_json::json!({ "schema": 1, "edition": EDITION, "target": target, "backup": backup, "staged": staged, "integration": integration });
    let mut journal_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&journal)
        .map_err(|error| error.to_string())?;
    journal_file
        .write_all(record.to_string().as_bytes())
        .and_then(|_| journal_file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(journal_file);
    if had_old {
        if let Err(error) = fs::rename(target, &backup) {
            fs::remove_file(&journal)
                .map_err(|cleanup| format!("{}；事务记录保留：{}", error, cleanup))?;
            return Err(format!("无法备份原目录，未执行覆盖：{}", error));
        }
    }
    let result = fs::rename(staged, target)
        .map_err(|error| error.to_string())
        .and_then(|_| finalize());
    if let Err(error) = result {
        let rejected = sibling(target, "rejected")?;
        if target.exists() {
            fs::rename(target, &rejected).map_err(|rollback| {
                format!(
                    "{}；无法移开未完成安装：{}。恢复记录：{}",
                    error,
                    rollback,
                    journal.display()
                )
            })?;
        }
        if had_old {
            fs::rename(&backup, target).map_err(|rollback| {
                format!(
                    "{}；原文件保留在 {}，自动恢复失败：{}",
                    error,
                    backup.display(),
                    rollback
                )
            })?;
        }
        restore_integration().map_err(|restore| {
            format!(
                "{}；运行文件已恢复，但系统登记恢复失败：{}。恢复记录已保留：{}",
                error,
                restore,
                journal.display()
            )
        })?;
        fs::remove_file(&journal)
            .map_err(|cleanup| format!("{}；目录已恢复，但事务记录未能删除：{}", error, cleanup))?;
        if rejected.exists() {
            fs::remove_dir_all(&rejected).map_err(|cleanup| {
                format!(
                    "{}；原目录已恢复，临时文件保留在 {}：{}",
                    error,
                    rejected.display(),
                    cleanup
                )
            })?;
        }
        return Err(format!("安装未完成，原目录已恢复：{}", error));
    }
    if had_old {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("安装完成，旧文件保留在 {}：{}", backup.display(), error))?;
    }
    fs::remove_file(&journal).map_err(|error| format!("安装完成，事务记录未能删除：{}", error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = sibling(
            &std::env::temp_dir().join("sidekick-installer-test"),
            "fixture",
        )
        .unwrap();
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn own(path: &Path) {
        fs::create_dir_all(path).unwrap();
        fs::write(
            path.join(OWNER),
            serde_json::to_vec(&Ownership {
                schema: 1,
                edition: EDITION.into(),
                version: "test".into(),
                arch: "x64".into(),
                for_all_users: false,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(path.join(EXECUTABLE), b"old runtime").unwrap();
    }
    #[test]
    fn foreign_and_portable_directories_are_preserved() {
        let root = fixture();
        fs::write(root.join("SidekickAI.exe"), b"online sentinel").unwrap();
        assert!(destination(&root).is_err());
        assert_eq!(
            fs::read(root.join("SidekickAI.exe")).unwrap(),
            b"online sentinel"
        );
        own(&root);
        fs::write(root.join("portable.txt"), b"").unwrap();
        assert!(destination(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_registration_restores_the_full_previous_installation() {
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        fs::write(staged.join(EXECUTABLE), b"new runtime").unwrap();
        assert!(replace_install(
            &staged,
            &target,
            &root,
            || Err("registration rejected".into()),
            || Ok(())
        )
        .is_err());
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"old runtime");
        assert!(!root.join(".sidekick-open-source-transaction.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_integration_restore_retains_recovery_journal() {
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        let error = replace_install(
            &staged,
            &target,
            &root,
            || Err("registration failed".into()),
            || Err("snapshot locked".into()),
        )
        .unwrap_err();
        assert!(error.contains("snapshot locked"));
        assert!(root.join(".sidekick-open-source-transaction.json").exists());
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"old runtime");
        assert!(ensure_no_pending_transaction(&target).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uninstall_journal_blocks_replacement() {
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        let journal = root.join(".sidekick-open-source-uninstall.json");
        fs::write(&journal, b"unresolved uninstall").unwrap();
        assert!(replace_install(&staged, &target, &root, || Ok(()), || Ok(())).is_err());
        assert_eq!(fs::read(&journal).unwrap(), b"unresolved uninstall");
        assert!(staged.exists());
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"old runtime");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_identity_unifies_separators_extended_paths_and_short_names() {
        let root = fixture();
        let data = root.join("long directory for backup identity");
        fs::create_dir(&data).unwrap();
        let identity = path_identity(&data).unwrap();
        assert_eq!(
            identity,
            path_identity(&fs::canonicalize(&data).unwrap()).unwrap()
        );
        assert_eq!(
            identity,
            path_identity(Path::new(&data.to_string_lossy().replace('\\', "/"))).unwrap()
        );
        assert!(
            paths_overlap(&data, &fs::canonicalize(&data).unwrap().join("backup.zip")).unwrap()
        );
        #[link(name = "kernel32")]
        extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, size: u32) -> u32;
        }
        use std::os::windows::ffi::OsStrExt;
        let long: Vec<u16> = data.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut short = vec![0u16; 32768];
        let length =
            unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
        assert!(length > 0 && (length as usize) < short.len());
        let short = PathBuf::from(String::from_utf16(&short[..length as usize]).unwrap());
        assert_eq!(identity, path_identity(&short).unwrap());
        assert!(paths_overlap(&data, &short.join("backup.zip")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locked_runtime_aborts_before_replacement() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(target.join(EXECUTABLE))
            .unwrap();
        assert!(replace_install(&staged, &target, &root, || Ok(()), || Ok(())).is_err());
        drop(lock);
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"old runtime");
        assert!(staged.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replacement_removes_obsolete_runtime_files() {
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        fs::write(target.join("obsolete.dll"), b"old").unwrap();
        fs::write(staged.join(EXECUTABLE), b"new runtime").unwrap();
        replace_install(&staged, &target, &root, || Ok(()), || Ok(())).unwrap();
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"new runtime");
        assert!(!target.join("obsolete.dll").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn payload(root: &Path) {
        let mut files = BTreeMap::new();
        for relative in [
            EXECUTABLE,
            "resources/app.asar",
            "icudtl.dat",
            "resources.pak",
            "libEGL.dll",
            "libGLESv2.dll",
            "locales/en-US.pak",
        ] {
            let file = root.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, relative.as_bytes()).unwrap();
            files.insert(relative.into(), hash_file(&file).unwrap());
        }
        fs::write(
            root.join(PAYLOAD),
            serde_json::to_vec(&PayloadManifest {
                schema: 1,
                edition: EDITION.into(),
                version: env!("CARGO_PKG_VERSION").into(),
                arch: "x64".into(),
                files,
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn payload_verification_rejects_corruption_extra_files_and_wrong_architecture() {
        let root = fixture();
        payload(&root);
        assert!(validate_payload(&root, "x64").is_ok());
        assert!(validate_payload(&root, "arm64").is_err());
        fs::write(root.join("libEGL.dll"), b"corrupted").unwrap();
        assert!(validate_payload(&root, "x64").is_err());
        payload(&root);
        fs::write(root.join("unexpected.dll"), b"extra").unwrap();
        assert!(validate_payload(&root, "x64").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unresolved_journal_preserves_both_runtime_directories() {
        let root = fixture();
        let target = root.join("installed");
        let staged = root.join("staged");
        own(&target);
        own(&staged);
        let journal = root.join(".sidekick-open-source-transaction.json");
        fs::write(&journal, b"existing recovery evidence").unwrap();
        assert!(replace_install(&staged, &target, &root, || Ok(()), || Ok(())).is_err());
        assert_eq!(fs::read(&journal).unwrap(), b"existing recovery evidence");
        assert_eq!(fs::read(target.join(EXECUTABLE)).unwrap(), b"old runtime");
        assert!(staged.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_paths_are_rejected_before_any_mutation() {
        assert!(plain_path(Path::new("C:/")).is_err());
        assert!(plain_path(Path::new("relative/install")).is_err());
        assert!(plain_path(Path::new("C:/temp/../Windows")).is_err());
    }

    #[test]
    fn ambiguous_windows_names_cannot_authorize_removal() {
        for path in [
            "C:/fixture/data./backup.zip",
            "C:/fixture/data /backup.zip",
            "C:/fixture/file:stream",
            "C:/fixture/NUL.txt",
            "C:/fixture/COM1",
        ] {
            assert!(plain_path(Path::new(path)).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn overlapping_windows_paths_ignore_case_and_preserve_directory_boundaries() {
        let data = Path::new("C:/Users/Fixture/Data");
        assert!(paths_overlap(data, Path::new("c:/users/fixture/DATA/backup.zip")).unwrap());
        assert!(paths_overlap(data, Path::new("C:/USERS/FIXTURE")).unwrap());
        assert!(paths_overlap(data, Path::new("c:/users/fixture/data")).unwrap());
        assert!(
            !paths_overlap(data, Path::new("C:/Users/Fixture/Data-backups/backup.zip")).unwrap()
        );
    }
}
