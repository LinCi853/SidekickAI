use std::{cell::RefCell, fs, io::{Read, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use winreg::{RegValue, enums::*};
use crate::manifest::InstallRequest;
use super::pipeline::EngineHooks;
use super::retained::{self, DirectoryIdentity, TreeSeal};

thread_local! { static ACTIVE: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct Value { kind: u32, bytes: Vec<u8> }
impl Value {
    fn from_raw(value: RegValue) -> Self { Self { kind: value.vtype as u32, bytes: value.bytes } }
    fn raw(&self) -> Result<RegValue, String> {
        let kind = match self.kind { 0 => REG_NONE, 1 => REG_SZ, 2 => REG_EXPAND_SZ, 3 => REG_BINARY, 4 => REG_DWORD,
            5 => REG_DWORD_BIG_ENDIAN, 6 => REG_LINK, 7 => REG_MULTI_SZ, 8 => REG_RESOURCE_LIST,
            9 => REG_FULL_RESOURCE_DESCRIPTOR, 10 => REG_RESOURCE_REQUIREMENTS_LIST, 11 => REG_QWORD,
            _ => return Err("安装恢复记录含不支持的注册表类型".into()) };
        Ok(RegValue { vtype: kind, bytes: self.bytes.clone() })
    }
}
#[derive(Serialize, Deserialize)]
struct RegistryChange { key: String, name: String, before: Option<Value>, after: Option<Value>, expected: Vec<Option<Value>> }
#[derive(Serialize, Deserialize)]
struct SavedPath { path: PathBuf, digest: Option<String>, slot: usize }
#[derive(Serialize, Deserialize)]
struct RetainedPath {
    path: PathBuf,
    identity: Option<DirectoryIdentity>,
    seal: Option<TreeSeal>,
    sealed: bool,
    cleanup_started: bool,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    schema: u32, edition: String, sid: String, target: PathBuf, state: String,
    for_all_users: bool, cleanup_paths: Vec<String>,
    paths: Vec<SavedPath>, registry: Vec<RegistryChange>,
    registry_keys: Vec<(String, bool)>,
    #[serde(default)]
    tasks: Vec<sidekickai_uninstall_host::startup_tasks::TaskSnapshot>,
    #[serde(default)]
    retained: Vec<PathBuf>,
    #[serde(default)]
    owned_retained: Vec<RetainedPath>,
}

pub(crate) struct Transaction { root: PathBuf }
impl Drop for Transaction { fn drop(&mut self) { ACTIVE.with(|active| *active.borrow_mut() = None); } }

pub(crate) fn active() -> bool { ACTIVE.with(|active| active.borrow().is_some()) }

pub(crate) fn retain(path: &Path) -> Result<(), String> {
    if !active() { return Ok(()); }
    let seal = if retained::present(path)? { Some(TreeSeal::capture(path)?) } else { None };
    retain_proof(path, seal, true)
}

pub(crate) fn retain_move(source: &Path, target: &Path) -> Result<(), String> {
    if !active() { return Ok(()); }
    retain_proof(target, Some(TreeSeal::capture(source)?), false)
}

pub(crate) fn retain_prepared(path: &Path, seal: &TreeSeal) -> Result<(), String> {
    seal.verify(path, false)?;
    retain_proof(path, Some(seal.clone()), true)
}

fn retain_proof(path: &Path, seal: Option<TreeSeal>, sealed: bool) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        if !retained_sibling(path, &journal.target) { return Err("安装副本路径不属于当前任务。".into()); }
        if journal.owned_retained.iter().any(|entry| entry.path == path) { return Err("安装副本已登记，未覆盖原身份记录。".into()); }
        journal.owned_retained.push(RetainedPath { path: path.to_path_buf(), identity: seal.as_ref().map(|seal| seal.identity.clone()),
            sealed: sealed && seal.is_some(), seal, cleanup_started: false });
        save(root, &journal)
    })
}

pub(crate) fn bind_retained(path: &Path) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        let owned = journal.owned_retained.iter_mut().find(|entry| entry.path == path).ok_or("安装副本缺少写前记录。")?;
        let identity = retained::identity(path)?;
        if owned.identity.as_ref().is_some_and(|expected| expected != &identity) { return Err("安装副本身份已变化，未覆盖原记录。".into()); }
        owned.identity = Some(identity);
        save(root, &journal)
    })
}

