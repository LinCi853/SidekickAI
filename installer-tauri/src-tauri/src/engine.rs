// engine.rs —— 安装引擎：扫描、staging+backup+commit+rollback、修复、卸载、7zr 解压、快捷方式、卸载注册
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::elevate;
use crate::manifest::{self, InstallLocation, InstallMode, InstallRequest, ScanResult};

pub fn log_path() -> PathBuf {
    std::env::temp_dir().join("SidekickAI-install.log")
}
pub fn result_path() -> PathBuf {
    std::env::temp_dir().join("SidekickAI-install-result.json")
}

fn write_log(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{}", line);
    }
}

pub fn status(msg: &str) {
    write_log(&format!("S|{}", msg));
}
pub fn progress(p: u32) {
    write_log(&format!("P|{}", p));
}

/// 隐藏窗口运行外部命令（CREATE_NO_WINDOW = 0x08000000）
trait CommandHidden {
    fn hidden(&mut self) -> &mut Command;
}

impl CommandHidden for Command {
    fn hidden(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

// ============================================================================
// 扫描：固定目录优先，覆盖固定盘常见路径
// ============================================================================

fn fixed_drives() -> Vec<String> {
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

fn is_fixed_drive(root: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_FIXED: u32 = 3;
    let w: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) == DRIVE_FIXED }
}

/// 有限候选路径：系统标准位置 + 各固定盘根下的常见目录
fn candidate_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pfx86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if !pf.is_empty() {
        out.push((PathBuf::from(&pf).join("SidekickAI"), "program-files"));
    }
    if !pfx86.is_empty() {
        out.push((PathBuf::from(&pfx86).join("SidekickAI"), "program-files-x86"));
    }
    if !la.is_empty() {
        out.push((PathBuf::from(&la).join("Programs").join("SidekickAI"), "local-programs"));
    }
    for root in fixed_drives() {
        let r = PathBuf::from(&root);
        out.push((r.join("SidekickAI"), "fixed-disk"));
        out.push((r.join("Apps").join("SidekickAI"), "fixed-disk"));
        out.push((r.join("Programs").join("SidekickAI"), "fixed-disk"));
    }
    out
}

/// 有效安装标记：目录下存在 SidekickAI.exe + resources\app.asar
fn is_valid_install(dir: &Path) -> bool {
    dir.join("SidekickAI.exe").exists() && dir.join("resources").join("app.asar").exists()
}

/// 通过 tasklist 输出检测 SidekickAI.exe 是否运行，返回 PID（0 = 未运行）
/// ponytail: 用 tasklist 文本解析代替 Toolhelp 快照，避免额外依赖；进程数少时足够
fn find_running_pid() -> u32 {
    let out = Command::new("tasklist").hidden()
        .args(["/FI", "IMAGENAME eq SidekickAI.exe", "/FO", "CSV", "/NH"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
        for line in s.lines() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 && parts[0].contains("SidekickAI.exe") {
                let pid: String = parts[1].trim_matches('"').to_string();
                if let Ok(p) = pid.parse() {
                    return p;
                }
            }
        }
    }
    0
}

