#[cfg(test)]
#[path = "../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
use sidekickai_uninstall_core::path::{normalize_target_path, paths_equal, validate_tree};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::{random_id, register_scan};
use sidekickai_uninstall_core::product;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[path = "roaming_owner.rs"]
mod roaming_owner;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub path: PathBuf,
    pub registered_root: Option<String>,
    pub version: Option<String>,
    pub scope: InstallScope,
    pub source: UninstallEntry,
}

pub fn discover(source: Option<&Path>) -> Result<UninstallScanResponse, UninstallError> {
    discover_candidates(collect_candidates(source)?, source)
}

/// Candidate roots from the real machine: registry, the launcher's own
/// directory, and the standard install locations.
pub fn collect_candidates(source: Option<&Path>) -> Result<Vec<Candidate>, UninstallError> {
    let mut candidates = registered_candidates()?;
    if let Some(source) = source {
        candidates.push(Candidate { path: source.to_owned(), registered_root: None, version: None, scope: InstallScope::Unknown, source: UninstallEntry::Installed });
    }
    let mut bases = Vec::new();
    if let Some(root) = std::env::var_os("LOCALAPPDATA") { bases.push((PathBuf::from(root).join("Programs"), InstallScope::PerUser)); }
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(name) { bases.push((PathBuf::from(root), InstallScope::AllUsers)); }
    }
    candidates.extend(standard_candidates(&bases));
    Ok(candidates)
}

fn standard_candidates(bases: &[(PathBuf, InstallScope)]) -> Vec<Candidate> {
    let mut names = product::product().editions.values().flat_map(|edition| edition.install_directories()).collect::<Vec<_>>();
    names.sort();
    names.dedup();
    bases.iter().flat_map(|(base, scope)| names.iter().map(move |name| Candidate {
        path: base.join(name), registered_root: None, version: None, scope: scope.clone(), source: UninstallEntry::Installed,
    })).collect()
}

/// Identity-verify an explicit candidate list. Split from machine discovery so
/// the authorization rules can be exercised against isolated fixtures.
pub fn discover_candidates(candidates: Vec<Candidate>, source: Option<&Path>) -> Result<UninstallScanResponse, UninstallError> {
    let locations = inspect_candidates(candidates, source)?;
    let recommended = locations.iter().find(|l| l.recommended && l.removable)
        .map(|l| l.id.clone());
    let data_roots = discover_data_roots(&locations)?;
    register_scan(random_id("scan")?, sidekickai_uninstall_core::unix_timestamp().to_string(), locations, data_roots, recommended)
}

/// Inspect installation metadata without registering an uninstall authorization.
pub fn inspect_candidates(candidates: Vec<Candidate>, source: Option<&Path>) -> Result<Vec<UninstallLocation>, UninstallError> {
    let mut locations: Vec<UninstallLocation> = Vec::new();
    for candidate in candidates {
        if let Some(location) = inspect(&candidate, source)? {
            if let Some(previous) = locations.iter_mut().find(|p| paths_equal(Path::new(&p.path), Path::new(&location.path))) {
                if previous.scope == InstallScope::Unknown && location.scope != InstallScope::Unknown {
                    previous.scope = location.scope.clone();
                    previous.removable = location.removable;
                    previous.non_removable_reason = location.non_removable_reason.clone();
                }
                previous.registered |= location.registered;
                for root in location.registered_roots { if !previous.registered_roots.contains(&root) { previous.registered_roots.push(root); } }
                for source in location.source { if !previous.source.contains(&source) { previous.source.push(source); } }
                previous.recommended |= location.recommended;
                continue;
            }
            locations.push(location);
        }
    }
    Ok(locations)
}

