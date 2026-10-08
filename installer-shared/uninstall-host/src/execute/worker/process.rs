//! Process stop, worker process handles, elevation and wait policies.

use super::prepare::read_outcome;
use super::types::{WorkerOutcome, WorkerRequest};
use super::super::{internal, worker_failure, WORKER_EXIT_GRACE, WORKER_TIMEOUT};
use sidekickai_uninstall_core::path::{path_is_same_or_descendant, NormalizedAbsolutePath};
use sidekickai_uninstall_core::protocol::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Start a detached helper process whose lifetime is independent of this one.
/// Used to hand the UI over to its relocated copy.
pub fn spawn_detached(executable: &Path, arguments: &str) -> Result<(), UninstallError> {
    spawn_detached_inner(executable, arguments)
}

#[cfg(windows)]
pub(super) fn spawn_detached_inner(executable: &Path, arguments: &str) -> Result<(), UninstallError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
    let wide = |value: &OsStr| -> Vec<u16> { value.encode_wide().chain(std::iter::once(0)).collect() };
    let file = wide(executable.as_os_str());
    let parameters = wide(OsStr::new(arguments));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: 1,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info)
            .map_err(|error| internal(format!("无法启动已重定位的卸载器：{error}")))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn spawn_detached_inner(_executable: &Path, _arguments: &str) -> Result<(), UninstallError> {
    Err(internal("分离启动仅在 Windows 上实现。"))
}

// ---------------------------------------------------------------------------
// Process stop (exact executable path binding)
// ---------------------------------------------------------------------------

/// Terminate only processes whose image path is inside a confirmed target.
///
/// Process identity is bound to the executable path, never to the image name, so
/// another installation running the same file name is left alone. The comparison
/// is Windows case-insensitive and component-aware, and the current process is
/// never stopped even if it sits inside a selected scope. Termination is
/// verified afterwards: a surviving target process is reported as a failure
/// instead of being mistaken for a clean stop.
pub fn stop_target_processes(targets: &[NormalizedAbsolutePath], operation_id: &str) -> Result<Vec<u32>, UninstallError> {
    stop_target_processes_inner(targets, operation_id)
}

pub(super) fn stop_worker_processes(request: &WorkerRequest, targets: &[NormalizedAbsolutePath]) -> Result<Vec<u32>, UninstallError> {
    #[cfg(windows)]
    {
        let launchers = targets.iter().map(|target| sidekickai_uninstall_core::path::normalize_absolute_path(
            target.as_path().join("uninstall.exe"))).collect::<Result<Vec<_>, _>>()?;
        if target_processes(targets)?.contains(&request.controller_pid) || !target_processes(&launchers)?.is_empty() {
            return Err(UninstallError::new(UninstallErrorCode::ProcessRunning,
                "安装维护程序仍在目标目录内运行。请关闭该窗口后重试，尚未删除内容。",
                UninstallPhase::Stopping, true, &request.operation_id));
        }
        let applications = super::shutdown::prepare(targets, &request.operation_id, request.controller_pid)?;
        return stop_target_processes_checked(targets, &request.operation_id, |handle, pid| {
            super::shutdown::validate_process(handle, pid, targets, &applications, &request.operation_id)
        });
    }
    #[cfg(not(windows))]
    stop_target_processes(targets, &request.operation_id)
}

#[cfg(windows)]
pub(crate) fn processes_require_elevation(targets: &[NormalizedAbsolutePath]) -> Result<bool, UninstallError> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
    for pid in target_processes(targets)? {
        match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => { let _ = unsafe { CloseHandle(handle) }; }
            Err(_) if target_processes(targets)?.contains(&pid) => return Ok(true),
            Err(_) => {}
        }
    }
    Ok(false)
}

#[cfg(not(windows))]
pub(crate) fn processes_require_elevation(_targets: &[NormalizedAbsolutePath]) -> Result<bool, UninstallError> { Ok(false) }

#[cfg(windows)]
pub fn target_processes(targets: &[NormalizedAbsolutePath]) -> Result<Vec<u32>, UninstallError> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    let own_pid = std::process::id();
    let mut matches = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| internal(format!("无法枚举进程：{e}")))?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                // Never terminate this process: an in-place fallback run may sit
                // inside the very installation that is being removed.
                if pid != 0 && pid != own_pid {
                    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) {
                        if live_process_matches(process, targets) { matches.push(pid); }
                        let _ = CloseHandle(process);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    Ok(matches)
}