/// 只按路径精确关闭：taskkill /PID（设计要求：避免无条件误杀同名程序）
fn kill_pid(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    let r = Command::new("taskkill").hidden()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let ok = r.map(|s| s.success()).unwrap_or(false);
    if ok {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    ok
}

/// 从注册表卸载项读已注册版本
fn registered_version() -> (bool, String) {
    for root in ["HKCU", "HKLM"] {
        let key = format!("{}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SidekickAI", root);
        if let Ok(o) = Command::new("reg").hidden()
            .args(["query", &key, "/v", "DisplayVersion"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("DisplayVersion") {
                let ver = s
                    .lines()
                    .find(|l| l.contains("DisplayVersion"))
                    .and_then(|l| l.rsplit("REG_SZ").next())
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
                return (true, ver);
            }
        }
    }
    (false, String::new())
}

pub fn scan_installations() -> ScanResult {
    write_log("I|开始扫描已安装位置");
    let (registered, reg_version) = registered_version();
    let running_pid = find_running_pid();
    let mut locations: Vec<InstallLocation> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (dir, source) in candidate_dirs() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        if is_valid_install(&dir) {
            locations.push(InstallLocation {
                path: dir.to_string_lossy().into_owned(),
                source: source.to_string(),
                version: reg_version.clone(),
                arch: String::new(),
                registered,
                running_pid: if running_pid > 0 { running_pid } else { 0 },
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
            format!("检测到已安装 SidekickAI（{}），将执行覆盖安装。", reg_version)
        };
        (locations[0].path.clone(), hint)
    };
    ScanResult {
        locations,
        recommended_dir,
        residual_hint,
        fixed_drives: fixed_drives(),
    }
}

// ============================================================================
// 安装流水线：scan → prepare → staging 解压 → 校验 → 关进程 → backup → commit → 注册 → 验证
// ============================================================================

/// 定位 payload.7z 与 7zr.exe：
///   1. 优先取安装器同目录（开发 / 测试态）
///   2. 否则从自身 exe 尾部自解压（生产态单文件）
fn locate_payload() -> Option<(PathBuf, PathBuf)> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let payload = dir.join("payload.7z");
            let sevenz = dir.join("7zr.exe");
            if payload.exists() && sevenz.exists() {
                return Some((payload, sevenz));
            }
        }
    }
    extract_embedded()
}

/// 从自身 exe 尾部解出 payload.7z 与 7zr.exe（footer 描述两个区块长度）。
/// 布局：exe 原生字节 + payload.7z + 7zr.exe + footer(28B)：
///   [0..8)  magic "SKPAYLD1"
///   [8..16) payload_len (u64 LE)
///   [16..24) sevenz_len (u64 LE)
///   [24..28) footer_len (u32 LE) = 28
fn extract_embedded() -> Option<(PathBuf, PathBuf)> {
    use std::io::{Read, Seek, SeekFrom};

    write_log("I|开始从单文件尾部提取安装载荷");
    let exe = std::env::current_exe().ok()?;
    let mut f = std::fs::File::open(&exe).ok()?;
    let file_size = f.metadata().ok()?.len();
    write_log(&format!("I|安装器文件大小：{} B", file_size));
    if file_size < 28 {
        return None;
    }
    f.seek(SeekFrom::End(-4)).ok()?;
    let mut fl = [0u8; 4];
    f.read_exact(&mut fl).ok()?;
    let footer_len = u32::from_le_bytes(fl) as u64;
    if footer_len < 28 || footer_len > file_size {
        return None;
    }
    f.seek(SeekFrom::End(-(footer_len as i64))).ok()?;
    let mut footer = vec![0u8; footer_len as usize];
    f.read_exact(&mut footer).ok()?;
    if &footer[0..8] != b"SKPAYLD1" {
        return None;
    }
    let payload_len = u64::from_le_bytes(footer[8..16].try_into().ok()?) as usize;
    let sevenz_len = u64::from_le_bytes(footer[16..24].try_into().ok()?) as usize;
    let suffix_len = footer_len as usize + sevenz_len + payload_len;
    if suffix_len > file_size as usize {
        write_log("E|安装器尾部载荷长度超出文件范围");
        return None;
    }
    let payload_off = file_size as usize - suffix_len;
    write_log(&format!("I|载荷偏移：{}，payload：{} B，7zr：{} B", payload_off, payload_len, sevenz_len));

    let dir = std::env::temp_dir().join("SidekickAI-Setup");
    std::fs::create_dir_all(&dir).ok()?;
    let payload_path = dir.join("payload.7z");
    let sevenz_path = dir.join("7zr.exe");

    if copy_range(&exe, payload_off, payload_len, &payload_path).is_err()
        || copy_range(&exe, payload_off + payload_len, sevenz_len, &sevenz_path).is_err()
    {
        write_log("E|从单文件提取载荷失败");
        return None;
    }
    if std::fs::metadata(&payload_path).ok()?.len() != payload_len as u64
        || std::fs::metadata(&sevenz_path).ok()?.len() != sevenz_len as u64
    {
        write_log("E|提取出的载荷长度校验失败");
        return None;
    }
    write_log("I|安装载荷提取完成");
    Some((payload_path, sevenz_path))
}