fn inspect(candidate: &Candidate, source: Option<&Path>) -> Result<Option<UninstallLocation>, UninstallError> {
    if !candidate.path.exists() { return Ok(None); }
    let path = match normalize_target_path(&candidate.path) { Ok(p) => p, Err(_) => return Ok(None) };
    if protected(path.as_path()) { return Ok(None); }
    let Some((edition_id, _)) = product::installation_edition(path.as_path()) else {
        if source.is_some_and(|source| paths_equal(source, path.as_path()))
            && path.as_path().join("uninstall.exe").is_file()
            && sidekickai_uninstall_core::product::package_name(&path.as_path().join("resources/app.asar")).is_err() {
            return Err(UninstallError::new(UninstallErrorCode::TargetNotInstall,
                "无法确认此安装的应用身份。请使用同一版本路线的安装器先修复，再卸载；现有程序和数据未修改。",
                UninstallPhase::Scanning, false, ""));
        }
        return Ok(None);
    };
    let main = sidekickai_uninstall_core::product::application_executable(path.as_path());
    let resources = path.as_path().join("resources").join("app.asar");
    let uninstaller = path.as_path().join("uninstall.exe");
    if !uninstaller.is_file() || !resources.is_file() && sidekickai_uninstall_core::distribution::verify_installed_identity(path.as_path()).is_err() { return Ok(None); }
    let executable_arch = pe_arch(&main).ok();
    let uninstaller_arch = pe_arch(&uninstaller).ok();
    let registered = candidate.registered_root.is_some();
    let strong = executable_arch.is_some() && uninstaller_arch.is_some();
    let degraded = !strong && registered;
    if !strong && !degraded { return Ok(None); }
    let receipt = product::read_install_receipt(path.as_path()).ok().map(|(receipt, _)| receipt)
        .filter(|receipt| receipt.edition == edition_id);
    let scope = if path.as_path().join("portable.txt").is_file() { InstallScope::Portable }
        else if candidate.scope == InstallScope::Unknown {
            receipt.as_ref().map(|receipt| if receipt.registry_root == "HKLM" { InstallScope::AllUsers } else { InstallScope::PerUser }).unwrap_or(InstallScope::Unknown)
        } else { candidate.scope.clone() };
    let mut non_removable_reason = validate_tree(path.as_path()).err().map(|e| e.code);
    if product::validate_uninstall_identity(path.as_path()).is_err() {
        non_removable_reason = Some(UninstallErrorCode::TargetNotInstall);
    }
    if sidekickai_uninstall_core::distribution::verify_installed_identity(path.as_path()).is_err() {
        non_removable_reason = Some(UninstallErrorCode::TargetNotInstall);
    }
    if let (Some(app_arch), Some(uninstall_arch)) = (&executable_arch, &uninstaller_arch) {
        if app_arch != uninstall_arch { non_removable_reason = Some(UninstallErrorCode::ArchMismatch); }
    }
    if scope == InstallScope::Unknown { non_removable_reason = Some(UninstallErrorCode::TargetScopeInvalid); }
    let recommended = source.is_some_and(|source| paths_equal(source, path.as_path()));
    Ok(Some(UninstallLocation {
        edition: edition_id.into(),
        id: UninstallTargetId { token: random_id("candidate")? },
        path: path.as_string(), display_path: path.as_string(), source: vec![candidate.source.clone()],
        scope, arch: executable_arch.or(uninstaller_arch).unwrap_or(UninstallArch::Unknown),
        version: product::package_identity(&resources).ok().and_then(|identity| identity.version).or_else(|| candidate.version.clone()), registered,
        registered_roots: candidate.registered_root.clone().into_iter().collect(),
        executable_present: main.is_file(), resources_present: resources.is_file(),
        identity_confidence: if strong { IdentityConfidence::Strong } else { IdentityConfidence::Degraded },
        running_pids: Vec::new(), removable: non_removable_reason.is_none(), non_removable_reason, recommended,
    }))
}

fn protected(path: &Path) -> bool {
    ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "SystemRoot", "ProgramData"]
        .iter().filter_map(std::env::var_os).any(|p| paths_equal(path, Path::new(&p)))
}

pub fn pe_arch(path: &Path) -> Result<UninstallArch, std::io::Error> {
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid executable header");
    let mut file = File::open(path)?;
    let mut dos = [0u8; 64]; file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" { return Err(invalid()); }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if offset < 64 || offset + 24 > file.metadata()?.len() { return Err(invalid()); }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0u8; 24]; file.read_exact(&mut pe)?;
    if &pe[..4] != b"PE\0\0" { return Err(invalid()); }
    match u16::from_le_bytes([pe[4], pe[5]]) {
        0x8664 => Ok(UninstallArch::X64), 0xaa64 => Ok(UninstallArch::Arm64), _ => Err(invalid()),
    }
}

/// Read-only data-root candidates shared by discovery and installation locking.
pub fn data_paths_for(install: &Path, roaming: Option<&Path>) -> Result<Vec<PathBuf>, UninstallError> {
    let mut paths = local_data_state_paths(install)?.into_iter().filter(|path| path.is_dir()).collect::<Vec<_>>();
    if !install.join("portable.txt").is_file() {
        let edition = product::installation_edition(install).map(|(_, edition)| edition).unwrap_or_else(product::edition);
        paths.extend(roaming_data_paths(roaming, edition)?);
    }
    Ok(paths)
}

