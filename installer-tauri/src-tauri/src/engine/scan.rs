// scan —— 已安装位置扫描与目标目录内进程停止
use std::path::{Path, PathBuf};


use crate::manifest::{self, InstallLocation, ScanResult};
use sidekickai_uninstall_core::path::NormalizedAbsolutePath;

use super::registry::{read_install_registration, read_registry_string, uninstall_registration_key};
use super::write_log;

// ============================================================================
// 扫描：固定目录优先，覆盖固定盘常见路径
// ============================================================================

pub(crate) fn fixed_drives() -> Vec<String> {
    // ponytail: 逐盘 GetDriveTypeW 而非 WMI 查询；固定盘数量小，同步循环足够
    let mut out = Vec::new();
    for c in b'C'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if Path::new(&root).exists() && is_fixed_drive(&root) {
            out.push(root);
        }
    }
    out
}

pub(crate) fn is_fixed_drive(root: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_FIXED: u32 = 3;
    let w: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) == DRIVE_FIXED }
}

/// 有限候选路径：系统标准位置 + 各固定盘根下的常见目录
pub(crate) fn candidate_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    for (root, source) in [("HKCU", "registered-user"), ("HKLM", "registered-machine")] {
        match read_registry_string(&uninstall_registration_key(root), "InstallLocation") {
            Ok(Some(path)) if !path.trim().is_empty() => out.push((PathBuf::from(path), source)),
            Err(error) => write_log(&format!("W|读取安装位置失败：{error}")),
            _ => {}
        }
    }
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pfx86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let drives = fixed_drives();
    for directory in sidekickai_uninstall_core::product::edition().install_directories() {
        if !pf.is_empty() {
            out.push((PathBuf::from(&pf).join(directory), "program-files"));
        }
        if !pfx86.is_empty() {
            out.push((PathBuf::from(&pfx86).join(directory), "program-files-x86"));
        }
        if !la.is_empty() {
            out.push((PathBuf::from(&la).join("Programs").join(directory), "local-programs"));
        }
        for root in &drives {
            let r = PathBuf::from(root);
            out.push((r.join(directory), "fixed-disk"));
            out.push((r.join("Apps").join(directory), "fixed-disk"));
            out.push((r.join("Programs").join(directory), "fixed-disk"));
        }
    }
    out
}

/// 有效安装标记：目录下存在 SidekickAI.exe + resources\app.asar
pub(crate) fn is_valid_install(dir: &Path) -> bool {
    (dir.join("SidekickAI.exe").is_file() || dir.join(&sidekickai_uninstall_core::product::edition().legacy_executable).is_file()) && sidekickai_uninstall_core::product::owns_installation(dir)
}

fn is_registered_repair_target(dir: &Path) -> bool {
    ["HKCU", "HKLM"].into_iter().any(|root| {
        read_install_registration(&uninstall_registration_key(root), root).ok().flatten()
            .is_some_and(|registration| sidekickai_uninstall_core::product::owns_registered_installation(dir, &registration))
    })
}

/// Coordinate verified application owners before replacing selected installations.
pub(crate) fn stop_processes_in_targets(targets: &[PathBuf]) -> Result<(), String> {
    crate::application_launch::stop_installations(targets)
}

pub fn scan_installations() -> ScanResult {
    write_log("I|开始扫描已安装位置");

    let mut locations: Vec<InstallLocation> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (dir, source) in candidate_dirs() {
        if !seen.insert(dir.to_string_lossy().to_lowercase()) {
            continue;
        }
        if is_valid_install(&dir) || is_registered_repair_target(&dir) {
            let registration = ["HKCU", "HKLM"].into_iter().find_map(|root| {
                let key = uninstall_registration_key(root);
                let location = read_registry_string(&key, "InstallLocation").ok().flatten()?;
                if !sidekickai_uninstall_core::path::paths_equal(Path::new(&location), &dir) { return None; }
                let version = read_registry_string(&key, "DisplayVersion").ok().flatten().unwrap_or_default();
                Some((root == "HKLM", version))
            });
            let for_all_users = registration.as_ref().map(|(all, _)| *all)
                .unwrap_or(matches!(source, "program-files" | "program-files-x86"));
            locations.push(InstallLocation {
                for_all_users,
                path: dir.to_string_lossy().into_owned(),
                source: source.to_string(),
                version: registration.as_ref().map(|(_, version)| version.clone()).unwrap_or_default(),
                arch: String::new(),
                registered: registration.is_some(),
                running_pid: NormalizedAbsolutePath::parse_target(&dir).ok()
                    .and_then(|target| sidekickai_uninstall_host::target_processes(&[target]).ok())
                    .and_then(|pids| pids.first().copied()).unwrap_or(0),
                recommended_for_cleanup: false,
            });
        }
    }
    let n = locations.len();
    let (recommended_dir, residual_hint) = if n == 0 {
        (
            manifest::build_info().default_dir,
            String::new(),
        )
    } else {
        let hint = if n > 1 {
            format!("发现 {} 处 SidekickAI 安装位置，建议保留一处并清理其余。", n)
        } else {
            format!("检测到已安装 SidekickAI（{}），将维护所选位置。", locations[0].version)
        };
        (locations[0].path.clone(), hint)
    };
    let (other_editions, other_editions_warning) = match sidekickai_uninstall_host::installed_locations() {
        Ok(all) => (other_edition_installations(all), String::new()),
        Err(error) => (Vec::new(), format!("无法完整检查另一版的已有安装：{}。请确认安装目录后继续。", error.message)),
    };
    ScanResult {
        other_editions,
        other_editions_warning,
        locations,
        recommended_dir,
        residual_hint,
        fixed_drives: fixed_drives(),
    }
}

fn other_edition_installations(locations: Vec<sidekickai_uninstall_core::protocol::UninstallLocation>) -> Vec<manifest::OtherEditionInstallation> {
    use sidekickai_uninstall_core::product;
    locations.into_iter().filter(|location| location.edition != product::edition_id())
        .filter_map(|location| product::product().editions.get(&location.edition).map(|edition| manifest::OtherEditionInstallation {
            edition: location.edition, label: edition.label.clone(), path: location.display_path,
            version: location.version, arch: location.arch,
        })).collect()
}
