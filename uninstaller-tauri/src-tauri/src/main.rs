#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn usage() {
    eprintln!("Usage: uninstall.exe [--ui|--uninstall|--version|--help]");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        // No argument and the compatibility flag both open the same uninstall UI.
        [] => sidekickai_uninstaller_lib::run(),
        [flag] if flag == "--ui" || flag == "--uninstall" => {
            // `run` moves the UI outside the installation it is about to delete.
            sidekickai_uninstaller_lib::run();
        }
        [flag] if flag == "--version" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
        [flag] if flag == "--help" => usage(),
        // Internal modes. A supplied file is never authorization on its own: the
        // shared host re-validates the private operation directory contents.
        [flag, path] if flag == "--worker" => {
            std::process::exit(sidekickai_uninstaller_lib::run_worker(path));
        }
        [flag, path] if flag == "--relocated" => {
            if let Err(error) = sidekickai_uninstaller_lib::run_relocated(path) {
                eprintln!("Relocation refused: {error}");
                std::process::exit(64);
            }
        }
        // Silent, unknown and bare-path arguments are refused, never executed.
        _ => {
            usage();
            std::process::exit(64);
        }
    }
}