pub(crate) fn local_data_state_paths(install: &Path) -> Result<Vec<PathBuf>, UninstallError> {
    let entries = match std::fs::read_dir(install) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(data_scan_error(error)),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(data_scan_error)?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == "data" || name.starts_with("data.") { paths.push(entry.path()); }
    }
    paths.sort();
    Ok(paths)
}

pub(crate) fn validate_local_data_selection(install: &Path, strategy: &DataStrategy, confirmed: &[PathBuf]) -> Result<(), UninstallError> {
    use sha2::{Digest, Sha256};
    let normalized = sidekickai_uninstall_core::path::normalize_absolute_path(install)?.as_string().to_lowercase();
    let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    if install.parent().is_some_and(|parent| parent.join(format!(".sidekick-install-recovery-{}", &hash[..24])).exists()) {
        return Err(UninstallError::new(UninstallErrorCode::TargetScopeInvalid,
            "该位置有尚未结束的安装恢复任务，请先打开安装器完成恢复。", UninstallPhase::Validating, true, ""));
    }
    for path in local_data_state_paths(install)? {
        if *strategy == DataStrategy::Keep { continue; }
        if !path.is_dir() || !confirmed.iter().any(|root| paths_equal(root, &path)) {
            return Err(UninstallError::new(UninstallErrorCode::TargetScopeInvalid,
                format!("安装目录内仍有需要保留的数据或恢复记录：{}。请先备份并移出这些资料，或明确确认对应数据目录的处理方式，再卸载。程序和数据未删除。", path.display()),
                UninstallPhase::Validating, false, ""));
        }
    }
    Ok(())
}

fn data_probe(path: &Path) -> bool {
    path.join("settings.db").is_file()
        && ["chat.db", "whiteboard.db", "notes.db", "injection-history.json"].iter().any(|name| path.join(name).is_file())
}

fn recovery_data_paths(root: &Path) -> Result<Vec<PathBuf>, UninstallError> {
    let mut paths = Vec::new();
    let Some(parent) = root.parent() else { return Ok(paths); };
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(data_scan_error(error)),
    };
    let prefix = format!("{}.", root.file_name().unwrap_or_default().to_string_lossy());
    for entry in entries {
        let entry = entry.map_err(data_scan_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(suffix) = name.strip_prefix(&prefix) else { continue; };
        let Some((kind, token)) = suffix.split_once('-') else { continue; };
        if !["bak", "restore", "failed", "reset"].contains(&kind) { continue; }
        let uuid = token.len() == 36 && token.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        });
        let timestamp = kind == "bak" && token.len() == 13 && token.bytes().all(|byte| byte.is_ascii_digit());
        if (uuid || timestamp) && entry.path().is_dir() { paths.push(entry.path()); }
    }
    Ok(paths)
}

fn data_scan_error(error: std::io::Error) -> UninstallError {
    UninstallError::new(UninstallErrorCode::TargetScopeInvalid, format!("无法完整检查恢复数据：{error}"), UninstallPhase::Scanning, false, "")
}

fn roaming_data_paths(roaming: Option<&Path>, edition: &product::Edition) -> Result<Vec<PathBuf>, UninstallError> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(roaming) = roaming {
        for name in &edition.data_directories {
            let path = roaming.join(name);
            let recognized = data_probe(&path);
            if recognized && !paths.iter().any(|previous| paths_equal(previous, &path)) { paths.push(path.clone()); }
            for recovery in recovery_data_paths(&path)? {
                if (recognized || data_probe(&recovery)) && !paths.iter().any(|previous| paths_equal(previous, &recovery)) { paths.push(recovery); }
            }
        }
    }
    Ok(paths)
}

fn discover_data_roots(locations: &[UninstallLocation]) -> Result<Vec<DataRoot>, UninstallError> {
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    discover_data_roots_with(locations, roaming.as_deref(), roaming_owner::verified(roaming.as_deref()))
}

fn discover_data_roots_with(locations: &[UninstallLocation], roaming: Option<&Path>, caller_owned: bool) -> Result<Vec<DataRoot>, UninstallError> {
    let mut roots = Vec::new();
    for (id, edition) in &product::product().editions {
        let installed = locations.iter().filter(|location| location.edition == *id && location.scope != InstallScope::Portable).map(|location| location.id.clone()).collect::<Vec<_>>();
        for path in roaming_data_paths(roaming, edition)? {
            if !installed.is_empty() {
                roots.push(DataRoot {
                    path: path.to_string_lossy().into_owned(),
                    source: if caller_owned { "caller-roaming-probe".into() } else { "caller-roaming-unverified".into() },
                    removable: caller_owned,
                    associated_target_ids: installed.clone(),
                });
            }
        }
    }
    for location in locations {
        for path in data_paths_for(Path::new(&location.path), None)? {
            roots.push(DataRoot { path: path.to_string_lossy().into_owned(), source: "installation-local-data".into(), removable: location.removable && validate_tree(&path).is_ok(), associated_target_ids: vec![location.id.clone()] });
        }
    }
    Ok(roots)
}