#[cfg(windows)]
pub(super) fn live_process_matches(process: windows::Win32::Foundation::HANDLE, targets: &[NormalizedAbsolutePath]) -> bool {
    use windows::Win32::Foundation::WAIT_OBJECT_0;
    use windows::Win32::System::Threading::{QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32};
    unsafe {
        if WaitForSingleObject(process, 0) == WAIT_OBJECT_0 { return false; }
        let mut buffer = [0u16; 32768];
        let mut length = buffer.len() as u32;
        if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut length).is_err() { return false; }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        targets.iter().any(|target| path_is_same_or_descendant(Path::new(&path), target.as_path()))
    }
}

#[cfg(windows)]
fn termination_wait(process: windows::Win32::Foundation::HANDLE, pid: u32, milliseconds: u32) -> windows::Win32::Foundation::WAIT_EVENT {
    #[cfg(test)]
    if let Some(result) = STOP_WAIT_HOOK.with(|hook| hook.borrow_mut().as_mut().and_then(|hook| hook(pid, milliseconds))) { return result; }
    #[cfg(not(test))]
    let _ = pid;
    unsafe { windows::Win32::System::Threading::WaitForSingleObject(process, milliseconds) }
}

#[cfg(all(test, windows))]
type StopWaitHook = Box<dyn FnMut(u32, u32) -> Option<windows::Win32::Foundation::WAIT_EVENT>>;

#[cfg(all(test, windows))]
thread_local! { static STOP_WAIT_HOOK: std::cell::RefCell<Option<StopWaitHook>> = std::cell::RefCell::new(None); }

#[cfg(all(test, windows))]
pub(crate) fn with_stop_wait_hook<T>(hook: StopWaitHook, operation: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset { fn drop(&mut self) { STOP_WAIT_HOOK.with(|hook| { hook.borrow_mut().take(); }); } }
    STOP_WAIT_HOOK.with(|current| { *current.borrow_mut() = Some(hook); });
    let _reset = Reset;
    operation()
}

#[cfg(windows)]
pub(super) fn stop_target_processes_inner(targets: &[NormalizedAbsolutePath], operation_id: &str) -> Result<Vec<u32>, UninstallError> {
    stop_target_processes_checked(targets, operation_id, |_, _| Ok(()))
}

#[cfg(windows)]
pub(super) fn stop_target_processes_checked(
    targets: &[NormalizedAbsolutePath],
    operation_id: &str,
    validate: impl Fn(windows::Win32::Foundation::HANDLE, u32) -> Result<(), UninstallError>,
) -> Result<Vec<u32>, UninstallError> {
    use std::collections::BTreeMap;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
    struct Captured { handle: HANDLE, pid: u32 }
    impl Drop for Captured { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.handle) }; } }
    let bound = target_processes(targets)?;
    let mut captured = Vec::new();
    let mut failures = BTreeMap::new();
    for pid in bound {
        match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => {
                let process = Captured { handle, pid };
                if live_process_matches(handle, targets) {
                    validate(handle, pid)?;
                    captured.push(process);
                }
            }
            Err(error) => { failures.insert(pid, format!("OpenProcess: {error}")); }
        }
    }
    let mut killed = Vec::new();
    for process in &captured {
        match unsafe { TerminateProcess(process.handle, 1) } {
            Ok(()) => killed.push(process.pid),
            Err(error) => { failures.insert(process.pid, format!("TerminateProcess: {error}")); }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut pending = false;
        let mut wait_failed = false;
        for process in &captured {
            let state = termination_wait(process.handle, process.pid, 0);
            let native_error = if state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT { unsafe { GetLastError() }.0 } else { 0 };
            if state == WAIT_OBJECT_0 { continue; }
            pending = true;
            if state != WAIT_TIMEOUT {
                failures.entry(process.pid).or_insert_with(|| format!("WaitForSingleObject: {native_error} (status {})", state.0));
                wait_failed = true;
            }
        }
        if !pending || wait_failed || Instant::now() >= deadline { break; }
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(50)));
    }
    // Retained handles bind completion to the original process objects.
    // Recheck after scanning so an earlier timeout cannot become a stale failure.
    let mut survivors = target_processes(targets)?;
    for process in &captured {
        let state = termination_wait(process.handle, process.pid, 0);
        let native_error = if state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT { unsafe { GetLastError() }.0 } else { 0 };
        if state == WAIT_OBJECT_0 {
            survivors.retain(|pid| *pid != process.pid);
        } else {
            survivors.push(process.pid);
            failures.entry(process.pid).or_insert_with(|| if state == WAIT_TIMEOUT {
                "WaitForSingleObject: 进程句柄尚未确认退出".to_string()
            } else {
                format!("WaitForSingleObject: {native_error} (status {})", state.0)
            });
        }
    }
    survivors.sort_unstable();
    survivors.dedup();
    if !survivors.is_empty() {
        let reasons = survivors.iter().map(|pid| format!("PID {pid}: {}", failures.get(pid).map(String::as_str).unwrap_or("停止后仍检测到目标进程"))).collect::<Vec<_>>().join("; ");
        return Err(UninstallError::new(
            UninstallErrorCode::ProcessStopFailed,
            format!("尚未确认 SidekickAI 进程退出，已暂停卸载。{reasons}"),
            UninstallPhase::Stopping,
            true,
            operation_id,
        ));
    }
    Ok(killed)
}

