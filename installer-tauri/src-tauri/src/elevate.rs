// elevate.rs —— 智能提权：判断是否需要管理员 + ShellExecuteExW(runas) 重启自身
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, HWND};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS};

/// 智能判断本次安装是否需要管理员权限：
///   - 所有用户模式：必然需要（HKLM 注册表 + 所有用户快捷方式）
///   - 仅我模式：仅当目标路径落在受系统保护目录时才需要
pub fn needs_admin(dir: &str, for_all_users: bool) -> bool {
    if for_all_users {
        return true;
    }
    let lower = dir.to_lowercase();
    let pf = std::env::var("ProgramFiles")
        .unwrap_or_else(|_| "C:\\Program Files".into())
        .to_lowercase();
    let pfx86 = std::env::var("ProgramFiles(x86)").unwrap_or_default().to_lowercase();
    let windir = std::env::var("windir")
        .unwrap_or_else(|_| "C:\\Windows".into())
        .to_lowercase();
    lower.starts_with(&pf)
        || (!pfx86.is_empty() && lower.starts_with(&pfx86))
        || lower.starts_with(&windir)
}

pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 以管理员身份（UAC runas）启动 exe 并等待其退出。
/// 返回：Ok(0)=成功；Ok(1223)=用户取消 UAC；Ok(code)=子进程退出码；Err=启动失败。
pub fn shell_execute_runas(exe: &str, args: &str) -> Result<i32, String> {
    let op = wide("runas");
    let file = wide(exe);
    let params = wide(args);
    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: PCWSTR(op.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        lpDirectory: PCWSTR::null(),
        nShow: 0,
        ..Default::default()
    };
    unsafe {
        if ShellExecuteExW(&mut sei).is_ok() {
            let h = sei.hProcess;
            if !h.is_invalid() {
                WaitForSingleObject(h, INFINITE);
                let mut code = 0u32;
                let _ = GetExitCodeProcess(h, &mut code);
                let _ = CloseHandle(h);
                return Ok(code as i32);
            }
            return Ok(0);
        }
        let err = GetLastError();
        if err == ERROR_CANCELLED {
            return Ok(1223);
        }
        Err(format!("提权失败（错误码 {}）", err.0))
    }
}

/// 父进程侧：以 runas 重启自身（--elevated），等待完成后读取结果文件。
pub fn run_elevated(req_path: &std::path::Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().into_owned();
    let result = std::env::temp_dir().join("SidekickAI-install-result.json");
    // 删除旧结果，避免子进程异常退出时误读上一次安装结果。
    let _ = std::fs::remove_file(&result);
    let args = format!("--elevated \"{}\"", req_path.display());
    let code = shell_execute_runas(&exe_str, &args)?;

    // 无论退出码是否为 0，都优先读取提权子进程写出的结构化错误。
    // 否则 code=1 会掩盖真正的文件系统、解压或注册表错误。
    if let Ok(s) = std::fs::read_to_string(&result) {
        let v: serde_json::Value = serde_json::from_str(&s)
            .map_err(|e| format!("读取安装结果失败：{}", e))?;
        if v["ok"].as_bool() == Some(true) && code == 0 {
            return Ok(());
        }
        if let Some(error) = v["error"].as_str() {
            return Err(error.to_string());
        }
    }

    if code == 0 {
        Err("安装进程已结束，但没有返回安装结果".into())
    } else if code == 1223 {
        Err("已取消：未授予管理员权限".into())
    } else {
        Err(format!("安装进程异常退出，代码 {}（未返回详细错误）", code))
    }
}