pub(crate) fn seal_retained(path: &Path) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        let owned = journal.owned_retained.iter_mut().find(|entry| entry.path == path).ok_or("安装副本缺少写前记录。")?;
        let seal = TreeSeal::capture(path)?;
        if owned.identity.as_ref().is_some_and(|expected| expected != &seal.identity) { return Err("安装副本身份已变化，未封存。".into()); }
        if let Some(expected) = &owned.seal { expected.verify(path, false)?; }
        owned.identity = Some(seal.identity.clone());
        owned.seal = Some(seal);
        owned.sealed = true;
        save(root, &journal)
    })
}

pub(crate) fn prepare_retained_removal(path: &Path, relatives: &[PathBuf]) -> Result<(), String> {
    if relatives.is_empty() { return Ok(()); }
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        let owned = journal.owned_retained.iter_mut().find(|entry| entry.path == path).ok_or("安装副本缺少写前记录。")?;
        let seal = owned.seal.as_ref().filter(|_| owned.sealed).ok_or("安装副本尚未封存，不能移动资料。")?;
        seal.verify(path, false)?;
        owned.seal = Some(seal.without(relatives)?);
        owned.sealed = false;
        save(root, &journal)
    })
}

pub(crate) fn prepare_retained_moves(path: &Path, sources: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        let owned = journal.owned_retained.iter_mut().find(|entry| entry.path == path).ok_or("安装副本缺少写前记录。")?;
        let seal = TreeSeal::planned_moves(path, sources)?;
        if owned.identity.as_ref() != Some(&seal.identity) { return Err("安装副本身份已变化，未移动原文件。".into()); }
        owned.seal = Some(seal);
        owned.sealed = false;
        save(root, &journal)
    })
}

pub(crate) fn clean_prepared(path: &Path, seal: &TreeSeal) -> Result<(), String> {
    if retained::present(path)? {
        seal.verify(path, false)?;
        seal.remove_verified(path)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo { pub install_dir: String, pub for_all_users: bool, pub cleanup_paths: Vec<String>, pub journal_path: String, pub state: String }

fn index_root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("无法定位当前用户的安装恢复记录")?).join("SidekickAI").join("installer-recovery").join(sidekickai_uninstall_core::product::edition_id()))
}

fn index_record(root: &Path, journal: &Journal, hooks: &EngineHooks) -> Result<(), String> {
    if hooks.registration_key.is_some() { return Ok(()); }
    let directory = index_root()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    sidekickai_uninstall_host::harden_private_directory(&directory).map_err(|error| error.message)?;
    let info = RecoveryInfo { install_dir: journal.target.to_string_lossy().into_owned(), for_all_users: journal.for_all_users, cleanup_paths: journal.cleanup_paths.clone(), journal_path: root.to_string_lossy().into_owned(), state: journal.state.clone() };
    let path = directory.join(root.file_name().ok_or("恢复路径无效")?).with_extension("json");
    sidekickai_uninstall_core::write_private_file(&path, &serde_json::to_vec(&info).map_err(|error| error.to_string())?).map_err(|error| error.message)
}

pub fn pending_installations() -> Result<Vec<RecoveryInfo>, String> {
    let directory = index_root()?;
    if !directory.exists() { return Ok(Vec::new()); }
    sidekickai_uninstall_core::path::validate_tree(&directory).map_err(|error| error.message)?;
    crate::controller::verify_recovery_directory(&directory)?;
    let mut pending = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_none_or(|value| value != "json") { continue; }
        if fs::metadata(&path).map_err(|error| error.to_string())?.len() > 64 * 1024 { return Err("安装恢复索引过大。".into()); }
        let mut info: RecoveryInfo = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?).map_err(|error| format!("安装恢复索引损坏：{error}"))?;
        let target = super::scope::normalize_owned_dir(&info.install_dir, "安装目录")?;
        let root = root_for(&target)?;
        if root.to_string_lossy() != info.journal_path { return Err("安装恢复索引身份不匹配。".into()); }
        if !root.exists() { continue; }
        let journal = load(&root)?;
        if journal.target != target || journal.for_all_users != info.for_all_users || journal.cleanup_paths != info.cleanup_paths
            || journal.sid != sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)? || journal.edition != sidekickai_uninstall_core::product::edition_id() {
            return Err("安装恢复任务身份不匹配。".into());
        }
        info.state = journal.state;
        pending.push(info);
    }
    Ok(pending)
}

