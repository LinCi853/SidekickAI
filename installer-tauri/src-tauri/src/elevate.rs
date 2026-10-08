// elevate.rs —— 智能提权：判断是否需要管理员 + ShellExecuteExW(runas) 重启自身
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, HWND};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS};

/// 当前进程是否已以管理员身份运行（TokenElevation）。
/// 用于「需要时才提权、已提权则继承」：避免安装完成后写配置再弹一次 UAC。
pub fn is_process_elevated() -> bool {
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

/// 目录是否可由当前进程直接写入（无需再提权）。
pub fn dir_is_writable(dir: &std::path::Path) -> bool {
    use std::io::Write;
    if sidekickai_uninstall_core::path::reject_reparse_points(dir).is_err() { return false; }
    let mut parent = dir;
    while !parent.exists() { let Some(next) = parent.parent() else { return false; }; parent = next; }
    let Ok(id) = sidekickai_uninstall_core::random_id("sidekick-write-probe") else { return false; };
    let source = parent.join(&id);
    let target = parent.join(format!("{id}-renamed"));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&source)?;
        file.write_all(b"installation write probe")?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&source, &target)?;
        std::fs::remove_file(&target)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&source); let _ = std::fs::remove_file(&target); }
    result.is_ok()
}

pub fn needs_admin(dir: &str, for_all_users: bool) -> bool {
    let path = std::path::Path::new(dir);
    for_all_users || !dir_is_writable(path) || path.parent().is_some_and(|parent| !dir_is_writable(parent))
}

pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Retain the authorized worker's live process handle for completion requests.
pub(crate) struct AuthorizedProcess { handle: usize }

impl Drop for AuthorizedProcess {
    fn drop(&mut self) { let _ = unsafe { CloseHandle(windows::Win32::Foundation::HANDLE(self.handle as _)) }; }
}

impl AuthorizedProcess {
    #[cfg(test)]
    pub(crate) fn from_test_child(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{DuplicateHandle, HANDLE, DUPLICATE_SAME_ACCESS};
        use windows::Win32::System::Threading::GetCurrentProcess;
        let mut handle = HANDLE::default();
        unsafe { DuplicateHandle(GetCurrentProcess(), HANDLE(child.as_raw_handle()), GetCurrentProcess(), &mut handle, 0, false, DUPLICATE_SAME_ACCESS) }
            .map_err(|error| error.to_string())?;
        Ok(Self { handle: handle.0 as usize })
    }

    pub(crate) fn exit_code(&self) -> Result<Option<i32>, String> {
        let handle = windows::Win32::Foundation::HANDLE(self.handle as _);
        match unsafe { WaitForSingleObject(handle, 0) } {
            windows::Win32::Foundation::WAIT_TIMEOUT => Ok(None),
            windows::Win32::Foundation::WAIT_OBJECT_0 => {
                let mut code = 0;
                unsafe { GetExitCodeProcess(handle, &mut code) }.map_err(|error| error.to_string())?;
                Ok(Some(code as i32))
            }
            _ => Err("无法确认授权执行器状态。".into()),
        }
    }
}

fn spawn_runas(exe: &str, args: &str) -> Result<AuthorizedProcess, String> {
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
            if !sei.hProcess.is_invalid() { return Ok(AuthorizedProcess { handle: sei.hProcess.0 as usize }); }
            return Err("系统未返回授权执行器的进程句柄。".into());
        }
        let err = GetLastError();
        if err == ERROR_CANCELLED {
            return Err("已取消：未授予管理员权限".into());
        }
        Err(format!("提权失败（错误码 {}）", err.0))
    }
}

pub(crate) fn spawn_elevated(request_path: &std::path::Path) -> Result<AuthorizedProcess, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    spawn_runas(&exe.to_string_lossy(), &format!("--elevated \"{}\"", request_path.display()))
}

fn shell_execute_runas_with_callback(exe: &str, args: &str, mut callback: impl FnMut() -> Result<(), String>) -> Result<i32, String> {
    let process = spawn_runas(exe, args)?;
    let mut callback_error = None;
    loop {
        if let Some(code) = process.exit_code()? {
            if let Some(error) = callback_error { return Err(error); }
            return Ok(code);
        }
        if callback_error.is_none() { callback_error = callback().err(); }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// 父进程侧：以 runas 重启自身（--elevated），等待完成后读取本次操作私有目录中的结果文件。
///
/// `result_path` 属于同一次操作的私有目录，因此并发窗口不会互相读取结果；
/// 结果内容还需与本次 operationId / nonce 匹配才会被接受。
pub fn run_elevated(
    req_path: &std::path::Path,
    result_path: &std::path::Path,
    operation_id: &str,
    nonce: &str,
) -> Result<(), String> {
    run_elevated_with_callback(req_path, result_path, operation_id, nonce, || Ok(()))
}

pub fn run_elevated_with_callback(
    req_path: &std::path::Path,
    result_path: &std::path::Path,
    operation_id: &str,
    nonce: &str,
    callback: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().into_owned();
    // 删除旧结果，避免子进程异常退出时误读上一次安装结果。
    let _ = std::fs::remove_file(result_path);
    let args = format!("--elevated \"{}\"", req_path.display());
    let code = shell_execute_runas_with_callback(&exe_str, &args, callback)?;

    // 无论退出码是否为 0，都优先读取提权子进程写出的结构化错误。
    // 否则 code=1 会掩盖真正的文件系统、解压或注册表错误。
    let raw = std::fs::read_to_string(result_path).ok();
    crate::controller::interpret_child_result(raw.as_deref(), code, operation_id, nonce)
}
