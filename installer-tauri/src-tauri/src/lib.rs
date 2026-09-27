// lib.rs —— Tauri 安装向导：命令 + 事件 + 提权子进程入口
//
// 备份导出（zip / SABK AES-256-GCM）由 installer-shared 的共享卸载实现负责；
// 向导本身只写安装配置并驱动安装引擎，因此这里不保留独立的加密模块。
mod cloud;
mod application_launch;
mod controller;
mod elevate;
mod engine;
mod manifest;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub use controller::RUNNING;

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

/// 安装/修复仍在进行时窗口必须保持打开；关闭后再由 PENDING_LAUNCH 决定是否启动。
fn is_busy(host: &sidekickai_uninstall_host::Host) -> bool {
    RUNNING.load(Ordering::SeqCst) || host.is_running()
}

fn prevent_close_while_busy(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Shared uninstall protection first, then install/repair state. Both cover
    // Alt+F4 and the window ✕ because both arrive as CloseRequested.
    sidekickai_uninstall_host::prevent_close_while_running(window, event);
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if RUNNING.load(Ordering::SeqCst) {
            api.prevent_close();
        }
    }
}

#[tauri::command]
async fn close_window(
    window: tauri::Window,
    host: tauri::State<'_, sidekickai_uninstall_host::Host>,
) -> Result<bool, String> {
    // While an install, a repair or an uninstall worker is busy neither closure
    // nor the deferred app launch is allowed: the operation must not be
    // abandoned and the app must not start on top of a deletion in progress.
    if is_busy(&host) {
        return Ok(false);
    }
    let pending = PENDING_LAUNCH.lock().unwrap().take();
    if let Some((exe, arg)) = pending {
        let admission = controller::Admission::acquire().ok_or("另一项安装操作仍在进行。")?;
        if !controller::begin_engine() { admission.finish(); return Ok(false); }
        let result = tauri::async_runtime::spawn_blocking(move || application_launch::launch(std::path::Path::new(&exe), &arg))
            .await.map_err(|error| error.to_string());
        admission.finish();
        result??;
    }
    Ok(sidekickai_uninstall_host::close_confirmed_window(&window).is_ok())
}

#[tauri::command]
fn open_dir(dir: String) {
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
}

/// Real cancellation: only accepted before the engine is entered. The
/// cancellation and the engine start share one compare-and-swap state, so it is
/// impossible for `cancel()` to report success after the engine has begun. A
/// refusal returns `false` and the frontend keeps the busy state.
#[tauri::command]
fn cancel() -> bool {
    controller::cancel_operation()
}

/// 读取已安装位置的 install-config.json（覆盖安装/修复时预读作初始值）
#[tauri::command]
fn read_install_config(dir: String) -> Option<serde_json::Value> {
    engine::read_install_config(std::path::Path::new(&dir))
}

/// 完成页更新待启动程序（以完成页最终勾选为准，覆盖安装开始时的快照）
#[tauri::command]
fn set_pending_launch(install_dir: String, launch: bool, show_guide: bool) -> bool {
    if RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    if !launch {
        *PENDING_LAUNCH.lock().unwrap() = None;
        return true;
    }
    let exe = std::path::Path::new(&install_dir).join("SidekickAI.exe");
    if application_launch::validate_target(&exe).is_err() {
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

/// Write the final `install-config.json` when the user finishes or closes the
/// wizard.
///
/// Elevation policy: an already-elevated process or a writable directory writes
/// directly; an on-disk configuration that already matches is skipped; only a
/// required update without permission requests UAC. The elevated path reuses the
/// same private operation directory and identity binding as an install.
#[tauri::command]
async fn flush_config(opts: manifest::InstallRequest) -> Result<bool, String> {
    let mut config_opts = opts;
    config_opts.action = "flush-config".into();
    let dir = std::path::PathBuf::from(&config_opts.install_dir);

    let admission = controller::Admission::acquire()
        .ok_or_else(|| "另一个安装操作正在进行。".to_string())?;
    // A config write is not cancellable: entering the "engine" state immediately
    // means a stray `cancel()` can never claim it stopped this operation. If a
    // cancellation somehow won the race anyway, the write must not run.
    if !controller::begin_engine() {
        admission.finish();
        return Err("已取消：写配置尚未开始。".to_string());
    }

    // No-op completion must not probe protected paths or request elevation.
    if !engine::install_config_needs_write(&config_opts) {
        admission.finish();
        return Ok(true);
    }

    // Every operation owns its private directory and log, including a direct
    // write, so no two operations share a process-wide log file.
    let directory = controller::OperationDirectory::create("flush-op")?;
    let log_path = directory.log_path();

    // Already elevated or writable → inherit the permission and write directly.
    if elevate::is_process_elevated() || elevate::dir_is_writable(&dir) {
        let result = controller::with_operation_context(log_path, || {
            engine::flush_install_config(&config_opts)
        });
        admission.finish();
        return result.map(|_| true);
    }

    // A real update without permission → request UAC once. The request lives in
    // this operation's private directory.
    directory.write_envelope(controller::ACTION_FLUSH_CONFIG, &config_opts)?;
    let request_path = directory.request_path();
    let result_path = directory.result_path();
    let operation_id = directory.operation_id().to_string();
    let nonce = directory.nonce().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Keep the private directory alive until the child result has been read.
        let _directory = directory;
        controller::with_operation_context(log_path, || {
            elevate::run_elevated(&request_path, &result_path, &operation_id, &nonce)
        })
    })
    .await
    .map_err(|error| format!("提权写配置线程异常结束：{error}"))?;
    admission.finish();
    result?;
    Ok(true)
}