#[cfg(windows)]
fn registered_candidates() -> Result<Vec<Candidate>, UninstallError> {
    use winreg::{RegKey, enums::*};
    let mut candidates = Vec::new();
    for (handle, name, scope) in [(HKEY_CURRENT_USER, "HKCU", InstallScope::PerUser), (HKEY_LOCAL_MACHINE, "HKLM", InstallScope::AllUsers)] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let parent = match RegKey::predef(handle).open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ | view) {
                Ok(key) => key,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(UninstallError::new(UninstallErrorCode::RegistryFailed, format!("无法检查 {name} 卸载注册：{error}"), UninstallPhase::Scanning, true, "")),
            };
            candidates.extend(registered_candidates_from(&parent, name, scope.clone(), view)?);
        }
    }
    Ok(candidates)
}

#[cfg(windows)]
fn registered_candidates_from(parent: &winreg::RegKey, name: &str, scope: InstallScope, view: u32) -> Result<Vec<Candidate>, UninstallError> {
    use winreg::enums::KEY_READ;
    let mut candidates = Vec::new();
    for child in parent.enum_keys() {
        let child = child.map_err(|error| UninstallError::new(UninstallErrorCode::RegistryFailed, format!("无法列出 {name} 卸载注册：{error}"), UninstallPhase::Scanning, true, ""))?;
        let key = match parent.open_subkey_with_flags(child, KEY_READ | view) { Ok(key) => key, Err(_) => continue };
        let location: String = match key.get_value("InstallLocation") { Ok(value) => value, Err(_) => continue };
        let command: String = key.get_value("UninstallString").unwrap_or_default();
        let expected = Path::new(&location).join("uninstall.exe");
        if !uninstall_command_matches(&command, &expected) { continue; }
        candidates.push(Candidate { path: location.into(), registered_root: Some(name.into()), version: key.get_value("DisplayVersion").ok(), scope: scope.clone(), source: UninstallEntry::Registry });
    }
    Ok(candidates)
}

pub(crate) fn uninstall_command_matches(command: &str, path: &Path) -> bool {
    let quoted = format!("\"{}\"", path.display());
    command.eq_ignore_ascii_case(&quoted) || command.eq_ignore_ascii_case(&format!("{quoted} --uninstall"))
}