#[cfg(not(windows))]
fn stop_target_processes_inner(_targets: &[NormalizedAbsolutePath], _operation_id: &str) -> Result<Vec<u32>, UninstallError> {
    Err(internal("进程终止仅在 Windows 上实现。"))
}

// ---------------------------------------------------------------------------
// Worker process tracking
// ---------------------------------------------------------------------------

/// An owned worker process handle. The handle is closed on drop, and its exit
/// state is polled so the controller can tell "still working" from "died without
/// reporting" instead of waiting out the full timeout.
#[cfg(windows)]
pub struct WorkerProcess {
    handle: windows::Win32::Foundation::HANDLE,
    pid: u32,
}

#[cfg(windows)]
impl WorkerProcess {
    pub(super) fn track(pid: u32) -> Result<Self, UninstallError> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }
            .map_err(|error| internal(format!("无法核实协调进程 {pid}：{error}")))?;
        Ok(Self { handle, pid })
    }

    pub(super) fn is_alive(&self) -> Result<bool, UninstallError> {
        use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::WaitForSingleObject;
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_TIMEOUT => Ok(true), WAIT_OBJECT_0 => Ok(false), _ => Err(internal("无法确认协调进程活句柄状态。")),
        }
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// `None` while the process is still running, otherwise its exit code.
    pub fn exit_code(&self) -> Option<u32> {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        unsafe {
            // The exit code can be visible before teardown signals the process handle.
            if WaitForSingleObject(self.handle, 0) != WAIT_OBJECT_0 { return None; }
            let mut code = 0u32;
            if GetExitCodeProcess(self.handle, &mut code).is_ok() {
                Some(code)
            } else {
                None
            }
        }
    }

    /// Test-only handle for a process the test itself started, so the wait and
    /// exit policies can be exercised without building the standalone artifact.
    #[cfg(test)]
    pub(super) fn open_for_test(pid: u32) -> Result<Self, UninstallError> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }
            .map_err(|e| internal(format!("无法打开测试进程 {pid}：{e}")))?;
        Ok(Self { handle, pid })
    }
}

#[cfg(windows)]
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
pub struct WorkerProcess {
    pid: u32,
}

#[cfg(not(windows))]
impl WorkerProcess {
    pub(super) fn track(pid: u32) -> Result<Self, UninstallError> { Ok(Self { pid }) }
    pub(super) fn is_alive(&self) -> Result<bool, UninstallError> { Ok(false) }
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn exit_code(&self) -> Option<u32> {
        Some(0)
    }
}

/// Worker command line. The request path is always quoted so an operation
/// directory containing spaces stays a single argument.
pub fn worker_command_line(request_path: &Path) -> String {
    format!("--worker \"{}\"", request_path.display())
}

/// Spawn the relocated worker and return an owned handle to it. Elevation is
/// requested only when the confirmed target scope requires it; a declined prompt
/// is reported, never downgraded.
pub fn spawn_worker(worker: &Path, request_path: &Path, elevate: bool) -> Result<WorkerProcess, UninstallError> {
    spawn_worker_inner(worker, request_path, elevate)
}

#[cfg(windows)]
pub(super) fn spawn_worker_inner(worker: &Path, request_path: &Path, elevate: bool) -> Result<WorkerProcess, UninstallError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_CANCELLED};
    use windows::Win32::System::Threading::GetProcessId;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS};

    let wide = |value: &OsStr| -> Vec<u16> { value.encode_wide().chain(std::iter::once(0)).collect() };
    let file = wide(worker.as_os_str());
    let parameters = wide(OsStr::new(&worker_command_line(request_path)));
    let verb = if elevate { Some(wide(OsStr::new("runas"))) } else { None };
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ref().map(|value| PCWSTR(value.as_ptr())).unwrap_or(PCWSTR::null()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: 0,
        ..Default::default()
    };
    unsafe {
        if ShellExecuteExW(&mut info).is_err() {
            let error = GetLastError();
            if elevate && error == ERROR_CANCELLED {
                return Err(UninstallError::new(
                    UninstallErrorCode::ElevationCancelled,
                    "管理员授权已取消；未删除任何内容。",
                    UninstallPhase::Stopping,
                    true,
                    "",
                ));
            }
            return Err(UninstallError::new(
                UninstallErrorCode::ElevationFailed,
                format!("无法启动卸载进程（错误码 {}）", error.0),
                UninstallPhase::Stopping,
                true,
                "",
            ));
        }
        if info.hProcess.is_invalid() {
            return Err(internal("工作进程已启动，但未获得可用的进程句柄。"));
        }
        let pid = GetProcessId(info.hProcess);
        Ok(WorkerProcess { handle: info.hProcess, pid })
    }
}