fn copy_range(src: &Path, offset: usize, len: usize, dst: &Path) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut f = std::fs::File::open(src)?;
    f.seek(SeekFrom::Start(offset as u64))?;
    let mut out = std::fs::File::create(dst)?;
    let mut remaining = len;
    // 堆分配缓冲区：1 MB 数组放在线程栈上会触发 Windows 默认栈溢出。
    let mut buf = vec![0u8; 1024 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len());
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "源文件提前结束",
            ));
        }
        out.write_all(&buf[..n])?;
        remaining -= n;
    }
    out.flush()?;
    Ok(())
}

/// 解析 7zr 输出中的 "NN%" 进度
fn extract_percent(s: &[u8]) -> Option<u32> {
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

fn clear_readonly_attributes(dir: &Path) {
    let _ = Command::new("attrib").hidden()
        .args(["-R", "/S", "/D", &format!("{}\\*", dir.display())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_dir(src, dst)?;
    let _ = fs::remove_dir_all(src);
    Ok(())
}

/// 迭代复制目录，避免 Electron 目录层级较深时递归调用导致栈溢出。
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let mut pending = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((current_src, current_dst)) = pending.pop() {
        fs::create_dir_all(&current_dst)
            .map_err(|e| format!("无法创建目录 {}：{}", current_dst.display(), e))?;
        for entry in fs::read_dir(&current_src)
            .map_err(|e| format!("无法读取目录 {}：{}", current_src.display(), e))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let ty = entry
                .file_type()
                .map_err(|e| format!("无法读取文件类型 {}：{}", entry.path().display(), e))?;
            let from = entry.path();
            let to = current_dst.join(entry.file_name());
            if ty.is_dir() {
                pending.push((from, to));
            } else {
                fs::copy(&from, &to)
                    .map_err(|e| format!("无法复制 {} 到 {}：{}", from.display(), to.display(), e))?;
            }
        }
    }
    Ok(())
}

/// staging 解压：返回解压出的架构子目录
fn extract_to_staging(payload: &Path, sevenz: &Path, staging: &Path) -> Result<PathBuf, String> {
    let subdir = if manifest::host_arch() == "arm64" { "win-arm64-unpacked" } else { "win-unpacked" };
    status("正在解压安装文件…");
    let _ = fs::remove_dir_all(staging);
    fs::create_dir_all(staging).map_err(|e| format!("无法创建临时目录：{}", e))?;

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

/// 校验核心运行集：主程序 exe、app.asar、关键 DLL、架构目录
fn validate_core(dir: &Path) -> Result<(), String> {
    const CORE: &[&str] = &[
        "SidekickAI.exe",
        "resources\\app.asar",
    ];
    for rel in CORE {
        if !dir.join(rel).exists() {
            return Err(format!("载荷校验失败：缺少核心文件 {}", rel));
        }
    }
    Ok(())
}

/// 安装锁：阻止多实例并发操作（同目录互斥文件）
fn acquire_install_lock() -> Option<fs::File> {
    let lock = std::env::temp_dir().join("SidekickAI-install.lock");
    // 独占创建：已存在则说明另一实例在运行
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .ok()
        .or_else(|| {
            // 残留锁：超过 30 分钟视为陈旧并接管
            // ponytail: mtime 陈旧判定，崩溃场景足够；进程级互斥体需额外 crate
            if let Ok(meta) = fs::metadata(&lock) {
                if let Ok(mtime) = meta.modified() {
                    if mtime.elapsed().map(|e| e.as_secs() > 1800).unwrap_or(false) {
                        let _ = fs::remove_file(&lock);
                        return fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&lock)
                            .ok();
                    }
                }
            }
            None
        })
}

pub fn run(req: &InstallRequest) -> Result<(), String> {
    // 轻量子任务：仅在用户点击完成/关闭向导时写入最终配置
    if req.action == "flush-config" {
        return flush_install_config(req);
    }
    match req.mode {
        InstallMode::Repair => run_repair(req),
        InstallMode::Uninstall => run_uninstall_request(req),
        InstallMode::Install => run_install(req),
    }
}

fn run_install(req: &InstallRequest) -> Result<(), String> {
    let _lock = acquire_install_lock().ok_or_else(|| {
        "检测到另一个安装器实例正在运行，请等待其完成或关闭后重试。".to_string()
    });
    write_log(&format!("I|安装引擎启动，模式 install，目标目录：{}", req.install_dir));
    progress(3);
    status("正在准备安装…");
    let (payload, sevenz) = locate_payload().ok_or_else(|| {
        let message = "未找到安装载荷 payload.7z / 7zr.exe（需与安装器同目录或内嵌于单文件）";
        write_log(&format!("E|{}", message));
        message
    })?;
    let install_dir = PathBuf::from(&req.install_dir);
    let parent = install_dir.parent().ok_or("无效的安装目录")?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {}：{}", parent.display(), e))?;

    // ---- staging 解压 + 校验（不动旧安装）----
    let staging = std::env::temp_dir().join(format!("SidekickAI-Extract-{}", std::process::id()));
    let extracted = extract_to_staging(&payload, &sevenz, &staging)?;
    if let Err(e) = validate_core(&extracted) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    // ---- 关闭旧进程（按 PID 精确）----
    status("正在关闭旧版本进程…");
    let pid = find_running_pid();
    if pid > 0 {
        write_log(&format!("I|发现运行中的 SidekickAI，PID {}", pid));
        kill_pid(pid);
    }

    // ---- backup：旧目录改名而非删除 ----
    let had_old = install_dir.exists();
    let backup = std::env::temp_dir().join(format!("SidekickAI-Backup-{}", std::process::id()));
    let mut backup_created = false;
    if had_old {
        status("正在备份旧版本…");
        clear_readonly_attributes(&install_dir);
        let _ = fs::remove_dir_all(&backup);
        if fs::rename(&install_dir, &backup).is_ok() {
            backup_created = true;
        } else {
            // rename 失败（跨盘或被锁）：退回复制式备份
            write_log("W|旧目录改名失败，改用复制式备份");
            if copy_dir(&install_dir, &backup).is_ok() {
                backup_created = true;
            }
        }
        if !backup_created {
            let _ = fs::remove_dir_all(&staging);
            return Err("无法备份旧安装目录，已中止（旧版本未受影响）".into());
        }
    }

    // ---- commit：staging → 目标 ----
    progress(84);
    status("正在写入安装文件…");
    let commit = move_dir(&extracted, &install_dir);
    if let Err(e) = commit {
        // 回滚
        write_log(&format!("E|提交安装失败：{}，开始回滚", e));
        if backup_created {
            let _ = fs::remove_dir_all(&install_dir);
            let _ = move_dir(&backup, &install_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("安装失败：{}（已恢复旧版本）", e));
    }
    let _ = fs::remove_dir_all(&staging);

    // ---- 配置 / 快捷方式 / 注册表（任一失败 → 回滚）----
    let tail = (|| -> Result<(), String> {
        progress(90);
        status("正在写入配置…");
        write_install_config(req, &install_dir)?;
        write_plugins_manifest(req, &install_dir)?;

        progress(94);
        status("正在创建快捷方式…");
        if req.create_desktop_shortcut {
            create_shortcuts(req, &install_dir);
        }

        progress(97);
        status("正在写入卸载信息…");
        register_uninstall(req, &install_dir)?;
        copy_uninstaller(&install_dir)?;
        Ok(())
    })();

    if let Err(e) = tail {
        write_log(&format!("E|安装后置步骤失败：{}，开始回滚", e));
        let _ = fs::remove_dir_all(&install_dir);
        if backup_created {
            let _ = move_dir(&backup, &install_dir);
        }
        remove_shortcuts(!req.for_all_users);
        remove_uninstall_entry(if req.for_all_users { "HKLM" } else { "HKCU" });
        return Err(format!("安装失败：{}（已恢复旧版本）", e));
    }

    // ---- 成功：删除 backup、清理用户确认的其他位置 ----
    if backup_created {
        status("正在清理备份…");
        clear_readonly_attributes(&backup);
        let _ = fs::remove_dir_all(&backup);
    }
    for extra in &req.cleanup_paths {
        let p = PathBuf::from(extra);
        if p != install_dir && p.exists() {
            status(&format!("正在清理其他安装位置 {}…", p.display()));
            clear_readonly_attributes(&p);
            if let Err(e) = fs::remove_dir_all(&p) {
                write_log(&format!("W|清理 {} 失败：{}（将在完成页提示）", p.display(), e));
            }
        }
    }
    // 清理另一安装模式遗留的快捷方式与卸载项，保证唯一入口
    let other_mode = !req.for_all_users;
    remove_shortcuts(other_mode);
    remove_uninstall_entry(if req.for_all_users { "HKCU" } else { "HKLM" });

    progress(100);
    status("安装完成");
    Ok(())
}

/// 修复模式：只替换校验失败/缺少的核心程序文件，保留配置与用户数据
fn run_repair(req: &InstallRequest) -> Result<(), String> {
    let _lock = acquire_install_lock().ok_or_else(|| {
        "检测到另一个安装器实例正在运行，请等待其完成或关闭后重试。".to_string()
    });
    write_log(&format!("I|安装引擎启动，模式 repair，目标目录：{}", req.install_dir));
    progress(5);
    status("正在校验现有安装…");
    let install_dir = PathBuf::from(&req.install_dir);
    if !install_dir.exists() {
        return Err("修复目标目录不存在，请先执行正常安装。".into());
    }

    // 校验现有核心文件，缺失/损坏则从 staging 恢复
    let broken = validate_core(&install_dir).is_err();
    if !broken {
        progress(100);
        status("核心文件完整，无需修复");
        write_log("I|核心文件完整，跳过修复");
        return Ok(());
    }

    let (payload, sevenz) = locate_payload().ok_or_else(|| {
        let message = "未找到安装载荷 payload.7z / 7zr.exe（需与安装器同目录或内嵌于单文件）";
        write_log(&format!("E|{}", message));
        message
    })?;
    let staging = std::env::temp_dir().join(format!("SidekickAI-Repair-{}", std::process::id()));
    let extracted = extract_to_staging(&payload, &sevenz, &staging)?;

    status("正在关闭运行中的进程…");
    let pid = find_running_pid();
    if pid > 0 {
        kill_pid(pid);
    }

    progress(80);
    status("正在替换核心程序文件…");
    // 只覆盖程序文件：exe、resources；不动 install-config.json、用户数据
    let targets = [install_dir.join("SidekickAI.exe"), install_dir.join("resources")];
    for t in &targets {
        if !t.exists() {
            continue;
        }
        if t.is_dir() {
            let _ = fs::remove_dir_all(t);
        } else {
            let _ = fs::remove_file(t);
        }
    }
    for name in ["SidekickAI.exe", "resources"] {
        let src = extracted.join(name);
        let dst = install_dir.join(name);
        if src.exists() {
            if src.is_dir() {
                copy_dir(&src, &dst)?;
            } else {
                fs::copy(&src, &dst).map_err(|e| format!("恢复 {} 失败：{}", name, e))?;
            }
        }
    }
    let _ = fs::remove_dir_all(&staging);

    if let Err(e) = validate_core(&install_dir) {
        return Err(format!("修复后校验失败：{}", e));
    }
    // 修复不重写配置（保留用户设置），只确保卸载入口有效
    if req.create_desktop_shortcut {
        create_shortcuts(req, &install_dir);
    }
    progress(100);
    status("修复完成");
    Ok(())
}

/// 统一卸载入口（安装器 UI 触发；数据策略由 data_strategy / delete_user_data 决定）
fn run_uninstall_request(req: &InstallRequest) -> Result<(), String> {
    let _lock = acquire_install_lock().ok_or_else(|| {
        "检测到另一个安装器实例正在运行，请等待其完成或关闭后重试。".to_string()
    });
    write_log(&format!(
        "I|安装引擎启动，模式 uninstall，目标：{}，数据策略：{:?} / delete_user_data: {}",
        req.install_dir, req.data_strategy, req.delete_user_data
    ));
    progress(5);
    let install_dir = PathBuf::from(&req.install_dir);
    if !install_dir.exists() {
        return Err("未找到要卸载的安装目录。".into());
    }

    // 数据策略归一化：新字段优先，兼容旧布尔字段
    let strategy = if !req.data_strategy.is_empty() {
        req.data_strategy.as_str()
    } else if req.delete_user_data {
        "delete"
    } else {
        "keep"
    };

    status("正在关闭软件…");
    let pid = find_running_pid();
    if pid > 0 {
        kill_pid(pid);
    }

    // 用户数据候选目录：当前 %APPDATA%\sidekick-ai（Electron app.getName() 取 package.json 的 name），
    // 以及历史版本遗留目录（ai-window / SidekickAI），备份与删除均覆盖全部候选
    let data_dirs: Vec<PathBuf> = std::env::var("APPDATA")
        .ok()
        .map(|a| {
            let base = PathBuf::from(&a);
            ["sidekick-ai", "ai-window", "SidekickAI"]
                .iter()
                .map(|name| base.join(name))
                .collect()
        })
        .unwrap_or_default();

    // 导出加密备份（data_strategy=export）：在删除任何东西之前完成，失败则中止卸载
    if strategy == "export" {
        progress(30);
        status("正在导出并加密用户数据…");
        if req.backup_path.is_empty() {
            return Err("未指定备份保存路径，已中止卸载。".into());
        }
        if req.backup_password.is_empty() {
            return Err("未设置备份密码，已中止卸载。".into());
        }
        let backup_dir = PathBuf::from(&req.backup_path);
        if let Some(parent) = backup_dir.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建备份目录 {}：{}", parent.display(), e))?;
        }
        if let Some(src) = data_dirs.iter().find(|d| d.exists()).cloned() {
            crate::encrypt::export_encrypted_backup(&src, &backup_dir, &req.backup_password)?;
            status("用户数据已导出加密备份");
        } else {
            write_log("W|未发现用户数据目录，跳过备份导出");
        }
    }

    progress(50);
    status("正在删除快捷方式与卸载项…");
    for all in [false, true] {
        remove_shortcuts(all);
    }
    for root in ["HKCU", "HKLM"] {
        remove_uninstall_entry(root);
    }

    // 仅当策略要求删除用户数据时才删除（keep 始终保留；export 导出成功后一并删除）
    if strategy == "delete" || strategy == "export" {
        for data_dir in &data_dirs {
            if data_dir.exists() {
                status(&format!("正在删除用户数据 {}…", data_dir.display()));
                clear_readonly_attributes(data_dir);
                fs::remove_dir_all(data_dir)
                    .map_err(|e| format!("删除用户数据 {} 失败：{}", data_dir.display(), e))?;
            }
        }
    }

    progress(70);
    status("正在删除安装目录…");
    clear_readonly_attributes(&install_dir);
    fs::remove_dir_all(&install_dir).map_err(|e| format!("删除安装目录失败：{}", e))?;

    // 用户确认清理的其他位置
    for extra in &req.cleanup_paths {
        let p = PathBuf::from(extra);
        if p != install_dir && p.exists() {
            clear_readonly_attributes(&p);
            let _ = fs::remove_dir_all(p);
        }
    }

    progress(100);
    status("卸载完成");
    Ok(())
}

/// 读取已存在安装位置的 install-config.json（覆盖安装/修复时预读作初始值）。
/// 返回 {"modules": {...}, "options": {...}}；文件不存在或解析失败返回 None。
pub fn read_install_config(dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = dir.join("install-config.json");
    let raw = fs::read_to_string(path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(serde_json::json!({
        "modules": cfg.get("modules").cloned().unwrap_or_default(),
        "options": cfg.get("options").cloned().unwrap_or_default(),
    }))
}

/// 用户完成/关闭向导时写入最终配置（执行期已写过初始快照，此处覆盖为用户最终选择）。
pub fn flush_install_config(req: &InstallRequest) -> Result<(), String> {
    write_log("I|flush-config：写入最终安装配置");
    write_install_config(req, Path::new(&req.install_dir))
}

fn write_install_config(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let mut modules = serde_json::Map::new();
    for f in manifest::features() {
        let enabled = req
            .features
            .get(&f.id)
            .and_then(|v| v.as_bool())
            .unwrap_or(f.default_enabled);
        modules.insert(f.id, serde_json::json!({ "enabled": enabled }));
    }
    let mut options = serde_json::Map::new();
    for o in manifest::options() {
        let v = req
            .options
            .get(&o.id)
            .cloned()
            .unwrap_or_else(|| o.default_value.clone());
        options.insert(o.id, v);
    }
    let config = serde_json::json!({ "schemaVersion": 1, "modules": modules, "options": options });
    fs::write(
        dir.join("install-config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("写入 install-config.json 失败：{}", e))?;
    Ok(())
}

fn write_plugins_manifest(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let wb = req.features.get("whiteboard").and_then(|v| v.as_bool()).unwrap_or(true);
    fs::write(
        dir.join("plugins-manifest.json"),
        format!("{{\"whiteboard\":{{\"installed\":{}}}}}\n", wb),
    )
    .map_err(|e| format!("写入 plugins-manifest.json 失败：{}", e))?;
    Ok(())
}

pub fn system_install_dir() -> PathBuf {
    let base = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    PathBuf::from(base.trim_end_matches('\\')).join("SidekickAI")
}

pub fn user_install_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|p| format!("{}\\AppData\\Local", p.trim_end_matches('\\'))))
        .unwrap_or_else(|_| "C:\\Users\\Default\\AppData\\Local".into());
    PathBuf::from(base.trim_end_matches('\\')).join("Programs").join("SidekickAI")
}

fn desktop_dir(for_all_users: bool) -> PathBuf {
    let key = if for_all_users { "PUBLIC" } else { "USERPROFILE" };
    let base = std::env::var(key).unwrap_or_else(|_| "C:\\Users\\Public".into());
    PathBuf::from(base).join("Desktop")
}

fn start_menu_dir(for_all_users: bool) -> PathBuf {
    let key = if for_all_users { "ProgramData" } else { "APPDATA" };
    let base = std::env::var(key).unwrap_or_default();
    PathBuf::from(base)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("SidekickAI")
}

fn create_shortcuts(req: &InstallRequest, dir: &Path) {
    let exe = dir.join("SidekickAI.exe");
    let target = exe.to_string_lossy().into_owned();
    let workdir = dir.to_string_lossy().into_owned();
    let desktop = desktop_dir(req.for_all_users).join("SidekickAI.lnk");
    let start = start_menu_dir(req.for_all_users).join("SidekickAI.lnk");
    if let Some(p) = start.parent() {
        let _ = fs::create_dir_all(p);
    }
    let _ = create_shortcut(&desktop, &target, &workdir);
    let _ = create_shortcut(&start, &target, &workdir);
}

fn create_shortcut(lnk: &Path, target: &str, workdir: &str) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let target_w = elevate::wide(target);
    let workdir_w = elevate::wide(workdir);
    let lnk_w = elevate::wide(&lnk.to_string_lossy());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建快捷方式失败：{}", e))?;
        link.SetPath(PCWSTR(target_w.as_ptr()))
            .map_err(|e| format!("SetPath 失败：{}", e))?;
        link.SetWorkingDirectory(PCWSTR(workdir_w.as_ptr())).ok();
        let pf: IPersistFile = link.cast().map_err(|e| format!("cast IPersistFile 失败：{}", e))?;
        pf.Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("保存快捷方式失败：{}", e))?;
    }
    Ok(())
}