pub(crate) fn root_for(target: &Path) -> Result<PathBuf, String> {
    let normal = sidekickai_uninstall_core::path::normalize_absolute_path(target).map_err(|error| error.message)?.as_string().to_lowercase();
    let key = format!("{:x}", Sha256::digest(normal.as_bytes()));
    Ok(target.parent().ok_or("安装目录无效")?.join(format!(".sidekick-install-recovery-{}", &key[..24])))
}

pub(crate) fn committed(target: &Path) -> Result<bool, String> {
    let root = root_for(target)?;
    if !root.join("journal.json").exists() { return Ok(false); }
    Ok(load(&root)?.state == "committed")
}

fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 { return Err("安装恢复记录超出支持大小，已保留上一份记录与原件。".into()); }
    write_file(root.join("journal.json"), bytes).map_err(|error| format!("无法持久保存安装恢复记录：{error}"))
}

pub(crate) fn write_file(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    let path = path.as_ref();
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| std::io::Error::other(error.message))?;
    let root = path.parent().ok_or_else(|| std::io::Error::other("missing parent"))?;
    let name = sidekickai_uninstall_core::random_id("journal").map_err(|error| std::io::Error::other(error.message))?;
    let temporary = root.join(name);
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    file.write_all(bytes.as_ref()).and_then(|_| file.sync_all())?;
    drop(file);
    let source = crate::elevate::wide(&temporary.to_string_lossy());
    let target = crate::elevate::wide(&path.to_string_lossy());
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}};
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }.map_err(std::io::Error::other)
}

fn load(root: &Path) -> Result<Journal, String> {
    sidekickai_uninstall_core::path::validate_tree(root).map_err(|error| error.message)?;
    crate::controller::verify_recovery_directory(root)?;
    let path = root.join("journal.json");
    if fs::metadata(&path).map_err(|error| error.to_string())?.len() > 16 * 1024 * 1024 { return Err("安装恢复记录过大".into()); }
    let journal: Journal = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| format!("安装恢复记录损坏，原件已保留：{error}"))?;
    let target = super::scope::normalize_owned_dir(&journal.target.to_string_lossy(), "安装目录")?;
    if journal.schema != 1 || journal.edition != sidekickai_uninstall_core::product::edition_id()
        || journal.sid != sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)?
        || !sidekickai_uninstall_core::path::paths_equal(root, &root_for(&target)?) {
        return Err("安装恢复记录与当前账户、产品或目标不匹配；已保留原件。".into());
    }
    Ok(journal)
}

fn clean_committed(root: &Path) -> Result<(), String> {
    let mut journal = load(root)?;
    if journal.state == "committed" {
        for path in &journal.retained {
            if retained::present(path)? { return Err(format!("安装副本缺少已核验的所有权记录，已保留：{}", path.display())); }
        }
        for index in 0..journal.owned_retained.len() {
            let owned = &journal.owned_retained[index];
            if !retained_sibling(&owned.path, &journal.target) { return Err("安装副本清理范围无效，已保留。".into()); }
            if !retained::present(&owned.path)? { continue; }
            let seal = owned.seal.as_ref().filter(|_| owned.sealed).ok_or_else(|| format!("安装副本尚未封存，已保留：{}", owned.path.display()))?.clone();
            let path = owned.path.clone();
            seal.verify(&path, owned.cleanup_started)?;
            journal.owned_retained[index].cleanup_started = true;
            save(root, &journal)?;
            seal.remove_verified(&path)?;
        }
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.file_name().is_some_and(|name| name == "journal.json") { continue; }
        sidekickai_uninstall_core::path::reject_reparse_points(&path).map_err(|error| error.message)?;
        if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|error| error.to_string())?;
    }
    fs::remove_file(root.join("journal.json")).map_err(|error| error.to_string())?;
    fs::remove_dir(root).map_err(|error| error.to_string())
}

fn retained_sibling(path: &Path, target: &Path) -> bool {
    path.parent() == target.parent() && path.file_name().is_some_and(|name| {
        ["SidekickAI-Backup-", "SidekickAI-Replace-", "SidekickAI-Staged-"]
            .iter().any(|prefix| name.to_string_lossy().starts_with(prefix))
    })
}

