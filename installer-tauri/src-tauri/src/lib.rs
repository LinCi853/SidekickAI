// lib.rs —— Tauri 安装向导：命令 + 事件 + 提权子进程入口
mod elevate;
mod engine;
mod manifest;
mod transaction;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct RequestGuard(std::path::PathBuf);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static ALLOW_CLOSE: AtomicBool = AtomicBool::new(false);
/// 安装成功、用户勾选「向导关闭后启动」时记录的目标程序：(exe 路径, 启动参数)
/// 在窗口真正关闭（完成按钮 / 右上角 ✕）时才启动，避免安装完成即打开应用。
static PENDING_LAUNCH: Mutex<Option<(String, String)>> = Mutex::new(None);

#[tauri::command]
fn get_info() -> manifest::InstallerInfo {
    manifest::build_info()
}

#[tauri::command]
fn scan_installations() -> manifest::ScanResult {
    engine::scan_installations()
}

#[tauri::command]
fn needs_admin(dir: String, for_all_users: bool) -> bool {
    elevate::needs_admin(&dir, for_all_users)
}

#[tauri::command]
fn browse_dir(app: AppHandle, current: String) -> String {
    use tauri_plugin_dialog::DialogExt;
    if let Some(fp) = app.dialog().file().blocking_pick_folder() {
        if let Ok(p) = fp.into_path() {
            return p.to_string_lossy().into_owned();
        }
    }
    current
}

/// 保存文件对话框：返回完整保存路径；用户取消返回空字符串
/// 用于卸载时导出备份（加密 .sabackup / 明文 .zip），默认文件名带时间戳
#[tauri::command]
fn save_backup_dialog(app: AppHandle, default_name: String) -> String {
    use tauri_plugin_dialog::DialogExt;
    let mut dlg = app.dialog().file();
    if default_name.to_ascii_lowercase().ends_with(".zip") {
        dlg = dlg.add_filter("Zip 备份", &["zip"]);
    } else {
        dlg = dlg.add_filter("SidekickAI 加密备份", &["sabackup"]);
    }
    if let Some(fp) = dlg.set_file_name(&default_name).blocking_save_file() {
        return fp.to_string();
    }
    String::new()
}

#[tauri::command]
fn close_window(window: tauri::Window) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err("请等待当前操作完成后再关闭".into());
    }
    if let Some((exe, arg)) = PENDING_LAUNCH.lock().unwrap().take() {
        std::process::Command::new(&exe)
            .arg(&arg)
            .spawn()
            .map_err(|error| format!("无法启动开源版：{}", error))?;
    }
    ALLOW_CLOSE.store(true, Ordering::SeqCst);
    window.close().map_err(|error| {
        ALLOW_CLOSE.store(false, Ordering::SeqCst);
        error.to_string()
    })
}

#[tauri::command]
fn open_dir(dir: String) {
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
}

#[tauri::command]
fn cancel() -> bool {
    CANCELLED.store(true, Ordering::SeqCst);
    if std::fs::write(engine::cancel_path(), b"cancel").is_err() {
        return false;
    }
    true
}

/// 读取已安装位置的 install-config.json（覆盖安装/修复时预读作初始值）
#[tauri::command]
fn read_install_config(dir: String) -> Option<serde_json::Value> {
    engine::read_install_config(std::path::Path::new(&dir))
}

/// 完成页更新待启动程序（以完成页最终勾选为准，覆盖安装开始时的快照）
#[tauri::command]
fn set_pending_launch(install_dir: String, launch: bool, show_guide: bool) -> bool {
    if !launch {
        *PENDING_LAUNCH.lock().unwrap() = None;
        return true;
    }
    let exe = std::path::Path::new(&install_dir).join("SidekickAI-OpenSource.exe");
    if !exe.exists() {
        *PENDING_LAUNCH.lock().unwrap() = None;
        return false;
    }
    let arg = if show_guide {
        "--show-guide".to_string()
    } else {
        "--skip-guide".to_string()
    };
    *PENDING_LAUNCH.lock().unwrap() = Some((exe.to_string_lossy().into_owned(), arg));
    true
}

