// payload —— 安装载荷定位、自解压提取与 staging 解压
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::manifest;

use super::{progress, status, write_log, CommandHidden};

// ============================================================================
// 安装流水线：scan → prepare → staging 解压 → 校验 → 关进程 → backup → commit → 注册 → 验证
// ============================================================================

/// Verified payload files with ownership of an isolated extraction directory.
pub(crate) struct LocatedPayload {
    pub(crate) payload: PathBuf,
    pub(crate) sevenz: PathBuf,
    owned_directory: Option<PathBuf>,
}

impl Drop for LocatedPayload {
    fn drop(&mut self) {
        if let Some(directory) = &self.owned_directory {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

pub(crate) fn locate_payload() -> Option<LocatedPayload> {
    #[cfg(debug_assertions)]
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let payload = dir.join("payload.7z");
            let sevenz = dir.join("7zr.exe");
            if payload.exists() && sevenz.exists() {
                let metadata = crate::setup_metadata::current().ok()?;
                crate::setup_metadata::verify_blob(&payload, metadata.payload.as_ref()?).ok()?;
                crate::setup_metadata::verify_blob(&sevenz, metadata.extractor.as_ref()?).ok()?;
                return Some(LocatedPayload { payload, sevenz, owned_directory: None });
            }
        }
    }
    extract_embedded()
}

/// Extract verified payload blocks from the versioned Setup container.
pub(crate) fn extract_embedded() -> Option<LocatedPayload> {
    let exe = std::env::current_exe().ok()?;
    extract_embedded_from(&exe)
}

pub(crate) fn extract_embedded_from(exe: &Path) -> Option<LocatedPayload> {
    let mut f = std::fs::File::open(exe).ok()?;
    let layout = crate::setup_metadata::read_layout(&mut f).ok()?;
    let metadata = crate::setup_metadata::read_from(&mut f, &layout).ok()?;
    let directory = super::pipeline::unique_temp_dir("SidekickAI-Payload").ok()?;
    let files = LocatedPayload {
        payload: directory.join("payload.7z"), sevenz: directory.join("7zr.exe"),
        owned_directory: Some(directory),
    };
    copy_file_range(&mut f, layout.payload_offset, layout.payload_size, &files.payload).ok()?;
    copy_file_range(&mut f, layout.payload_offset + layout.payload_size, layout.extractor_size, &files.sevenz).ok()?;
    if f.metadata().ok()?.len() != layout.file_size { return None; }
    crate::setup_metadata::verify_blob(&files.payload, metadata.payload.as_ref()?).ok()?;
    crate::setup_metadata::verify_blob(&files.sevenz, metadata.extractor.as_ref()?).ok()?;
    write_log("I|安装载荷已提取到独立临时目录");
    Some(files)
}

fn copy_file_range(f: &mut fs::File, offset: u64, len: u64, dst: &Path) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom, Write};
    f.seek(SeekFrom::Start(offset))?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
    let mut remaining = len;
    let mut buf = vec![0u8; 1024 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "源文件提前结束",
            ));
        }
        out.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    out.flush()?;
    Ok(())
}

/// 解析 7zr 输出中的 "NN%" 进度
pub(crate) fn extract_percent(s: &[u8]) -> Option<u32> {
    let mut i = s.len();
    while i > 0 {
        i -= 1;
        if s[i] == b'%' {
            let mut start = i;
            while start > 0 && s[start - 1].is_ascii_digit() {
                start -= 1;
            }
            if start < i {
                if let Some(v) = std::str::from_utf8(&s[start..i]).ok()?.parse::<u32>().ok() {
                    return Some(v);
                }
            }
        }
    }
    None
}

pub(crate) fn clear_readonly_attributes(dir: &Path) {
    let _ = Command::new("attrib").hidden()
        .args(["-R", "/S", "/D", &format!("{}\\*", dir.display())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// staging 解压：返回解压出的架构子目录
pub(crate) fn extract_to_staging(payload: &Path, sevenz: &Path, staging: &Path) -> Result<PathBuf, String> {
    let subdir = if manifest::host_arch() == "arm64" { "win-arm64-unpacked" } else { "win-unpacked" };
    status("正在解压安装文件…");
    fs::create_dir_all(staging).map_err(|e| format!("无法创建临时目录：{}", e))?;
    if fs::read_dir(staging).map_err(|error| error.to_string())?.next().is_some() {
        return Err("安装解压目录必须为空。".into());
    }

    let mut child = Command::new(sevenz).hidden()
        .args([
            "x",
            payload.to_str().unwrap(),
            &format!("-o{}", staging.display()),
            subdir,
            "-y",
            "-bsp1",
            "-bso0",
            "-bse0",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 7zr 失败：{}", e))?;

    let mut out = child.stdout.take().ok_or("无法读取 7zr 输出")?;
    let mut acc: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = out.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        acc.extend_from_slice(&buf[..n]);
        if let Some(pct) = extract_percent(&acc) {
            progress(10 + (pct * 70 / 100));
        }
        if acc.len() > 256 {
            let keep = acc.split_off(acc.len() - 64);
            acc = keep;
        }
    }
    let st = child.wait().map_err(|e| e.to_string())?;
    if !st.success() {
        let _ = fs::remove_dir_all(staging);
        return Err("解压安装文件失败".into());
    }
    let extracted = staging.join(subdir);
    if !extracted.exists() {
        let _ = fs::remove_dir_all(staging);
        return Err(format!("解压结果缺少架构目录 {}", subdir));
    }
    Ok(extracted)
}
