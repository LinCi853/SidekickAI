//! Standalone Tauri entry. The shared host owns the uninstall command surface;
//! this crate only builds the window for each entry mode.

use sidekickai_uninstall_host::Host;
use std::path::Path;

fn launch(host: Host) -> Result<(), String> {
    let _wizard = match sidekickai_uninstall_host::wizard_instance::WizardInstance::acquire() {
        Ok(instance) => instance,
        Err(message) => { sidekickai_uninstall_host::wizard_instance::show_notice(&message); return Ok(()); }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(host)
        .on_window_event(sidekickai_uninstall_host::prevent_close_while_running)
        .invoke_handler(tauri::generate_handler![
            sidekickai_uninstall_host::diagnostics::open_operation_log,
            sidekickai_uninstall_host::commands::uninstall_get_info,
            sidekickai_uninstall_host::commands::uninstall_scan,
            sidekickai_uninstall_host::commands::uninstall_start,
            sidekickai_uninstall_host::commands::uninstall_cancel,
            sidekickai_uninstall_host::commands::uninstall_close,
            sidekickai_uninstall_host::commands::uninstall_choose_backup_path
        ])
        .run(tauri::generate_context!())
        .map_err(|error| error.to_string())
}

/// Normal UI entry. The window is opened from a relocated copy so that deleting
/// the installation directory cannot be blocked by this process's own image.
pub fn run() {
    match relocate_and_launch() {
        Some(code) => std::process::exit(code),
        // Relocation unavailable: open the UI in place rather than refusing to
        // start. Deletion still validates every target before removing anything.
        None => run_in_place(),
    }
}

/// Returns an exit code when the relocated copy was started, or `None` when the
/// caller must continue in place (relocation unavailable).
fn relocate_and_launch() -> Option<i32> {
    let (relocated, arguments) = sidekickai_uninstall_host::prepare_ui_relocation().ok()?;
    match sidekickai_uninstall_host::start_relocated_ui(&relocated, &arguments) {
        Ok(()) => Some(0),
        Err(_) => None,
    }
}

/// Continue in the relocated copy, reporting the launcher's own directory as the
/// installation the user started from.
pub fn run_relocated(bootstrap_path: &str) -> Result<(), String> {
    let origin = sidekickai_uninstall_host::read_relocation_origin(Path::new(bootstrap_path))
        .map_err(|error| error.message)?;
    launch(Host::standalone_relocated(origin))
}

/// Fallback used when relocation is not possible: open the UI in place. The
/// operation itself still validates every target before deleting anything.
pub fn run_in_place() {
    let _ = launch(Host::standalone());
}

/// Internal worker entry. A supplied request is only trusted after the
/// authenticated private-operation-directory checks in the shared host succeed.
pub fn run_worker(request_path: &str) -> i32 {
    sidekickai_uninstall_host::run_worker(request_path)
}
