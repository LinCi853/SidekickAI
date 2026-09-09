// lib.rs —— Tauri 安装向导：命令 + 事件 + 提权子进程入口
mod elevate;
mod engine;
mod manifest;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

pub static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

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

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

#[tauri::command]
fn open_dir(dir: String) {
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
}

#[tauri::command]
fn cancel() -> bool {
    CANCELLED.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
async fn start(app: AppHandle, opts: manifest::InstallRequest) -> Result<bool, String> {
    CANCELLED.store(false, Ordering::SeqCst);

    let req_path = std::env::temp_dir().join("SidekickAI-install-request.json");
    let log_path = engine::log_path();
    let req_json = serde_json::to_string(&opts).map_err(|e| e.to_string())?;
    std::fs::write(&req_path, &req_json).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&log_path, "");

    // 后台 tail 线程：把 S/P 日志转成事件（父进程提权子进程 / 进程内引擎共用同一路径）
    RUNNING.store(true, Ordering::SeqCst);
    let tail_app = app.clone();
    let tail_log_path = log_path.clone();
    std::thread::spawn(move || tail_log(&tail_app, &tail_log_path));

    let launch_after = opts.launch_after_install && opts.mode == manifest::InstallMode::Install;
    let install_dir = opts.install_dir.clone();
    let mode = opts.mode;
    // 卸载/修复按模式不需要另一位置的默认清理逻辑（cleanup_paths 显式传入）
    let needs_elev = elevate::needs_admin(&opts.install_dir, opts.for_all_users)
        || opts.cleanup_paths.iter().any(|p| {
            elevate::needs_admin(p, true)
        })
        || (opts.mode == manifest::InstallMode::Install && {
            let other_dir = if opts.for_all_users {
                engine::user_install_dir()
            } else {
                engine::system_install_dir()
            };
            other_dir.exists() && elevate::needs_admin(&other_dir.to_string_lossy(), true)
        });
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

    // 计算残留提示：仍有多个有效安装位置时提醒用户
    let residual_note = match &result {
        Ok(()) if mode == manifest::InstallMode::Install => {
            let scan = engine::scan_installations();
            let n = scan.locations.len();
            if n > 1 {
                format!("检测到 {} 处安装位置：{}", n, scan.locations.iter().map(|l| l.path.as_str()).collect::<Vec<_>>().join("；"))
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };

    match result {
        Ok(()) => {
            if launch_after {
                let exe = std::path::Path::new(&install_dir).join("SidekickAI.exe");
                if exe.exists() {
                    let _ = std::process::Command::new(&exe).spawn();
                }
            }
            let _ = app.emit("install-done", manifest::DonePayload { install_dir, residual_note });
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
        .invoke_handler(tauri::generate_handler![
            get_info,
            scan_installations,
            needs_admin,
            browse_dir,
            close_window,
            open_dir,
            cancel,
            start
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 提权子进程入口：读取请求 JSON 并执行安装，把结果写入 result 文件。
pub fn run_elevated_install(req_path: &str) -> i32 {
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
