use crate::elevate;
use crate::manifest::{self, InstallLocation, InstallMode, InstallRequest, ScanResult};
use crate::transaction::{self, Ownership, EDITION, EXECUTABLE, OWNER};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static OPERATION_ROOT: OnceLock<PathBuf> = OnceLock::new();
pub fn operation_root() -> &'static PathBuf {
    OPERATION_ROOT.get_or_init(|| {
        let base = std::env::temp_dir().join("SidekickAI-OpenSource-operation");
        let root = transaction::sibling(&base, "session").expect("operation identifier");
        fs::create_dir_all(&root).expect("operation directory");
        root
    })
}
pub fn set_operation_root(path: PathBuf) -> Result<(), String> {
    transaction::plain_path(&path)?;
    OPERATION_ROOT
        .set(path)
        .map_err(|_| "安装事务目录已初始化".into())
}
pub fn log_path() -> PathBuf {
    operation_root().join("install.log")
}
pub fn result_path() -> PathBuf {
    operation_root().join("result.json")
}
pub fn cancel_path() -> PathBuf {
    operation_root().join("cancel")
}
fn write_log(line: &str) {
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(file, "{}", line);
    }
}
pub fn status(message: &str) {
    write_log(&format!("S|{}", message));
}
pub fn progress(value: u32) {
    write_log(&format!("P|{}", value));
}
fn cancelled() -> Result<(), String> {
    if cancel_path().exists() {
        Err("已取消，原安装和用户数据未删除".into())
    } else {
        Ok(())
    }
}
trait CommandHidden {
    fn hidden(&mut self) -> &mut Command;
}
impl CommandHidden for Command {
    fn hidden(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000)
    }
}
fn powershell(script: &str, executable: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new("powershell.exe");
    command
        .hidden()
        .args(["-NoProfile", "-NonInteractive", "-Command", script]);
    if let Some(executable) = executable {
        command.env("SIDEKICK_TARGET_EXECUTABLE", executable);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
fn running_pid(dir: &Path) -> Result<u32, String> {
    let script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter \"Name='SidekickAI-OpenSource.exe'\" | Where-Object { $_.ExecutablePath -eq $env:SIDEKICK_TARGET_EXECUTABLE -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1; if ($p) {$p.ProcessId} else {0}";
    powershell(script, Some(&dir.join(EXECUTABLE)))?
        .parse()
        .map_err(|_| "无法确认应用进程身份".into())
}
fn close_running(dir: &Path) -> Result<(), String> {
    if running_pid(dir)? == 0 {
        return Ok(());
    }
    status("正在等待开源版保存并退出…");
    let script = r#"$ErrorActionPreference='Stop';
$session=(Get-Process -Id $PID).SessionId;
$namespace=$env:USERPROFILE.ToLower()+'|'+$session;
if ($env:SIDEKICK_TEST_SESSION) { $namespace='test:'+$env:SIDEKICK_TEST_SESSION }
$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($namespace))).Replace('-','').ToLower().Substring(0,24);
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.', 'sidekick-editions-'+$hash, [IO.Pipes.PipeDirection]::InOut);
try {
  $pipe.Connect(1500);
  $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),1024,$true); $writer.AutoFlush=$true;
  $reader=[IO.StreamReader]::new($pipe);
  $writer.WriteLine((@{protocol=1; edition='open-source'; action='shutdown'; executable=$env:SIDEKICK_TARGET_EXECUTABLE}|ConvertTo-Json -Compress));
  $responseTask=$reader.ReadLineAsync();
  if (-not $responseTask.Wait(3000)) { throw '保存退出请求响应超时' }
  $response=$responseTask.Result|ConvertFrom-Json;
  if ($response.protocol -ne 1 -or $response.edition -ne 'open-source' -or $response.status -ne 'yielding') {throw '当前应用不能安全退出，请先完成保存或数据恢复'}
} finally {$pipe.Dispose()}
"#;
    powershell(script, Some(&dir.join(EXECUTABLE)))
        .map_err(|error| format!("未强制结束应用。请保存并退出开源版后重试：{}", error))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        cancelled()?;
        if running_pid(dir)? == 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("开源版尚未完成保存退出，安装目录保持不变".into())
}