#[cfg(not(windows))]
fn registered_candidates() -> Result<Vec<Candidate>, UninstallError> { Ok(Vec::new()) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn defaults_keep_legacy_locations_as_discovery_aliases() {
        let concept = &product::product().editions["concept"];
        assert_eq!(concept.directory, "SidekickAI-Concept");
        assert_eq!(product::product().editions["community"].directory, "SidekickAI");
        let base = PathBuf::from(r"C:\Program Files");
        let candidates = standard_candidates(&[(base.clone(), InstallScope::AllUsers)]);
        for name in ["SidekickAI", "SidekickAI-Concept", "SidekickAI-OpenSource"] {
            assert!(candidates.iter().any(|candidate| candidate.path == base.join(name)));
        }
    }

    #[test]
    fn versions_and_legacy_executables_are_read_from_each_installation() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("all-versions");
        let mut candidates = Vec::new();
        for (name, id, version, legacy) in [
            ("SidekickAI-OpenSource", "concept", "0.1.0-alpha.3", true),
            ("Custom Concept", "concept", "0.1.0-beta.4", false),
            ("Custom Community", "community", "0.1.0-beta.5", false),
        ] {
            let install = root.join(name);
            make_install(&install, true, true, true, false);
            let edition = &product::product().editions[id];
            fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(&edition.package_name, Some(version), b"fixture")).unwrap();
            if legacy { fs::rename(install.join("SidekickAI.exe"), install.join(&edition.legacy_executable)).unwrap(); }
            edition_fixtures::seal_installation(&install);
            let mut value = candidate(&install, InstallScope::PerUser, Some("HKCU"));
            value.version = Some("stale-registration".into());
            candidates.push(value);
        }
        let source = root.join("Custom Community");
        candidates.push(candidate(&source, InstallScope::Unknown, None));
        let scan = discover_candidates(candidates, Some(&source)).unwrap();
        assert_eq!(scan.locations.len(), 3);
        for (index, version) in ["0.1.0-alpha.3", "0.1.0-beta.4", "0.1.0-beta.5"].iter().enumerate() {
            assert_eq!(scan.locations[index].version.as_deref(), Some(*version));
            assert!(scan.locations[index].removable);
        }
        assert_eq!(scan.locations[0].edition, "concept");
        assert_eq!(scan.locations[2].edition, "community");
        assert_eq!(scan.recommended_target_id.as_ref(), Some(&scan.locations[2].id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn data_roots_follow_installation_edition_and_preserve_shared_ownership() {
        let root = fixture_root("edition-data");
        let roaming = root.join("roaming");
        let mut locations = Vec::new();
        for (index, id) in ["concept", "concept", "community"].iter().enumerate() {
            let install = root.join(format!("install-{index}"));
            let edition = &product::product().editions[*id];
            make_install(&install, true, true, true, false);
            fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for(&edition.package_name, b"fixture")).unwrap();
            locations.push(inspect(&candidate(&install, InstallScope::PerUser, None), None).unwrap().unwrap());
            let data = roaming.join(&edition.data_directories[0]);
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("settings.db"), b"settings").unwrap();
            fs::write(data.join("chat.db"), b"chat").unwrap();
        }
        locations[1].removable = false;
        locations[1].non_removable_reason = Some(UninstallErrorCode::ArchMismatch);
        let roots = discover_data_roots_with(&locations, Some(&roaming), true).unwrap();
        assert_eq!(roots.len(), 2);
        let concept = roots.iter().find(|root| root.path.ends_with("sidekickai-opensource")).unwrap();
        assert_eq!(concept.associated_target_ids, vec![locations[0].id.clone(), locations[1].id.clone()]);
        let community = roots.iter().find(|root| root.path.ends_with("sidekick-ai")).unwrap();
        assert_eq!(community.associated_target_ids, vec![locations[2].id.clone()]);
        let foreign_data = data_paths_for(Path::new(&locations[2].path), Some(&roaming)).unwrap();
        assert_eq!(foreign_data, vec![PathBuf::from(&community.path)]);
        assert!(discover_data_roots_with(&locations, Some(&roaming), false).unwrap().iter().all(|root| !root.removable));
        let same_account = roaming_owner::verified_fixture(true, "owner", "owner", &roaming);
        assert!(discover_data_roots_with(&locations, Some(&roaming), same_account).unwrap().iter().all(|root| root.removable));
        let other_account = roaming_owner::verified_fixture(true, "admin", "owner", &roaming);
        assert!(discover_data_roots_with(&locations, Some(&roaming), other_account).unwrap().iter().all(|root| !root.removable));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn registry_discovery_reads_both_editions_and_custom_version_entries() {
        use winreg::{RegKey, enums::*};
        let root = fixture_root("registry-discovery");
        let key_path = format!(r"Software\SidekickAI-DiscoveryTest-{}", random_id("registry").unwrap());
        struct Guard(String);
        impl Drop for Guard { fn drop(&mut self) { let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0); } }
        let _guard = Guard(key_path.clone());
        let parent = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&key_path).unwrap().0;
        for (key_name, id) in [("Concept-Beta4", "concept"), ("Community-Beta5", "community"), ("Another-Application", "other")] {
            let install = root.join(key_name);
            make_install(&install, true, true, true, false);
            let package = product::product().editions.get(id).map(|edition| edition.package_name.as_str()).unwrap_or("unrelated-app");
            fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for(package, b"fixture")).unwrap();
            let key = parent.create_subkey(key_name).unwrap().0;
            key.set_value("InstallLocation", &install.to_string_lossy().as_ref()).unwrap();
            key.set_value("UninstallString", &format!("\"{}\" --uninstall", install.join("uninstall.exe").display())).unwrap();
        }
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let candidates = registered_candidates_from(&parent, "HKCU", InstallScope::PerUser, view).unwrap();
            let locations = candidates.iter().filter_map(|candidate| inspect(candidate, None).unwrap()).collect::<Vec<_>>();
            assert_eq!(locations.len(), 2);
            assert!(locations.iter().any(|location| location.edition == "concept"));
            assert!(locations.iter().any(|location| location.edition == "community"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_includes_both_editions_with_identical_executable_names() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("edition-boundary");
        let own = root.join("own");
        let foreign = root.join("foreign");
        make_install(&own, true, true, true, false);
        make_install(&foreign, true, true, true, false);
        let foreign_name = if sidekickai_uninstall_core::product::edition_id() == "concept" { "sidekick-ai" } else { "sidekickai-opensource" };
        fs::write(foreign.join("resources/app.asar"), edition_fixtures::archive_for(foreign_name, b"foreign")).unwrap();
        let scan = discover_candidates(vec![candidate(&own, InstallScope::PerUser, None), candidate(&foreign, InstallScope::PerUser, Some("HKCU"))], Some(&own)).unwrap();
        assert_eq!(scan.locations.len(), 2);
        assert_eq!(Path::new(&scan.locations[0].path), own);
        assert!(foreign.join("resources/app.asar").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_archive_from_the_launch_directory_requires_repair_before_uninstall() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("damaged-archive");
        make_install(&root, true, true, true, true);
        fs::write(root.join("resources/app.asar"), b"corrupt archive").unwrap();
        let error = discover_candidates(vec![candidate(&root, InstallScope::PerUser, Some("HKCU"))], Some(&root)).unwrap_err();
        assert_eq!(error.code, UninstallErrorCode::TargetNotInstall);
        assert!(error.message.contains("修复"));
        assert_eq!(fs::read(root.join("resources/app.asar")).unwrap(), b"corrupt archive");
        assert_eq!(fs::read(root.join("data/settings.db")).unwrap(), b"portable data");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn signed_installation_can_be_maintained_when_the_application_archive_is_damaged() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("signed-damaged-archive");
        make_install(&root, true, true, true, false);
        fs::write(root.join("resources/app.asar"), b"damaged new application").unwrap();
        let candidate = candidate(&root, InstallScope::PerUser, Some("HKCU"));
        let scan = discover_candidates(vec![candidate.clone()], Some(&root)).unwrap();
        assert!(scan.locations[0].removable);
        fs::remove_file(root.join("resources/app.asar")).unwrap();
        let scan = discover_candidates(vec![candidate], Some(&root)).unwrap();
        assert!(scan.locations[0].removable);
        assert!(!scan.locations[0].resources_present);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_application_is_visible_without_new_maintenance_authorization() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("legacy-visible");
        make_install(&root, true, true, true, false);
        fs::remove_file(root.join("distribution-proof.json")).unwrap();
        let scan = discover_candidates(vec![candidate(&root, InstallScope::PerUser, Some("HKCU"))], Some(&root)).unwrap();
        assert_eq!(scan.locations.len(), 1);
        assert!(!scan.locations[0].removable);
        assert!(scan.recommended_target_id.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_installations_are_visible_but_never_removable() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("nested-installations");
        let outer = root.join("outer");
        let inner = outer.join("inner");
        make_install(&outer, true, true, true, false);
        make_install(&inner, true, true, true, false);
        let scan = discover_candidates(vec![candidate(&outer, InstallScope::PerUser, None), candidate(&inner, InstallScope::PerUser, None)], Some(&outer)).unwrap();
        assert_eq!(scan.locations.len(), 2);
        assert!(scan.locations.iter().all(|location| !location.removable));
        assert!(scan.recommended_target_id.is_none());
        assert!(inner.join("SidekickAI.exe").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_data_survives_a_missing_portable_marker_and_requires_exact_confirmation() {
        let root = fixture_root("local-data-selection");
        assert!(validate_local_data_selection(&root, &DataStrategy::Keep, &[]).is_ok());
        let data = root.join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("settings.db"), b"retained").unwrap();
        assert_eq!(data_paths_for(&root, None).unwrap(), vec![data.clone()]);
        assert!(validate_local_data_selection(&root, &DataStrategy::Keep, &[]).is_ok());
        assert!(validate_local_data_selection(&root, &DataStrategy::Delete, &[root.clone()]).is_err());
        assert!(validate_local_data_selection(&root, &DataStrategy::Delete, &[data.clone()]).is_ok());
        let pending = root.join("data.restore.json");
        std::fs::write(&pending, b"recovery evidence").unwrap();
        assert!(validate_local_data_selection(&root, &DataStrategy::Delete, &[data, pending.clone()]).is_err());
        assert_eq!(std::fs::read(&pending).unwrap(), b"recovery evidence");
        fs::remove_dir_all(root).unwrap();
    }

    fn make_install(dir: &Path, main_exe: bool, resources: bool, uninstaller: bool, portable: bool) {
        fs::create_dir_all(dir).unwrap();
        if resources {
            fs::create_dir_all(dir.join("resources")).unwrap();
            fs::write(dir.join("resources").join("app.asar"), app_archive(b"fixture asar")).unwrap();
        }
        if main_exe {
            // Structurally valid PE32+ x64 so architecture parsing is exercised.
            let mut exe = vec![0u8; 0x400];
            exe[0] = b'M'; exe[1] = b'Z';
            exe[0x3c..0x40].copy_from_slice(&(0x80u32).to_le_bytes());
            exe[0x80..0x84].copy_from_slice(b"PE\0\0");
            exe[0x84..0x86].copy_from_slice(&(0x8664u16).to_le_bytes());
            exe[0x86..0x88].copy_from_slice(&(1u16).to_le_bytes());
            exe[0x94..0x96].copy_from_slice(&(0xF0u16).to_le_bytes());
            exe[0x98..0x9a].copy_from_slice(&(0x20bu16).to_le_bytes());
            let section = 0x80 + 24 + 0xF0;
            exe[section + 16..section + 20].copy_from_slice(&(0x100u32).to_le_bytes());
            exe[section + 20..section + 24].copy_from_slice(&(0x200u32).to_le_bytes());
            fs::write(dir.join("SidekickAI.exe"), exe).unwrap();
        }
        if uninstaller {
            let mut exe = vec![0u8; 0x400];
            exe[0] = b'M'; exe[1] = b'Z';
            exe[0x3c..0x40].copy_from_slice(&(0x80u32).to_le_bytes());
            exe[0x80..0x84].copy_from_slice(b"PE\0\0");
            exe[0x84..0x86].copy_from_slice(&(0x8664u16).to_le_bytes());
            exe[0x86..0x88].copy_from_slice(&(1u16).to_le_bytes());
            exe[0x94..0x96].copy_from_slice(&(0xF0u16).to_le_bytes());
            exe[0x98..0x9a].copy_from_slice(&(0x20bu16).to_le_bytes());
            let section = 0x80 + 24 + 0xF0;
            exe[section + 16..section + 20].copy_from_slice(&(0x100u32).to_le_bytes());
            exe[section + 20..section + 24].copy_from_slice(&(0x200u32).to_le_bytes());
            fs::write(dir.join("uninstall.exe"), exe).unwrap();
        }
        if portable {
            fs::write(dir.join("portable.txt"), b"portable").unwrap();
            fs::create_dir_all(dir.join("data")).unwrap();
            fs::write(dir.join("data").join("settings.db"), b"portable data").unwrap();
        }
        edition_fixtures::seal_installation(dir);
    }

    fn candidate(path: &Path, scope: InstallScope, registered_root: Option<&str>) -> Candidate {
        Candidate {
            path: path.to_path_buf(),
            registered_root: registered_root.map(str::to_string),
            version: Some("0.1.0-alpha".into()),
            scope,
            source: if registered_root.is_some() { UninstallEntry::Registry } else { UninstallEntry::Installed },
        }
    }

    fn fixture_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(random_id(&format!("sidekick-scan-{name}")).unwrap());
        fs::create_dir_all(&root).unwrap();
        assert!(root.is_absolute());
        root
    }

    #[test]
    fn scan_ignores_directories_without_a_verifiable_identity() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("no-identity");
        let bare = root.join("just-a-folder");
        let no_uninstaller = root.join("no-uninstaller");
        let no_resources = root.join("no-resources");
        fs::create_dir_all(&bare).unwrap();
        make_install(&no_uninstaller, true, true, false, false);
        make_install(&no_resources, true, false, true, false);

        let scan = discover_candidates(
            vec![
                candidate(&bare, InstallScope::PerUser, None),
                candidate(&no_uninstaller, InstallScope::PerUser, None),
                candidate(&no_resources, InstallScope::PerUser, None),
                // A filesystem root can never become a target.
                candidate(Path::new(r"C:\"), InstallScope::Unknown, None),
            ],
            None,
        )
        .unwrap();

        assert!(scan.locations.is_empty(), "unexpected locations: {:?}", scan.locations.iter().map(|l| &l.path).collect::<Vec<_>>());
        assert!(scan.recommended_target_id.is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_recommends_the_launcher_directory_and_lists_other_installations() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("multi");
        let first = root.join(sidekickai_uninstall_core::product::edition().directory.as_str());
        let second = root.join("Sidekick AI Second Install");
        make_install(&first, true, true, true, false);
        make_install(&second, true, true, true, false);

        let scan = discover_candidates(
            vec![
                candidate(&first, InstallScope::AllUsers, None),
                candidate(&second, InstallScope::PerUser, None),
            ],
            Some(&second),
        )
        .unwrap();

        assert_eq!(scan.locations.len(), 2);
        let recommended = scan.recommended_target_id.as_ref().expect("a launcher directory must be recommended");
        let recommended_location = scan.locations.iter().find(|l| &l.id == recommended).unwrap();
        assert_eq!(Path::new(&recommended_location.path), second, "the launcher's own directory is recommended");
        assert!(recommended_location.recommended);
        // The path containing spaces survives normalization unchanged.
        assert!(recommended_location.path.contains("Sidekick AI Second Install"));
        let other = scan.locations.iter().find(|l| &l.id != recommended).unwrap();
        assert!(!other.recommended, "the other installation is not recommended by default");
        assert!(other.removable, "both installations remain individually removable");
        assert_eq!(Path::new(&other.path), first);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn damaged_main_program_requires_registry_corroboration_to_become_degraded() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("degraded");
        let broken = root.join(sidekickai_uninstall_core::product::edition().directory.as_str());
        make_install(&broken, false, true, true, false);

        let unregistered = discover_candidates(vec![candidate(&broken, InstallScope::PerUser, None)], None).unwrap();
        assert!(unregistered.locations.is_empty(), "a missing main program alone must not authorize deletion");

        let registered = discover_candidates(vec![candidate(&broken, InstallScope::PerUser, Some("HKCU"))], Some(&broken)).unwrap();
        assert_eq!(registered.locations.len(), 1);
        let location = &registered.locations[0];
        assert_eq!(location.identity_confidence, IdentityConfidence::Degraded);
        assert!(!location.executable_present);
        assert!(location.removable);
        assert_eq!(location.registered_roots, vec!["HKCU".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_installation_reports_its_in_place_data_root() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = fixture_root("portable");
        let portable = root.join("SidekickAI-Portable");
        make_install(&portable, true, true, true, true);

        let scan = discover_candidates(vec![candidate(&portable, InstallScope::Unknown, None)], Some(&portable)).unwrap();
        assert_eq!(scan.locations.len(), 1);
        let location = &scan.locations[0];
        assert_eq!(location.scope, InstallScope::Portable, "the portable marker decides the scope");
        assert!(!location.removable);
        assert_eq!(location.non_removable_reason, Some(UninstallErrorCode::TargetNotInstall));
        let data_root = scan.data_roots.iter().find(|r| Path::new(&r.path).ends_with("data")).expect("portable data root must be reported");
        assert_eq!(data_root.associated_target_ids, vec![location.id.clone()]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn registry_command_is_not_executed_or_broadly_parsed() {
        let target = Path::new(r"C:\Apps With Spaces\SidekickAI\uninstall.exe");
        assert!(uninstall_command_matches(&format!("\"{}\" --uninstall", target.display()), target));
        assert!(!uninstall_command_matches(&format!("\"{}\" --silent", target.display()), target));
        assert!(!uninstall_command_matches("cmd /c del /s C:\\", target));
    }
    #[test]
    fn data_discovery_includes_recovery_trees_without_crossing_installation_modes() {
        let root = fixture_root("recovery-data");
        let portable = root.join("portable");
        let roaming = root.join("roaming");
        let installed = roaming.join(sidekickai_uninstall_core::product::edition().data_directories[0].as_str());
        std::fs::create_dir_all(portable.join("data")).unwrap();
        std::fs::write(portable.join("portable.txt"), b"portable").unwrap();
        let portable_backup = portable.join("data.bak-1234567890123");
        let installed_backup = roaming.join(format!("{}.bak-01234567-89ab-cdef-0123-456789abcdef", sidekickai_uninstall_core::product::edition().data_directories[0]));
        for data in [&installed, &portable_backup, &installed_backup] {
            std::fs::create_dir_all(data).unwrap();
            std::fs::write(data.join("settings.db"), b"settings").unwrap();
            std::fs::write(data.join("chat.db"), b"chat").unwrap();
        }
        let portable_paths = data_paths_for(&portable, Some(&roaming)).unwrap();
        assert!(portable_paths.contains(&portable_backup));
        assert!(!portable_paths.contains(&installed));
        let installed_paths = data_paths_for(&root.join("installed-program"), Some(&roaming)).unwrap();
        assert!(installed_paths.contains(&installed_backup));
        assert!(!installed_paths.contains(&portable_backup));
        std::fs::remove_dir_all(root).unwrap();
    }
}
