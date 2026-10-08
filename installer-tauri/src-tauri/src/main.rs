#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => sidekickai_installer_lib::run(),
        [flag] if flag == "--uninstall" => {
            // Compatibility is an entry choice, never authorization to delete.
            sidekickai_installer_lib::run_uninstall();
        }
        [flag, request] if flag == "--elevated" => {
            std::process::exit(sidekickai_installer_lib::run_elevated_install(request));
        }
        [flag, request] if flag == "--worker" => {
            std::process::exit(sidekickai_uninstall_host::run_worker(request));
        }
        _ if sidekickai_installer_lib::validate_distribution_arguments(&args).unwrap_or(false) => sidekickai_installer_lib::run(),
        _ => {
            eprintln!("不支持的安装器参数。");
            std::process::exit(64);
        }
    }
}
