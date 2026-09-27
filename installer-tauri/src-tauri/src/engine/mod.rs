// engine —— 安装引擎：扫描、staging+backup+commit+rollback、修复、卸载、7zr 解压、快捷方式、卸载注册
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::manifest;

mod config;
mod deploy;
mod payload;
mod pipeline;
mod registry;
mod scan;
mod scope;
mod shortcuts;
mod validate;

pub use config::{flush_install_config, install_config_needs_write, read_install_config};
#[cfg(test)]
use config::install_config_matches;
pub use pipeline::run;
pub use scan::scan_installations;

/// Log destination bound to the current operation.
///
/// Every engine call from the controller (parent process and elevated child) runs
/// inside `controller::with_operation_context`, so during an operation this
/// returns that operation's private `install.log`. The fixed process-wide path
/// is only an informational fallback for engine messages emitted outside an
/// admitted operation (for example the startup scan).
pub fn log_path() -> PathBuf {
    crate::controller::bound_log_path().unwrap_or_else(fallback_log_path)
}

/// Informational fallback used only outside an operation. It is `pub` behaviour
/// through `log_path`, but `write_log` drops unbound writes in test builds so a
/// fixture run never appends to a real installer log.
pub(crate) fn fallback_log_path() -> PathBuf {
    std::env::temp_dir().join("SidekickAI-install.log")
}

pub(crate) fn write_log(line: &str) {
    use std::io::Write;
    // Fixture tests exercise the engine without an operation context; dropping
    // the line keeps them from touching `%TEMP%\SidekickAI-install.log`.
    #[cfg(test)]
    {
        if crate::controller::bound_log_path().is_none() {
            return;
        }
    }
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
pub(crate) trait CommandHidden {
    fn hidden(&mut self) -> &mut Command;
}

impl CommandHidden for Command {
    fn hidden(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

pub(crate) fn product_version() -> String { manifest::build_info().version }

#[cfg(test)]
mod tests;