fn digest(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None); }
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    let mut hash = Sha256::new();
    if path.is_dir() {
        hash.update(b"directory");
        let mut entries = fs::read_dir(path).map_err(|error| error.to_string())?.map(|entry| entry.map(|entry| entry.path())).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        entries.sort();
        for entry in entries { hash.update(entry.file_name().unwrap().to_string_lossy().as_bytes()); hash.update(digest(&entry)?.ok_or("恢复副本在读取时消失")?.as_bytes()); }
    } else {
        hash.update(b"file");
        let mut file = fs::File::open(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
        let mut buffer = vec![0u8; 256 * 1024];
        loop { let n = file.read(&mut buffer).map_err(|error| error.to_string())?; if n == 0 { break; } hash.update(&buffer[..n]); }
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

#[cfg(test)]
mod digest_tests {
    use super::*;

    #[test]
    fn nested_runtime_digest_uses_bounded_stack() {
        let root = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("installer-nested-digest").unwrap());
        let source = root.join("source");
        let target = root.join("target");
        let mut leaf = source.clone();
        for _ in 0..24 { leaf.push("d"); }
        fs::create_dir_all(&leaf).unwrap();
        fs::write(leaf.join("runtime.bin"), b"runtime-original").unwrap();
        let original = digest(&source).unwrap().unwrap();
        let file_digest = format!("{:x}", Sha256::digest(b"fileruntime-original"));
        let mut expected = format!("{:x}", Sha256::digest(format!("directoryruntime.bin{file_digest}").as_bytes()));
        for _ in 0..24 { expected = format!("{:x}", Sha256::digest(format!("directoryd{expected}").as_bytes())); }
        assert_eq!(original, expected);
        copy_durable(&source, &target).unwrap();
        assert_eq!(digest(&target).unwrap().unwrap(), original);
        let seal = super::super::retained::TreeSeal::capture(&target).unwrap();
        seal.verify(&target, false).unwrap();
        seal.remove_verified(&target).unwrap();
        assert!(!target.exists());
        fs::write(leaf.join("runtime.bin"), b"runtime-modified").unwrap();
        assert_ne!(digest(&source).unwrap().unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }
}

pub(crate) fn authorize_recovery(req: &InstallRequest, hooks: &EngineHooks) -> Result<bool, String> {
    let target = super::scope::normalize_owned_dir(&req.install_dir, "安装目录")?;
    let root = root_for(&target)?;
    if !root.join("journal.json").exists() { return Ok(false); }
    let journal = load(&root)?;
    let allowed = allowed_paths(req, hooks)?;
    let keys: Vec<String> = ["HKCU", "HKLM"].iter().map(|hive| hooks.registration_key(hive)).collect();
    if journal.target != target || journal.for_all_users != req.for_all_users || journal.cleanup_paths != req.cleanup_paths
        || !matches!(journal.state.as_str(), "preparing" | "active" | "recovering" | "recovered" | "committed")
        || journal.paths.iter().enumerate().any(|(slot, saved)| saved.slot != slot || !allowed.contains(&saved.path))
        || journal.registry.iter().any(|change| !keys.contains(&change.key)) || journal.registry_keys.iter().any(|(key, _)| !keys.contains(key)) {
        return Err("安装恢复记录与本次维护范围不匹配，原件已保留。".into());
    }
    Ok(true)
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    #[test]
    fn recovery_record_rejects_unrelated_account_product_and_target() {
        let fixture = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("installer-record-identity").unwrap());
        fs::create_dir(&fixture).unwrap();
        let target = fixture.join("application");
        let root = root_for(&target).unwrap();
        fs::create_dir(&root).unwrap();
        sidekickai_uninstall_host::harden_private_directory(&root).unwrap();
        let journal = Journal { schema: 1, edition: sidekickai_uninstall_core::product::edition_id().into(),
            sid: sidekickai_uninstall_host::current_user_sid().unwrap(), target, state: "preparing".into(),
            for_all_users: true, cleanup_paths: vec![], paths: vec![], registry: vec![], registry_keys: vec![],
            tasks: vec![], retained: vec![], owned_retained: vec![] };
        save(&root, &journal).unwrap();
        load(&root).unwrap();
        let original = serde_json::to_value(&journal).unwrap();
        for (key, value) in [("schema", serde_json::json!(999)), ("sid", serde_json::json!("S-1-5-18")),
            ("edition", serde_json::json!("unrelated")), ("target", serde_json::json!(fixture.join("another")))] {
            let mut changed = original.clone();
            changed[key] = value;
            fs::write(root.join("journal.json"), serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(load(&root).is_err(), "{key}");
        }
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    #[ignore = "requires an explicitly selected existing recovery record; read only"]
    fn existing_system_recovery_is_readable_without_changing_permissions() {
        let target = PathBuf::from(std::env::var_os("SIDEKICK_RECOVERY_READ_ONLY_TARGET").unwrap());
        let root = root_for(&target).unwrap();
        let before = fs::read(root.join("journal.json")).unwrap();
        assert!(!committed(&target).unwrap());
        assert!(pending_installations().unwrap().iter().any(|item| Path::new(&item.install_dir) == target));
        assert_eq!(fs::read(root.join("journal.json")).unwrap(), before);
    }
}

pub(crate) fn copy_durable(source: &Path, target: &Path) -> Result<(), String> {
    sidekickai_uninstall_core::path::reject_reparse_points(source).map_err(|error| error.message)?;
    if source.is_dir() {
        fs::create_dir(target).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? { let entry = entry.map_err(|error| error.to_string())?; copy_durable(&entry.path(), &target.join(entry.file_name()))?; }
    } else {
        let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|error| format!("无法保存恢复副本 {}：{error}", target.display()))?;
    }
    Ok(())
}

fn allowed_paths(req: &InstallRequest, hooks: &EngineHooks) -> Result<Vec<PathBuf>, String> {
    let mut paths = vec![super::scope::normalize_owned_dir(&req.install_dir, "安装目录")?];
    for path in &req.cleanup_paths { let path = super::scope::normalize_owned_dir(path, "清理目录")?; if !paths.contains(&path) && super::scope::portable_user_data(&path).is_none() { paths.push(path); } }
    for scope in [req.for_all_users, !req.for_all_users] {
        if scope != req.for_all_users && hooks.registration_key.is_some() { continue; }
        for directory in super::shortcuts::owned_shortcut_directories(hooks, scope) {
            for name in sidekickai_uninstall_core::product::owned_shortcut_names() { let path = directory.join(name); if !paths.contains(&path) { paths.push(path); } }
        }
    }
    Ok(paths)
}

impl Transaction {
    pub(crate) fn begin(req: &InstallRequest, hooks: &EngineHooks) -> Result<Self, String> {
        let target = super::scope::normalize_owned_dir(&req.install_dir, "安装目录")?;
        let root = root_for(&target)?;
        if root.exists() { return Err(format!("存在未完成安装，请先恢复：{}", root.display())); }
        let paths = allowed_paths(req, hooks)?;
        let mut reservations = Vec::new();
        for path in &paths { reservations.push((root.clone(), super::preflight::tree_size(path)?)); }
        super::preflight::check_space(&reservations)?;
        fs::create_dir(&root).map_err(|error| format!("无法创建安装恢复目录：{error}"))?;
        sidekickai_uninstall_host::harden_private_directory(&root).map_err(|error| error.message)?;
        let mut journal = Journal { schema: 1, edition: sidekickai_uninstall_core::product::edition_id().into(), sid: sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)?, target, state: "preparing".into(), for_all_users: req.for_all_users, cleanup_paths: req.cleanup_paths.clone(), paths: Vec::new(), registry: Vec::new(), registry_keys: Vec::new(), tasks: Vec::new(), retained: Vec::new(), owned_retained: Vec::new() };
        save(&root, &journal)?;
        index_record(&root, &journal, hooks)?;
        for path in paths {
            let slot = journal.paths.len();
            let before = digest(&path)?;
            if before.is_some() {
                let backup = root.join(format!("original-{slot}"));
                copy_durable(&path, &backup)?;
                if digest(&backup)? != before || digest(&path)? != before { return Err("原文件在捕获期间变化，未修改安装；请关闭写入程序后恢复并重试。".into()); }
            }
            journal.paths.push(SavedPath { path, digest: before, slot });
            save(&root, &journal)?;
        }
        #[cfg(test)]
        let native_tasks = hooks.extracted.is_none();
        #[cfg(not(test))]
        let native_tasks = true;
        if native_tasks {
            for path in std::iter::once(&req.install_dir).chain(req.cleanup_paths.iter()) {
                journal.tasks.push(sidekickai_uninstall_host::startup_tasks::snapshot_installation(Path::new(path))?);
            }
        }
        journal.state = "active".into();
        save(&root, &journal)?;
        ACTIVE.with(|active| *active.borrow_mut() = Some(root.clone()));
        Ok(Self { root })
    }

    pub(crate) fn commit(self) -> Result<(), String> {
        let mut journal = load(&self.root)?;
        for key in journal.registry.iter().map(|change| &change.key).collect::<std::collections::HashSet<_>>() {
            if let Some(opened) = super::registry::open_registry_key(key, KEY_READ)? {
                unsafe { windows::Win32::System::Registry::RegFlushKey(windows::Win32::System::Registry::HKEY(opened.raw_handle() as _)) }.ok().map_err(|error| format!("无法持久保存安装登记：{error}"))?;
            }
        }
        journal.state = "committed".into();
        save(&self.root, &journal)?;
        ACTIVE.with(|active| *active.borrow_mut() = None);
        clean_committed(&self.root).map_err(|error| format!("安装已提交，但恢复副本尚未清理：{error}。重新打开后可继续清理。"))
    }
}

pub(crate) fn registry_intent(key: &str, name: &str, after: Option<RegValue>) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        let after = after.map(Value::from_raw);
        if let Some(change) = journal.registry.iter_mut().find(|change| change.key == key && change.name == name) {
            let current = read_value(key, name)?;
            if current != change.before && !change.expected.contains(&current) { return Err(format!("注册表 {key}\\{name} 已被外部修改，未覆盖。")); }
            if !change.expected.contains(&after) { change.expected.push(after.clone()); }
            change.after = after;
        } else { journal.registry.push(RegistryChange { key: key.into(), name: name.into(), before: read_value(key, name)?, expected: vec![after.clone()], after }); }
        save(root, &journal)
    })
}

