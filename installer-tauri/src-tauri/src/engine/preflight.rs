use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
use windows::{core::PCWSTR, Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumePathNameW}};

pub(crate) fn staging_directory(req: &crate::manifest::InstallRequest) -> Result<PathBuf, String> {
    let selected = if req.staging_dir.trim().is_empty() { std::env::temp_dir() } else { PathBuf::from(req.staging_dir.trim()) };
    let directory = sidekickai_uninstall_core::path::normalize_absolute_path(&selected).map_err(|error| format!("安装暂存位置无效：{}", error.message))?.as_path().to_path_buf();
    sidekickai_uninstall_core::path::reject_reparse_points(&directory).map_err(|error| error.message)?;
    for target in std::iter::once(&req.install_dir).chain(req.cleanup_paths.iter()) {
        let target = super::scope::normalize_owned_dir(target, "安装目录")?;
        if sidekickai_uninstall_core::path::path_is_same_or_descendant(&directory, &target) {
            return Err("安装暂存位置不能位于将被替换或清理的安装目录内。请另选位置。".into());
        }
    }
    if !crate::elevate::dir_is_writable(&directory) { return Err(format!("安装暂存位置不可写：{}。请在安装选项中更换暂存位置后重试；原版本未修改。", directory.display())); }
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建安装暂存位置 {}：{error}", directory.display()))?;
    Ok(directory)
}

pub(crate) fn tree_size(path: &Path) -> Result<u64, String> {
    sidekickai_uninstall_core::path::reject_reparse_points(path).map_err(|error| error.message)?;
    if !path.exists() { return Ok(0); }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_file() { return Ok(metadata.len()); }
    let mut size = 0u64;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        size = size.checked_add(tree_size(&entry.map_err(|error| error.to_string())?.path())?).ok_or("安装空间估算超出支持范围")?;
    }
    Ok(size)
}

fn existing_parent(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    while !current.exists() { current = current.parent().ok_or("无法找到目标磁盘")?; }
    Ok(current.to_path_buf())
}

fn volume_space(path: &Path) -> Result<(String, u64), String> {
    let parent = existing_parent(path)?;
    let wide = crate::elevate::wide(&parent.to_string_lossy());
    let mut volume = vec![0u16; 32768];
    unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut volume) }.map_err(|error| format!("无法确认磁盘 {}：{error}", path.display()))?;
    let length = volume.iter().position(|value| *value == 0).ok_or("磁盘路径无效")?;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(volume.as_ptr()), Some(&mut free), None, None) }.map_err(|error| format!("无法检查磁盘可用空间：{error}"))?;
    Ok((String::from_utf16_lossy(&volume[..length]).to_lowercase(), free))
}

pub(crate) fn check_space(reservations: &[(PathBuf, u64)]) -> Result<(), String> {
    let mut volumes = BTreeMap::<String, (u64, u64)>::new();
    for (path, required) in reservations {
        let (volume, available) = volume_space(path)?;
        let entry = volumes.entry(volume).or_insert((0, available));
        entry.0 = entry.0.checked_add(*required).ok_or("安装空间估算超出支持范围")?;
        entry.1 = entry.1.min(available);
    }
    for (volume, (required, available)) in volumes {
        let required = required.saturating_add(64 * 1024 * 1024).saturating_add(required / 10);
        if available < required { return Err(format!("磁盘 {volume} 空间不足：需 {} MiB，可用 {} MiB。请释放空间或更换安装位置后重试；原版本未修改。", required.div_ceil(1024 * 1024), available / 1024 / 1024)); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn volume_budget_rejects_impossible_combined_reservation() {
        let base = std::env::temp_dir();
        assert!(check_space(&[(base.clone(), u64::MAX / 2), (base, u64::MAX / 2)]).unwrap_err().contains("空间不足"));
    }
}