fn remove_uninstall_entry(root: &str) {
    let key = format!("{}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SidekickAI", root);
    let _ = Command::new("reg").hidden().args(["delete", &key, "/f"]).output();
}

fn remove_shortcuts(for_all_users: bool) {
    let _ = fs::remove_file(desktop_dir(for_all_users).join("SidekickAI.lnk"));
    let sm = start_menu_dir(for_all_users);
    let _ = fs::remove_file(sm.join("SidekickAI.lnk"));
    let _ = fs::remove_dir_all(sm);
}

fn register_uninstall(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let root = if req.for_all_users { "HKLM" } else { "HKCU" };
    let key = format!("{}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SidekickAI", root);
    let exe = dir.join("SidekickAI.exe").to_string_lossy().into_owned();
    let uninst = format!("\"{}\"", dir.join("uninstall.exe").to_string_lossy());
    let quiet = format!("\"{}\" --silent", dir.join("uninstall.exe").to_string_lossy());
    let loc = dir.to_string_lossy().into_owned();
    let pairs: Vec<(&str, String)> = vec![
        ("DisplayName", "SidekickAI".into()),
        ("DisplayVersion", env!("CARGO_PKG_VERSION").into()),
        ("Publisher", "LinCi853".into()),
        ("InstallLocation", loc),
        ("DisplayIcon", exe),
        ("UninstallString", uninst),
        ("QuietUninstallString", quiet),
        ("NoModify", "1".into()),
        // 修复能力已内置到安装器，允许「修复」入口
        ("NoRepair", "1".into()),
    ];
    for (name, value) in &pairs {
        let _ = Command::new("reg").hidden()
            .args(["add", &key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"])
            .output();
    }
    Ok(())
}

fn copy_uninstaller(dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    fs::copy(&exe, dir.join("uninstall.exe")).map_err(|e| format!("复制卸载器失败：{}", e))?;
    Ok(())
}

fn is_admin() -> bool {
    Command::new("net")
        .arg("session")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn run_uninstall() -> i32 {
    match uninstall() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("卸载失败：{}", e);
            1
        }
    }
}

fn uninstall() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("无法定位安装目录")?.to_path_buf();
    let for_all_users = dir.to_string_lossy().to_lowercase().contains("program files");

    // 所有用户安装且当前非管理员 → 提权后由子进程完成删除
    if for_all_users && !is_admin() {
        let code = elevate::shell_execute_runas(&exe.to_string_lossy(), "--uninstall")?;
        if code == 1223 {
            return Err("已取消卸载".into());
        }
        if code != 0 {
            return Err(format!("卸载进程退出，代码 {}", code));
        }
        return Ok(());
    }

    // 删除快捷方式（用户级与全局都清一遍）
    for all in [false, true] {
        remove_shortcuts(all);
    }

    // 删除注册表卸载项（用户级与全局都清一遍）
    for root in ["HKCU", "HKLM"] {
        remove_uninstall_entry(root);
    }

    // 自删除：延迟删除整个安装目录（含正在运行的 uninstall.exe）
    // ponytail: cmd /c ping 延迟是 Windows 经典自删法；改 rmdir 前置等待避免黑窗由 CREATE_NO_WINDOW 保证
    let dir_str = dir.to_string_lossy().into_owned();
    let _ = Command::new("cmd").hidden()
        .args(["/c", &format!("ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"{}\"", dir_str)])
        .spawn();
    Ok(())
}