pub(crate) fn registry_key_intent(key: &str) -> Result<(), String> {
    ACTIVE.with(|active| {
        let active = active.borrow(); let Some(root) = active.as_ref() else { return Ok(()); };
        let mut journal = load(root)?;
        if !journal.registry_keys.iter().any(|(known, _)| known == key) {
            journal.registry_keys.push((key.into(), super::registry::open_registry_key(key, KEY_READ)?.is_some()));
            save(root, &journal)?;
        }
        Ok(())
    })
}

fn read_value(key: &str, name: &str) -> Result<Option<Value>, String> {
    let Some(opened) = super::registry::open_registry_key(key, KEY_READ)? else { return Ok(None); };
    match opened.get_raw_value(name) { Ok(value) => Ok(Some(Value::from_raw(value))), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(error) => Err(error.to_string()) }
}

pub(crate) fn recover(req: &InstallRequest, hooks: &EngineHooks) -> Result<bool, String> {
    ACTIVE.with(|active| *active.borrow_mut() = None);
    let target = super::scope::normalize_owned_dir(&req.install_dir, "安装目录")?;
    let root = root_for(&target)?;
    if !root.exists() { return Ok(false); }
    if !root.join("journal.json").exists() {
        crate::controller::verify_recovery_directory(&root)?;
        if fs::read_dir(&root).map_err(|error| error.to_string())?.next().is_none() { fs::remove_dir(&root).map_err(|error| error.to_string())?; return Ok(true); }
    }
    let mut journal = load(&root)?;
    if journal.schema != 1 || journal.target != target || journal.edition != sidekickai_uninstall_core::product::edition_id()
        || journal.sid != sidekickai_uninstall_host::current_user_sid().map_err(|error| error.message)? { return Err("安装恢复记录身份不匹配，已保留原件。".into()); }
    let allowed = allowed_paths(req, hooks)?;
    if journal.paths.iter().enumerate().any(|(slot, saved)| saved.slot != slot || !allowed.contains(&saved.path)) { return Err("恢复包含本次未确认的目录，请使用原安装选项恢复。".into()); }
    let keys: Vec<String> = ["HKCU", "HKLM"].iter().map(|hive| hooks.registration_key(hive)).collect();
    if journal.registry.iter().any(|change| !keys.contains(&change.key)) || journal.registry_keys.iter().any(|(key, _)| !keys.contains(key)) { return Err("安装恢复记录包含无关注册项。".into()); }
    if journal.state == "preparing" || journal.state == "committed" {
        clean_committed(&root)?; return Ok(true);
    }
    if journal.state == "recovered" {
        let retained = root.with_file_name(format!("{}-{}", root.file_name().unwrap().to_string_lossy(), sidekickai_uninstall_core::random_id("recovered").map_err(|error| error.message)?));
        fs::rename(&root, retained).map_err(|error| error.to_string())?;
        return Ok(true);
    }
    if journal.state != "active" && journal.state != "recovering" { return Err("安装恢复状态无效。".into()); }
    journal.state = "recovering".into(); save(&root, &journal)?;
    for index in 0..journal.paths.len() {
        let saved = &journal.paths[index];
        let current = digest(&saved.path)?;
        if current == saved.digest { continue; }
        let backup = root.join(format!("original-{}", saved.slot));
        if saved.digest.is_some() && digest(&backup)? != saved.digest { return Err(format!("恢复副本不完整，已保留现有文件：{}", saved.path.display())); }
        let path = saved.path.clone();
        let restore = saved.digest.is_some();
        let parent = path.parent().ok_or("恢复路径无效")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let quarantine = parent.join(sidekickai_uninstall_core::random_id(".sidekick-recovery-conflict").map_err(|error| error.message)?);
        let staged = parent.join(sidekickai_uninstall_core::random_id(".sidekick-recovery-restore").map_err(|error| error.message)?);
        journal.retained.push(quarantine.clone()); journal.retained.push(staged.clone()); save(&root, &journal)?;
        if restore {
            super::preflight::check_space(&[(path.clone(), super::preflight::tree_size(&backup)?)])?;
            copy_durable(&backup, &staged)?;
        }
        if current.is_some() { fs::rename(&path, &quarantine).map_err(|error| format!("无法保留冲突文件 {}：{error}", path.display()))?; }
        if restore { fs::rename(&staged, &path).map_err(|error| format!("无法恢复原文件 {}：{error}", path.display()))?; }
    }
    let mut errors = Vec::new();
    for change in &journal.registry {
        let current = read_value(&change.key, &change.name)?;
        if current == change.before { continue; }
        if !change.expected.contains(&current) { errors.push(format!("注册表 {}\\{} 已被外部修改", change.key, change.name)); continue; }
        let result = match &change.before {
            Some(before) => super::registry::create_registry_key(&change.key)?.set_raw_value(&change.name, &before.raw()?).map_err(|error| error.to_string()),
            None => super::registry::delete_registry_value(&change.key, &change.name),
        };
        if let Err(error) = result { errors.push(error); }
    }
    for (key, existed) in &journal.registry_keys {
        match super::registry::open_registry_key(key, KEY_READ)? {
            None if *existed => { super::registry::create_registry_key(key)?; }
            Some(opened) if !existed && opened.enum_values().next().is_none() && opened.enum_keys().next().is_none() => { drop(opened); super::registry::delete_registry_key(key)?; }
            _ => {}
        }
    }
    for snapshot in &journal.tasks { if let Err(error) = sidekickai_uninstall_host::startup_tasks::restore_snapshot(snapshot) { errors.push(error); } }
    if !errors.is_empty() { return Err(format!("原文件已恢复，部分入口存在冲突，未覆盖外部改动；恢复记录保留在 {}：{}", root.display(), errors.join("；"))); }
    for index in 0..journal.owned_retained.len() {
        let owned = &journal.owned_retained[index];
        let path = owned.path.clone();
        if retained_sibling(&path, &target) && path.exists() {
            let ownership = owned.seal.as_ref().filter(|_| owned.sealed).ok_or_else(|| format!("安装副本尚未封存，已保留：{}", path.display()))
                .and_then(|seal| seal.verify(&path, owned.cleanup_started));
            if let Err(error) = ownership { super::status(&error); continue; }
            let retained = root.join(format!("retained-{index}"));
            if retained.exists() { return Err("恢复保留目录已被占用。".into()); }
            fs::rename(&path, &retained).map_err(|error| error.to_string())?;
            journal.owned_retained[index].path = PathBuf::from(format!("retained-{index}")); save(&root, &journal)?;
        }
    }
    journal.state = "recovered".into(); save(&root, &journal)?;
    let retained = root.with_file_name(format!("{}-{}", root.file_name().unwrap().to_string_lossy(), sidekickai_uninstall_core::random_id("recovered").map_err(|error| error.message)?));
    fs::rename(&root, &retained).map_err(|error| error.to_string())?;
    super::status(&format!("已恢复原安装；中断时文件与恢复记录保留在 {}", retained.display()));
    Ok(true)
}