#[cfg(not(windows))]
fn spawn_worker_inner(_worker: &Path, _request_path: &Path, _elevate: bool) -> Result<WorkerProcess, UninstallError> {
    Err(internal("进程启动仅在 Windows 上实现。"))
}

/// True when this process already holds an elevated token. Scan/export run in the
/// caller's own (non-elevated) process so `%APPDATA%` always belongs to the user
/// who launched the uninstaller; only the deletion worker is elevated.
#[cfg(windows)]
pub fn is_process_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            // Unknown elevation state must be treated as elevated (more conservative).
            return true;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        ok.is_err() || elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_process_elevated() -> bool {
    true
}

/// Read the worker result and annotate it when a cancel request arrived after
/// the deletion had already started.
pub(super) fn read_outcome_with_cancel(directory: &Path, nonce: &str, operation_id: &str, cancel: &AtomicBool) -> Result<WorkerOutcome, UninstallError> {
    let mut outcome = read_outcome(directory, nonce, operation_id)?;
    if cancel.load(Ordering::SeqCst) {
        outcome.warnings.push("CANCEL_TOO_LATE".into());
    }
    Ok(outcome)
}

pub fn wait_for_outcome(
    directory: &Path,
    nonce: &str,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    process: &WorkerProcess,
) -> Result<WorkerOutcome, UninstallError> {
    let started = Instant::now();
    let mut warned = false;
    loop {
        if directory.join("result.json").is_file() {
            // Parse first (the file cannot change once written atomically), but
            // never return before the process is gone.
            let outcome = read_outcome_with_cancel(directory, nonce, operation_id, &cancel);
            wait_for_worker_exit(process, &mut warned);
            return outcome;
        }
        if let Some(code) = process.exit_code() {
            // The result is written before the worker exits, but re-check to
            // close the tiny window between the two observations.
            if directory.join("result.json").is_file() {
                return read_outcome_with_cancel(directory, nonce, operation_id, &cancel);
            }
            return Err(worker_exit_failure(directory, operation_id, process.pid(), code));
        }
        if started.elapsed() > WORKER_TIMEOUT && !warned {
            eprintln!(
                "warning: the uninstall worker (PID {}) is still running after {} minutes without a result; continuing to wait so its deletion state is not abandoned",
                process.pid(),
                WORKER_TIMEOUT.as_secs() / 60
            );
            warned = true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Block until the worker process has really exited. The result file appears
/// before the process is gone, and cleaning up (or deleting an installation that
/// contains a still-open image) is only safe afterwards.
pub(super) fn wait_for_worker_exit(process: &WorkerProcess, warned: &mut bool) {
    let grace_end = Instant::now() + WORKER_EXIT_GRACE;
    loop {
        if process.exit_code().is_some() {
            return;
        }
        if Instant::now() > grace_end && !*warned {
            eprintln!(
                "warning: the uninstall worker (PID {}) reported a result but has not exited after {}s; still waiting instead of cleaning up its operation directory",
                process.pid(),
                WORKER_EXIT_GRACE.as_secs()
            );
            *warned = true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Report a worker that died without a result, naming the exact PID and the
/// operation directory that was preserved for diagnosis.
pub(super) fn worker_exit_failure(directory: &Path, operation_id: &str, pid: u32, code: u32) -> UninstallError {
    worker_failure(
        operation_id,
        format!(
            "卸载工作进程（PID {pid}）在报告结果前以代码 {code} 退出；其删除状态未知。"
        ),
    )
    .with_detail("workerPid", DetailValue::Number(pid as i64))
    .with_detail("operationDirectory", DetailValue::String(directory.to_string_lossy().into_owned()))
}

#[cfg(windows)]
pub(super) fn process_is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => process,
            // A process that does not exist reports an invalid parameter. Any
            // other failure (for example access denied for a protected process)
            // leaves liveness unknown and must be treated as alive.
            Err(_) => return GetLastError() != ERROR_INVALID_PARAMETER,
        };
        let mut code = 0u32;
        // An unreadable exit code is *unknown* liveness, not "dead": treating it
        // as dead would let the sweeper delete a live UI's relocation directory.
        let alive = match GetExitCodeProcess(process, &mut code) {
            Ok(()) => code == STILL_ACTIVE.0 as u32,
            Err(_) => true,
        };
        let _ = CloseHandle(process);
        alive
    }
}

#[cfg(not(windows))]
fn process_is_alive(_pid: u32) -> bool {
    // Unknown liveness must never cause a live relocation to be deleted.
    true
}