fn registry_key(all: bool) -> String {
    if let Ok(token) = std::env::var("SIDEKICK_INSTALL_TEST_REGISTRY") {
        if token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return format!(
                "HKCU\\Software\\SidekickAI-OpenSource\\InstallerTests\\{}\\{}",
                token,
                if all { "machine" } else { "user" }
            );
        }
    }
    format!(
        "{}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SidekickAI-OpenSource",
        if all { "HKLM" } else { "HKCU" }
    )
}
fn registry_exists(all: bool) -> bool {
    Command::new("reg.exe")
        .hidden()
        .args(["query", &registry_key(all)])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
fn registry_value(all: bool, name: &str) -> Option<String> {
    let output = Command::new("reg.exe")
        .hidden()
        .args(["query", &registry_key(all), "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains(name) && line.contains("REG_SZ"))
        .and_then(|line| {
            line.split_once("REG_SZ")
                .map(|(_, value)| value.trim().to_string())
        })
}
fn check_registration(req: &InstallRequest) -> Result<(), String> {
    if let Some(existing) = registry_value(req.for_all_users, "InstallLocation") {
        if transaction::path_identity(Path::new(&existing))?
            != transaction::path_identity(Path::new(&req.install_dir))?
        {
            return Err(format!(
                "此范围已登记开源版目录 {}，请选择该目录维护或先卸载它",
                existing
            ));
        }
    }
    Ok(())
}
fn candidate_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut result = vec![
        (system_install_dir(), "program-files"),
        (user_install_dir(), "local-programs"),
    ];
    for all in [false, true] {
        if let Some(path) = registry_value(all, "InstallLocation") {
            result.push((PathBuf::from(path), "registered"));
        }
    }
    if let Some(target) = uninstall_target() {
        result.insert(0, (target, "uninstall"));
    }
    result
}
pub fn scan_installations() -> ScanResult {
    let mut seen = std::collections::HashSet::new();
    let mut locations = Vec::new();
    for (path, source) in candidate_dirs() {
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            continue;
        }
        if let Ok(owner) = transaction::ownership(&path) {
            locations.push(InstallLocation {
                for_all_users: owner.for_all_users,
                path: path.to_string_lossy().into_owned(),
                source: source.into(),
                version: owner.version,
                arch: owner.arch,
                registered: registry_value(owner.for_all_users, "InstallLocation")
                    .map(|value| value.eq_ignore_ascii_case(&path.to_string_lossy()))
                    .unwrap_or(false),
                running_pid: running_pid(&path).unwrap_or(0),
                recommended_for_cleanup: false,
            });
        }
    }
    ScanResult {
        recommended_dir: locations
            .first()
            .map(|location| location.path.clone())
            .unwrap_or_else(|| user_install_dir().to_string_lossy().into_owned()),
        residual_hint: if locations.len() > 1 {
            "发现多个开源版目录；本次仅处理选定目录，其余目录保留".into()
        } else {
            String::new()
        },
        locations,
        fixed_drives: Vec::new(),
    }
}

struct InstallLock {
    _file: fs::File,
}

#[cfg(test)]
mod safety_tests {
    use super::*;

    #[test]
    fn path_aliases_cannot_acquire_competing_install_locks() {
        let root =
            transaction::sibling(&std::env::temp_dir().join("installer-lock-test"), "fixture")
                .unwrap();
        let target = root.join("installed");
        fs::create_dir_all(&target).unwrap();
        let first = acquire_install_lock(&target).unwrap();
        assert!(
            acquire_install_lock(Path::new(&target.to_string_lossy().replace('\\', "/"))).is_err()
        );
        assert!(acquire_install_lock(&fs::canonicalize(&target).unwrap()).is_err());
        drop(first);
        drop(acquire_install_lock(&target).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
fn acquire_install_lock(target: &Path) -> Result<InstallLock, String> {
    use sha2::{Digest, Sha256};
    use std::os::windows::fs::OpenOptionsExt;
    let hash = format!(
        "{:x}",
        Sha256::digest(
            transaction::path_identity(target)?
                .to_string_lossy()
                .as_bytes()
        )
    );
    let lock = target
        .parent()
        .ok_or("缺少父目录")?
        .join(format!(".sidekick-open-source-{}.lock", &hash[..16]));
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(lock)
        .map(|file| InstallLock { _file: file })
        .map_err(|error| format!("另一安装操作正在使用此目录，或目录不可写：{}", error))
}

fn validate_request(req: &InstallRequest) -> Result<PathBuf, String> {
    let target = PathBuf::from(&req.install_dir);
    transaction::plain_path(&target)?;
    let profile =
        PathBuf::from(std::env::var("APPDATA").map_err(|_| "无法确认用户数据目录")?).join(EDITION);
    if transaction::paths_overlap(&target, &profile)? {
        return Err("安装目录与用户数据目录必须相互独立，请选择其他安装位置".into());
    }
    if !req.cleanup_paths.is_empty() {
        return Err("本次仅维护选定的开源版目录，不自动清理其他位置".into());
    }
    if let Some(owner) = transaction::destination(&target)? {
        if owner.for_all_users != req.for_all_users {
            return Err("安装范围与原目录不一致，请选择原有用户范围".into());
        }
    }
    check_registration(req)?;
    Ok(target)
}

pub fn run(req: &InstallRequest) -> Result<(), String> {
    let target = validate_request(req)?;
    fs::create_dir_all(target.parent().ok_or("缺少父目录")?).map_err(|error| error.to_string())?;
    let _lock = acquire_install_lock(&target)?;
    transaction::ensure_no_pending_transaction(&target)?;
    cancelled()?;
    if req.action == "flush-config" {
        return flush_install_config(req);
    }
    match req.mode {
        InstallMode::Uninstall => run_uninstall_request(req),
        InstallMode::Repair | InstallMode::Install => run_install(req),
    }
}

fn run_install(req: &InstallRequest) -> Result<(), String> {
    let target = PathBuf::from(&req.install_dir);
    let old = transaction::destination(&target)?;
    if req.mode == InstallMode::Repair && old.is_none() {
        return Err("未找到属于开源版的安装标记，不能执行修复".into());
    }
    progress(3);
    status("正在校验安装文件…");
    let (payload, sevenz) = locate_payload().ok_or("未找到完整安装载荷，请使用开源版完整安装包")?;
    let staging = transaction::sibling(&target, "staging")?;
    let extracted = extract_to_staging(&payload, &sevenz, &staging)?;
    let result = (|| -> Result<(), String> {
        let payload = transaction::validate_payload(&extracted, manifest::host_arch())?;
        cancelled()?;
        close_running(&target)?;
        cancelled()?;
        let owner = Ownership {
            schema: 1,
            edition: EDITION.into(),
            version: payload.version,
            arch: payload.arch,
            for_all_users: req.for_all_users,
        };
        fs::write(
            extracted.join(OWNER),
            serde_json::to_vec_pretty(&owner).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        write_install_config(req, &extracted)?;
        write_plugins_manifest(req, &extracted)?;
        copy_uninstaller(&extracted)?;
        let integration = IntegrationBackup::capture(req)?;
        progress(85);
        status("正在提交完整运行文件…");
        transaction::replace_install(
            &extracted,
            &target,
            &integration.directory,
            || register_uninstall(req, &target).and_then(|_| create_shortcuts(req, &target)),
            || integration.restore(req),
        )?;
        status("开源版安装完成，用户数据与另一版本均已保留");
        progress(100);
        Ok(())
    })();
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| {
            format!(
                "临时文件保留在 {}：{}；原结果：{:?}",
                staging.display(),
                error,
                result
            )
        })?;
    }
    result
}

fn data_root(req: &InstallRequest) -> Result<PathBuf, String> {
    let root = PathBuf::from(std::env::var("APPDATA").map_err(|_| "无法确认当前用户的数据目录")?)
        .join(EDITION);
    if !req.user_data_dir.is_empty()
        && !root
            .to_string_lossy()
            .eq_ignore_ascii_case(&req.user_data_dir)
    {
        return Err("提权后的用户身份与原用户不一致；请选择保留数据，或以原用户执行卸载".into());
    }
    transaction::plain_path(&root)?;
    Ok(root)
}
fn export_via_main_app(
    install_dir: &Path,
    req: &InstallRequest,
    data: &Path,
) -> Result<(), String> {
    let backup = PathBuf::from(&req.backup_path);
    transaction::plain_path(&backup)?;
    if transaction::paths_overlap(&backup, install_dir)?
        || transaction::paths_overlap(&backup, data)?
    {
        return Err("备份必须保存在安装目录和用户数据目录之外".into());
    }
    if backup.exists() {
        return Err("备份文件已存在，请选择新文件名，避免覆盖已有备份".into());
    }
    if req.backup_encrypt && req.backup_password.is_empty() {
        return Err("请设置备份密码".into());
    }
    fs::create_dir_all(backup.parent().ok_or("缺少备份目录")?)
        .map_err(|error| error.to_string())?;
    let request = operation_root().join("export.json");
    let result = operation_root().join("export-result.json");
    let options = serde_json::json!({ "outputPath": backup, "resultPath": result, "encrypt": req.backup_encrypt, "password": req.backup_password,
        "categories": ["basicData", "cookies", "indexedDB", "cache"], "expectedDataRoot": data });
    fs::write(&request, options.to_string()).map_err(|error| error.to_string())?;
    let outcome = Command::new(install_dir.join(EXECUTABLE))
        .hidden()
        .args(["--export-user-data", &request.to_string_lossy()])
        .env("SIDEKICK_DATA_DIR", data)
        .status();
    fs::remove_file(&request).map_err(|error| error.to_string())?;
    let success = outcome.map_err(|error| error.to_string())?.success();
    let response: serde_json::Value = serde_json::from_slice(
        &fs::read(&result).map_err(|error| format!("未收到有效导出结果：{}", error))?,
    )
    .map_err(|error| error.to_string())?;
    if !success
        || response["ok"] != true
        || response["verified"] != true
        || response["dataRoot"]
            .as_str()
            .map(|root| !root.eq_ignore_ascii_case(&data.to_string_lossy()))
            .unwrap_or(true)
    {
        return Err(format!(
            "导出未通过验证，用户数据和安装均已保留：{}",
            response
        ));
    }
    if !backup.is_file() {
        return Err("导出文件不存在，已中止卸载".into());
    }
    Ok(())
}
fn run_uninstall_request(req: &InstallRequest) -> Result<(), String> {
    let target = PathBuf::from(&req.install_dir);
    transaction::ownership(&target)?;
    let strategy = if req.data_strategy.is_empty() {
        if req.delete_user_data {
            "delete"
        } else {
            "keep"
        }
    } else {
        &req.data_strategy
    };
    if !["keep", "delete", "export"].contains(&strategy) {
        return Err("未知的卸载数据策略".into());
    }
    close_running(&target)?;
    let data = if strategy == "keep" {
        PathBuf::new()
    } else {
        data_root(req)?
    };
    if strategy != "keep" && data.exists() {
        transaction::plain_tree(&data)?;
        let identity: serde_json::Value = serde_json::from_slice(
            &fs::read(data.join("edition-identity.json"))
                .map_err(|_| "数据目录缺少开源版归属标记，请先运行新版或选择保留数据")?,
        )
        .map_err(|error| error.to_string())?;
        if identity["edition"] != EDITION || identity["schema"] != 1 {
            return Err("拒绝删除不属于开源版的数据".into());
        }
        if strategy == "export" {
            export_via_main_app(&target, req, &data)?;
        }
        transaction::ensure_unlocked(&data)?;
    }
    cancelled()?;
    transaction::ensure_unlocked(&target)?;
    let backup = transaction::sibling(&target, "uninstall-recovery")?;
    let data_backup = if strategy != "keep" && data.exists() {
        Some(transaction::sibling(&data, "uninstall-recovery")?)
    } else {
        None
    };
    let integration = IntegrationBackup::capture(req)?;
    let journal = target
        .parent()
        .ok_or("缺少父目录")?
        .join(".sidekick-open-source-uninstall.json");
    if journal.exists() {
        return Err(format!("请先检查未完成的卸载事务：{}", journal.display()));
    }
    let record = serde_json::json!({ "schema": 1, "edition": EDITION, "target": target, "backup": backup, "data": data, "dataBackup": data_backup, "integration": integration.directory });
    use std::io::Write;
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
    if let Err(error) = fs::rename(&target, &backup) {
        let _ = fs::remove_file(&journal);
        return Err(error.to_string());
    }
    let commit = (|| -> Result<(), String> {
        if let Some(backup) = &data_backup {
            fs::rename(&data, backup).map_err(|error| error.to_string())?;
        }
        remove_shortcuts(req.for_all_users)?;
        remove_uninstall_entry(req.for_all_users)?;
        Ok(())
    })();
    if let Err(error) = commit {
        fs::rename(&backup, &target).map_err(|restore| {
            format!(
                "{}；安装恢复目录：{}（{}）",
                error,
                backup.display(),
                restore
            )
        })?;
        if let Some(backup) = &data_backup {
            if backup.exists() {
                fs::rename(backup, &data).map_err(|restore| {
                    format!("{}；数据保留在 {}：{}", error, backup.display(), restore)
                })?;
            }
        }
        integration.restore(req)?;
        fs::remove_file(&journal).map_err(|error| error.to_string())?;
        return Err(error);
    }
    fs::remove_dir_all(&backup).map_err(|error| {
        format!(
            "卸载登记已完成，剩余安装文件位于 {}：{}",
            backup.display(),
            error
        )
    })?;
    if let Some(backup) = data_backup {
        fs::remove_dir_all(&backup).map_err(|error| {
            format!("应用已卸载，用户数据保留在 {}：{}", backup.display(), error)
        })?;
    }
    progress(100);
    fs::remove_file(&journal).map_err(|error| format!("卸载完成，事务记录保留：{}", error))?;
    status(if strategy == "keep" {
        "开源版已卸载，用户数据已保留"
    } else {
        "开源版已卸载，指定的开源版用户数据已移除"
    });
    Ok(())
}

pub fn read_install_config(dir: &Path) -> Option<serde_json::Value> {
    transaction::ownership(dir).ok()?;
    serde_json::from_slice(&fs::read(dir.join("install-config.json")).ok()?).ok()
}
pub fn flush_install_config(req: &InstallRequest) -> Result<(), String> {
    let target = validate_request(req)?;
    transaction::ownership(&target)?;
    write_install_config(req, &target)
}
pub fn install_config_matches(req: &InstallRequest) -> bool {
    read_install_config(Path::new(&req.install_dir))
        .map(|value| value == build_install_config_json(req))
        .unwrap_or(false)
}
fn desktop_dir(all: bool) -> PathBuf {
    PathBuf::from(std::env::var(if all { "PUBLIC" } else { "USERPROFILE" }).unwrap_or_default())
        .join("Desktop")
}
fn start_menu_dir(all: bool) -> PathBuf {
    PathBuf::from(std::env::var(if all { "ProgramData" } else { "APPDATA" }).unwrap_or_default())
        .join("Microsoft/Windows/Start Menu/Programs/SidekickAI-OpenSource")
}
fn shortcut_paths(all: bool) -> Vec<PathBuf> {
    vec![
        desktop_dir(all).join("SidekickAI-OpenSource.lnk"),
        start_menu_dir(all).join("SidekickAI-OpenSource.lnk"),
    ]
}
fn create_shortcuts(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let links = shortcut_paths(req.for_all_users);
    for (index, link) in links.iter().enumerate() {
        if index == 0 && !req.create_desktop_shortcut {
            if link.exists() {
                fs::remove_file(link).map_err(|error| error.to_string())?;
            }
            continue;
        }
        fs::create_dir_all(link.parent().ok_or("缺少快捷方式目录")?)
            .map_err(|error| error.to_string())?;
        create_shortcut(
            link,
            &dir.join(EXECUTABLE).to_string_lossy(),
            &dir.to_string_lossy(),
        )?;
    }
    Ok(())
}
fn remove_shortcuts(all: bool) -> Result<(), String> {
    for path in shortcut_paths(all) {
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    let directory = start_menu_dir(all);
    if directory.is_dir()
        && fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
    {
        fs::remove_dir(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn remove_uninstall_entry(all: bool) -> Result<(), String> {
    if !registry_exists(all) {
        return Ok(());
    }
    let result = Command::new("reg.exe")
        .hidden()
        .args(["delete", &registry_key(all), "/f"])
        .output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err("无法移除开源版卸载登记".into());
    }
    Ok(())
}
fn register_uninstall(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let values = [
        (
            "DisplayName",
            "工百窗开源版 / SidekickAI Open Source".into(),
        ),
        ("DisplayVersion", env!("CARGO_PKG_VERSION").into()),
        ("Publisher", "LinCi853".into()),
        ("InstallLocation", dir.to_string_lossy().into_owned()),
        (
            "DisplayIcon",
            dir.join(EXECUTABLE).to_string_lossy().into_owned(),
        ),
        (
            "UninstallString",
            format!("\"{}\" --uninstall", dir.join("uninstall.exe").display()),
        ),
    ];
    for (name, value) in values {
        let output = Command::new("reg.exe")
            .hidden()
            .args([
                "add",
                &registry_key(req.for_all_users),
                "/v",
                name,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!("写入开源版卸载登记失败：{}", name));
        }
    }
    Ok(())
}
#[derive(serde::Serialize)]
struct IntegrationBackup {
    directory: PathBuf,
    registry: Option<PathBuf>,
    links: Vec<(PathBuf, Option<Vec<u8>>)>,
}
impl IntegrationBackup {
    fn capture(req: &InstallRequest) -> Result<Self, String> {
        check_registration(req)?;
        let directory = transaction::sibling(&operation_root().join("integration"), "snapshot")?;
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        let mut links = Vec::new();
        for link in shortcut_paths(req.for_all_users) {
            transaction::plain_path(&link)?;
            let bytes = if link.exists() {
                Some(fs::read(&link).map_err(|error| error.to_string())?)
            } else {
                None
            };
            links.push((link, bytes));
        }
        let registry = if registry_exists(req.for_all_users) {
            let file = directory.join("registration.reg");
            let output = Command::new("reg.exe")
                .hidden()
                .args([
                    "export",
                    &registry_key(req.for_all_users),
                    &file.to_string_lossy(),
                    "/y",
                ])
                .output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err("无法备份现有开源版卸载登记".into());
            }
            Some(file)
        } else {
            None
        };
        let snapshot = Self {
            directory,
            registry,
            links,
        };
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(snapshot.directory.join("integration.json"))
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(snapshot)
    }
    fn restore(&self, req: &InstallRequest) -> Result<(), String> {
        remove_uninstall_entry(req.for_all_users)?;
        if let Some(file) = &self.registry {
            let output = Command::new("reg.exe")
                .hidden()
                .args(["import", &file.to_string_lossy()])
                .output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(format!("登记备份保留在 {}", file.display()));
            }
        }
        for (path, bytes) in &self.links {
            if let Some(bytes) = bytes {
                fs::create_dir_all(path.parent().ok_or("缺少快捷方式目录")?)
                    .map_err(|error| error.to_string())?;
                fs::write(path, bytes).map_err(|error| error.to_string())?;
            } else if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}
fn copy_uninstaller(dir: &Path) -> Result<(), String> {
    fs::copy(
        std::env::current_exe().map_err(|error| error.to_string())?,
        dir.join("uninstall.exe"),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
pub fn uninstall_target() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == "--uninstall-target")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
}
pub fn run_uninstall() -> i32 {
    let result = (|| -> Result<(), String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let target = executable.parent().ok_or("无法定位安装目录")?;
        transaction::ownership(target)?;
        let copy = operation_root().join("SidekickAI-OpenSource-Uninstall.exe");
        fs::copy(&executable, &copy).map_err(|error| error.to_string())?;
        Command::new(copy)
            .args(["--uninstall-target", &target.to_string_lossy()])
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{}", error);
        1
    } else {
        0
    }
}

fn locate_payload() -> Option<(PathBuf, PathBuf)> {
    extract_embedded()
}

/// Decode an embedded archive and extractor with a checksum-bearing footer.
fn extract_embedded() -> Option<(PathBuf, PathBuf)> {
    use std::io::{Read, Seek, SeekFrom};

    write_log("I|开始从单文件尾部提取安装载荷");
    let exe = std::env::current_exe().ok()?;
    let mut f = std::fs::File::open(&exe).ok()?;
    let file_size = f.metadata().ok()?.len();
    write_log(&format!("I|安装器文件大小：{} B", file_size));
    if file_size < 92 {
        return None;
    }
    f.seek(SeekFrom::End(-4)).ok()?;
    let mut fl = [0u8; 4];
    f.read_exact(&mut fl).ok()?;
    let footer_len = u32::from_le_bytes(fl) as u64;
    if footer_len != 92 || footer_len > file_size {
        return None;
    }
    f.seek(SeekFrom::End(-(footer_len as i64))).ok()?;
    let mut footer = vec![0u8; footer_len as usize];
    f.read_exact(&mut footer).ok()?;
    if &footer[0..8] != b"SKOSPK01" {
        return None;
    }
    let payload_len = u64::from_le_bytes(footer[8..16].try_into().ok()?) as usize;
    let sevenz_len = u64::from_le_bytes(footer[16..24].try_into().ok()?) as usize;
    let suffix_len = (footer_len as usize)
        .checked_add(sevenz_len)?
        .checked_add(payload_len)?;
    if suffix_len > file_size as usize {
        write_log("E|安装器尾部载荷长度超出文件范围");
        return None;
    }
    let payload_off = file_size as usize - suffix_len;
    write_log(&format!(
        "I|载荷偏移：{}，payload：{} B，7zr：{} B",
        payload_off, payload_len, sevenz_len
    ));

    let dir = operation_root().join("payload");
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
    use sha2::{Digest, Sha256};
    for (file, expected) in [
        (&payload_path, &footer[24..56]),
        (&sevenz_path, &footer[56..88]),
    ] {
        let actual = Sha256::digest(std::fs::read(file).ok()?);
        if actual.as_slice() != expected {
            write_log("E|安装载荷校验失败");
            return None;
        }
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

fn extract_to_staging(payload: &Path, sevenz: &Path, staging: &Path) -> Result<PathBuf, String> {
    let subdir = if manifest::host_arch() == "arm64" {
        "win-arm64-unpacked"
    } else {
        "win-unpacked"
    };
    status("正在解压安装文件…");
    if staging.exists() {
        return Err("临时目录已存在，拒绝覆盖".into());
    }
    fs::create_dir_all(staging).map_err(|e| format!("无法创建临时目录：{}", e))?;

    let mut child = Command::new(sevenz)
        .hidden()
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

fn build_install_config_json(req: &InstallRequest) -> serde_json::Value {
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
    serde_json::json!({ "schemaVersion": 1, "modules": modules, "options": options })
}

fn write_install_config(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let config = build_install_config_json(req);
    fs::write(
        dir.join("install-config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("写入 install-config.json 失败：{}", e))?;
    Ok(())
}

fn write_plugins_manifest(req: &InstallRequest, dir: &Path) -> Result<(), String> {
    let wb = req
        .features
        .get("whiteboard")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    fs::write(
        dir.join("plugins-manifest.json"),
        format!("{{\"whiteboard\":{{\"installed\":{}}}}}\n", wb),
    )
    .map_err(|e| format!("写入 plugins-manifest.json 失败：{}", e))?;
    Ok(())
}

pub fn system_install_dir() -> PathBuf {
    let base = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    PathBuf::from(base.trim_end_matches('\\')).join("SidekickAI-OpenSource")
}

pub fn user_install_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| {
            std::env::var("USERPROFILE")
                .map(|p| format!("{}\\AppData\\Local", p.trim_end_matches('\\')))
        })
        .unwrap_or_else(|_| "C:\\Users\\Default\\AppData\\Local".into());
    PathBuf::from(base.trim_end_matches('\\'))
        .join("Programs")
        .join("SidekickAI-OpenSource")
}

fn create_shortcut(lnk: &Path, target: &str, workdir: &str) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
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
        let pf: IPersistFile = link
            .cast()
            .map_err(|e| format!("cast IPersistFile 失败：{}", e))?;
        pf.Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("保存快捷方式失败：{}", e))?;
    }
    Ok(())
}
