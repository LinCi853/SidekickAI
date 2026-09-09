// main.rs —— 入口：正常启动向导 / 提权安装子进程 / 卸载器
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--elevated") {
        let req = args.get(pos + 1).cloned().unwrap_or_default();
        std::process::exit(sidekickai_installer_lib::run_elevated_install(&req));
    }
    if args.iter().any(|a| a == "--uninstall") {
        std::process::exit(sidekickai_installer_lib::run_uninstall());
    }
    sidekickai_installer_lib::run();
}