/// 用户完成/关闭向导时写入最终 install-config.json。
/// 提权策略：已提权或目录可写则直写；磁盘内容一致则跳过；仅在必须更新且不可写时才 UAC。
#[tauri::command]
async fn flush_config(opts: manifest::InstallRequest) -> Result<bool, String> {
    let mut config_opts = opts;
    config_opts.action = "flush-config".into();
    let dir = std::path::PathBuf::from(&config_opts.install_dir);

    // 已提权或目录可写 → 继承权限直接写，不再弹 UAC
    if elevate::is_process_elevated() || elevate::dir_is_writable(&dir) {
        engine::run(&config_opts)?;
        return Ok(true);
    }

    // 不可写：若磁盘已有相同配置（安装提权阶段已写入），跳过
    if engine::install_config_matches(&config_opts) {
        return Ok(true);
    }

    // 确实需要更新且当前无权限 → 才申请一次提权
    let req_path = engine::operation_root().join("request.json");
    std::fs::write(
        &req_path,
        serde_json::to_string(&config_opts).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let _request = RequestGuard(req_path.clone());
    elevate::run_elevated(&req_path)?;
    Ok(true)
}

#[tauri::command]
async fn start(app: AppHandle, mut opts: manifest::InstallRequest) -> Result<bool, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("已有安装操作正在运行".into());
    }
    struct RunningGuard;
    impl Drop for RunningGuard {
        fn drop(&mut self) {
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
    let _running = RunningGuard;
    opts.user_data_dir =
        std::path::PathBuf::from(std::env::var("APPDATA").map_err(|_| "无法确认当前用户目录")?)
            .join("sidekickai-opensource")
            .to_string_lossy()
            .into_owned();
    if engine::cancel_path().exists() {
        std::fs::remove_file(engine::cancel_path()).map_err(|error| error.to_string())?;
    }

    CANCELLED.store(false, Ordering::SeqCst);

    let req_path = engine::operation_root().join("request.json");
    let log_path = engine::log_path();
    let _request = RequestGuard(req_path.clone());
    let req_json = serde_json::to_string(&opts).map_err(|e| e.to_string())?;
    std::fs::write(&req_path, &req_json).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&log_path, "");

    // 后台 tail 线程：把 S/P 日志转成事件（父进程提权子进程 / 进程内引擎共用同一路径）
    RUNNING.store(true, Ordering::SeqCst);
    let tail_app = app.clone();
    let tail_log_path = log_path.clone();
    std::thread::spawn(move || tail_log(&tail_app, &tail_log_path));

    // 启动/指南以完成页最终勾选为准；安装结束只记录默认值，关闭向导前由 set_pending_launch 覆盖
    let launch_after = opts.launch_after_install && opts.mode == manifest::InstallMode::Install;
    let show_guide = opts.show_guide_after_install;
    let install_dir = opts.install_dir.clone();
    let mode = opts.mode;
    // 卸载/修复按模式不需要另一位置的默认清理逻辑（cleanup_paths 显式传入）
    let needs_elev = !elevate::is_process_elevated()
        && elevate::needs_admin(&opts.install_dir, opts.for_all_users);
    let req = opts;
    let req_path_for_child = req_path.clone();

    let result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        if needs_elev {
            elevate::run_elevated(&req_path_for_child)
        } else {
            engine::run(&req)
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&req_path);

    // 计算残留提示：仍有多个有效安装位置时提醒用户
    let residual_note = match &result {
        Ok(()) if mode == manifest::InstallMode::Install => {
            let scan = engine::scan_installations();
            let n = scan.locations.len();
            if n > 1 {
                format!(
                    "检测到 {} 处安装位置：{}",
                    n,
                    scan.locations
                        .iter()
                        .map(|l| l.path.as_str())
                        .collect::<Vec<_>>()
                        .join("；")
                )
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };

    match result {
        Ok(()) => {
            if launch_after {
                let exe = std::path::Path::new(&install_dir).join("SidekickAI-OpenSource.exe");
                if exe.exists() {
                    // --show-guide：安装后打开使用指南（首次启动引导窗）
                    // --skip-guide：默认跳过引导（主程序见参数即标记引导完成，不再弹出）
                    // 不立即启动：记录待启动程序，等向导关闭（完成/右上角 ✕）时才拉起
                    let arg = if show_guide {
                        "--show-guide".to_string()
                    } else {
                        "--skip-guide".to_string()
                    };
                    *PENDING_LAUNCH.lock().unwrap() =
                        Some((exe.to_string_lossy().into_owned(), arg));
                }
            }
            let _ = app.emit(
                "install-done",
                manifest::DonePayload {
                    install_dir,
                    residual_note,
                },
            );
        }
        Err(e) => {
            let _ = app.emit("install-error", e);
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
    Ok(true)
}

fn tail_log(app: &AppHandle, path: &std::path::Path) {
    use std::io::{Read, Seek, SeekFrom};
    let mut offset = 0u64;
    while RUNNING.load(Ordering::SeqCst) {
        if let Ok(meta) = std::fs::metadata(path) {
            let size = meta.len();
            if size > offset {
                if let Ok(mut file) = std::fs::File::open(path) {
                    if file.seek(SeekFrom::Start(offset)).is_ok() {
                        let mut buf = String::new();
                        if file.read_to_string(&mut buf).is_ok() {
                            for line in buf.lines() {
                                if let Some(rest) = line.strip_prefix("S|") {
                                    let _ = app.emit("install-status", rest);
                                } else if let Some(rest) = line.strip_prefix("P|") {
                                    if let Ok(p) = rest.parse::<u32>() {
                                        let _ = app.emit("install-progress", p);
                                    }
                                }
                            }
                            offset = size;
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if RUNNING.load(Ordering::SeqCst) || !ALLOW_CLOSE.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("installer-close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            scan_installations,
            needs_admin,
            browse_dir,
            save_backup_dialog,
            close_window,
            open_dir,
            cancel,
            start,
            read_install_config,
            flush_config,
            set_pending_launch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 提权子进程入口：读取请求 JSON 并执行安装，把结果写入 result 文件。
pub fn run_elevated_install(req_path: &str) -> i32 {
    let Some(root) = std::path::Path::new(req_path).parent() else {
        return 1;
    };
    if engine::set_operation_root(root.to_path_buf()).is_err() {
        return 1;
    }

    let _request = RequestGuard(std::path::PathBuf::from(req_path));
    let result = match std::fs::read_to_string(req_path) {
        Ok(s) => match serde_json::from_str::<manifest::InstallRequest>(&s) {
            Ok(req) => engine::run(&req),
            Err(e) => Err(format!("解析安装请求失败：{}", e)),
        },
        Err(e) => Err(format!("读取安装请求失败：{}", e)),
    };
    let res = match &result {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let _ = std::fs::write(engine::result_path(), res.to_string());
    if result.is_ok() {
        0
    } else {
        1
    }
}

pub fn run_uninstall() -> i32 {
    engine::run_uninstall()
}