/// Stage a downloaded distribution asset into a unique temp file so the
/// install engine (including an elevated child) can re-hash the same bytes.
/// The path is returned to the frontend and referenced from InstallRequest.
#[tauri::command]
async fn fetch_resource_catalog(resource_type: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || cloud::fetch_resource_catalog(&resource_type)).await
        .map_err(|error| format!("资源请求失败：{error}"))?
}

#[tauri::command]
async fn fetch_resource_package(resource_type: String, resource_id: String, version: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || cloud::fetch_resource_package(&resource_type, &resource_id, &version)).await
        .map_err(|error| format!("资源请求失败：{error}"))?
}

#[tauri::command]
fn verify_cloud_resource(asset: manifest::CloudAssetRequest) -> Result<(), String> {
    cloud::verify_resource_proof(&asset)
}

#[tauri::command]
fn stage_cloud_download(asset_id: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("云端下载内容为空。".into());
    }
    // Keep the filename boring: identity travels in the parent directory name.
    let safe_label: String = asset_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(48)
        .collect();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!(
        "SidekickAI-Cloud-Download-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建云端下载暂存目录：{e}"))?;
    let path = dir.join(format!("{safe_label}.bin"));
    std::fs::write(&path, &bytes).map_err(|e| format!("无法写入云端下载暂存文件：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn start(app: AppHandle, mut opts: manifest::InstallRequest) -> Result<bool, String> {
    if opts.mode == manifest::InstallMode::Uninstall {
        return Err("请使用专用卸载命令并提供已确认的扫描令牌。".into());
    }
    // One operation per process: CAS admission. The guard releases the busy flag
    // on `?` early returns, engine errors, panics and join errors, and it is
    // released explicitly before the terminal event so the window cannot stay
    // stuck in the busy state.
    let admission =
        controller::Admission::acquire().ok_or_else(|| "另一个安装操作正在进行。".to_string())?;
    if opts.mode == manifest::InstallMode::Install {
        opts.installation_id = manifest::new_installation_id();
    }

    // A private request / result / log per operation: two wizard windows cannot
    // overwrite each other before the engine takes the target lock.
    let prepared = controller::prepare_operation("install", controller::ACTION_INSTALL, &opts)?;
    let log_path = prepared.log_path.clone();

    // Background tail thread: turns the S/P log lines into events. The parent
    // process and the elevated child share this operation's log path.
    let tail_app = app.clone();
    let tail_log_path = log_path.clone();
    let stop_tail = Arc::new(AtomicBool::new(false));
    let tail_stop = stop_tail.clone();
    let operation_id = prepared.operation_id.clone();
    let tail_operation_id = operation_id.clone();
    let tail = std::thread::spawn(move || tail_log(&tail_app, &tail_log_path, &tail_operation_id, tail_stop));
    controller::with_operation_context(log_path.clone(), || {
        engine::write_log(&format!("I|操作 {}；目标版本 {}；目录 {}", operation_id, env!("CARGO_PKG_VERSION"), opts.install_dir));
    });

    // Launch/guide follow the final checkbox on the completion page; the install
    // end records only a default that `set_pending_launch` overrides before the
    // wizard closes.
    let launch_after = opts.launch_after_install && opts.mode == manifest::InstallMode::Install;
    let show_guide = opts.show_guide_after_install;
    let install_dir = opts.install_dir.clone();
    let mode = opts.mode;
    // Request UAC only when this process is not elevated and the selected target
    // or a user-confirmed cleanup path needs administrator rights; the
    // unselected alternate install location is never probed.
    let needs_elev = !elevate::is_process_elevated()
        && (elevate::needs_admin(&opts.install_dir, opts.for_all_users)
            || opts.cleanup_paths.iter().any(|p| elevate::needs_admin(p, true)));
    let req = opts;
    let request_path = prepared.request_path.clone();
    let result_path = prepared.result_path.clone();
    let nonce = prepared.nonce.clone();
    let child_operation_id = prepared.operation_id.clone();
    let engine_log_path = log_path.clone();

    // The cancel / engine-start CAS makes exactly one of them the winner: when a
    // cancellation won, the engine must not run and the terminal event reports
    // the cancellation.
    let result: Result<(), String> = match tauri::async_runtime::spawn_blocking(move || {
        if !controller::begin_engine() {
            return Err("已取消：安装尚未开始。".to_string());
        }
        controller::with_operation_context(engine_log_path, || {
            if needs_elev {
                elevate::run_elevated(
                    &request_path,
                    &result_path,
                    &child_operation_id,
                    &nonce,
                )
            } else {
                engine::run(&req)
            }
        })
    })
    .await
    {
        Ok(result) => result,
        // A panicking operation thread must still produce a terminal event and
        // release admission; propagating the join error with `?` skipped the
        // event and left the UI on the installing step forever.
        Err(error) => Err(format!("安装操作线程异常结束：{error}")),
    };

    controller::with_operation_context(log_path, || match &result {
        Ok(()) => engine::write_log("I|程序操作成功；已完成目标校验"),
        Err(error) => engine::write_log(&format!("E|操作失败：{error}")),
    });
    stop_tail.store(true, Ordering::SeqCst);
    let _ = tail.join();
    drop(prepared);

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

    // Release admission before the terminal event: the UI must be able to leave
    // the busy state, and no background operation may start before that.
    admission.finish();

    match result {
        Ok(()) => {
            if launch_after {
                let exe = std::path::Path::new(&install_dir).join("SidekickAI.exe");
                if exe.exists() {
                    // --show-guide: open the first-run guide after install.
                    // --skip-guide: mark the guide as done and do not open it.
                    // Do not start now: record the pending program so the wizard
                    // launches it only when the window closes (Done or ✕).
                    let arg = if show_guide { "--show-guide".to_string() } else { "--skip-guide".to_string() };
                    *PENDING_LAUNCH.lock().unwrap() = Some((exe.to_string_lossy().into_owned(), arg));
                }
            }
            let _ = app.emit("install-done", manifest::DonePayload { install_dir, residual_note });
        }
        Err(e) => {
            let _ = app.emit("install-error", e);
        }
    }
    Ok(true)
}

/// Mirror one operation's non-secret log before its private request directory is released.
fn tail_log(app: &AppHandle, bound: &std::path::Path, operation_id: &str, stop: Arc<AtomicBool>) {
    let mut offset = 0u64;
    loop {
        emit_new_log_lines(app, bound, operation_id, &mut offset);
        if stop.load(Ordering::SeqCst) {
            emit_new_log_lines(app, bound, operation_id, &mut offset);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn emit_new_log_lines(app: &AppHandle, path: &std::path::Path, operation_id: &str, offset: &mut u64) {
    let Ok(text) = std::fs::read_to_string(path) else { return; };
    let Some(end) = text.rfind('\n').map(|index| index + 1) else { return; };
    if end as u64 <= *offset { return; }
    let complete = &text[..end];
    let saved = sidekickai_uninstall_host::diagnostics::save_operation_log(operation_id, complete);
    let payload = match saved {
        Ok(path) => serde_json::json!({ "text": complete, "path": path }),
        Err(error) => serde_json::json!({ "text": complete, "error": format!("操作日志未能保存：{error}") }),
    };
    let _ = app.emit("install-log", payload);
    for line in complete[*offset as usize..].lines() {
        if let Some(rest) = line.strip_prefix("S|") { let _ = app.emit("install-status", rest); }
        else if let Some(rest) = line.strip_prefix("P|") {
            if let Ok(progress) = rest.parse::<u32>() { let _ = app.emit("install-progress", progress); }
        }
    }
    *offset = end as u64;
}

pub fn run() {
    let _wizard = match sidekickai_uninstall_host::wizard_instance::WizardInstance::acquire() {
        Ok(instance) => instance,
        Err(message) => { sidekickai_uninstall_host::wizard_instance::show_notice(&message); return; }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(sidekickai_uninstall_host::Host::installer())
        .on_window_event(prevent_close_while_busy)
        .invoke_handler(tauri::generate_handler![
            sidekickai_uninstall_host::diagnostics::open_operation_log,
            sidekickai_uninstall_host::commands::uninstall_get_info,
            sidekickai_uninstall_host::commands::uninstall_scan,
            sidekickai_uninstall_host::commands::uninstall_start,
            sidekickai_uninstall_host::commands::uninstall_cancel,
            sidekickai_uninstall_host::commands::uninstall_close,
            sidekickai_uninstall_host::commands::uninstall_choose_backup_path,
            get_info,
            scan_installations,
            needs_admin,
            browse_dir,
            save_backup_dialog,
            close_window,
            open_dir,
            cancel,
            start,
            stage_cloud_download,
            verify_cloud_resource,
            fetch_resource_catalog,
            fetch_resource_package,
            read_install_config,
            flush_config,
            set_pending_launch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 提权子进程入口：读取本次操作私有目录中的请求并执行安装，把结果写回同一目录。
pub fn run_elevated_install(request_path: &str) -> i32 {
    controller::run_elevated_operation(request_path)
}

pub fn run_uninstall() -> i32 {
    run();
    0
}
