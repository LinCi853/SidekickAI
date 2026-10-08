//! Bounded requests to a verified application process.

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, GENERIC_READ, GENERIC_WRITE, ERROR_IO_PENDING, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

struct Owned(HANDLE);
impl Drop for Owned { fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; } }

fn connect(pipe: &str, deadline: Instant) -> Result<Owned, String> {
    if pipe.is_empty() || !pipe.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return Err("程序协调管道名称无效。".into()); }
    let path = format!("\\\\.\\pipe\\{pipe}").encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    loop {
        match unsafe { CreateFileW(PCWSTR(path.as_ptr()), GENERIC_READ.0 | GENERIC_WRITE.0, FILE_SHARE_MODE(0), None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, HANDLE::default()) } {
            Ok(handle) => return Ok(Owned(handle)),
            Err(error) if [ERROR_FILE_NOT_FOUND.to_hresult(), ERROR_PIPE_BUSY.to_hresult()].contains(&error.code()) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("无法连接程序协调管道：{error}")),
        }
    }
}

fn transfer(handle: HANDLE, deadline: Instant, operation: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>) -> Result<usize, String> {
    let event = Owned(unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(|error| error.to_string())?);
    let mut overlapped = OVERLAPPED { hEvent: event.0, ..Default::default() };
    if let Err(error) = operation(&mut overlapped) {
        if error.code() != ERROR_IO_PENDING.to_hresult() { return Err(error.to_string()); }
    }
    let remaining = deadline.saturating_duration_since(Instant::now()).as_millis().min(u32::MAX as u128) as u32;
    if unsafe { WaitForSingleObject(event.0, remaining) } != WAIT_OBJECT_0 {
        // Cancellation must finish before the overlapped buffer leaves scope.
        let _ = unsafe { CancelIoEx(handle, Some(&overlapped)) };
        let mut ignored = 0;
        let _ = unsafe { GetOverlappedResult(handle, &overlapped, &mut ignored, true) };
        return Err("程序协调响应超时。".into());
    }
    let mut transferred = 0;
    unsafe { GetOverlappedResult(handle, &overlapped, &mut transferred, false) }.map_err(|error| error.to_string())?;
    Ok(transferred as usize)
}

pub(super) fn request(pipe: &str, expected_pid: u32, value: &Value, deadline: Instant) -> Result<Value, String> {
    let connection = connect(pipe, deadline.min(Instant::now() + Duration::from_secs(1)))?;
    let mut pid = 0;
    unsafe { GetNamedPipeServerProcessId(connection.0, &mut pid) }.map_err(|error| error.to_string())?;
    if pid != expected_pid { return Err("程序协调管道身份不匹配。".into()); }
    let bytes = format!("{value}\n").into_bytes();
    let timeout = match value["action"].as_str() {
        Some("activate" | "shutdown") => Duration::from_secs(5),
        _ => Duration::from_millis(1500),
    };
    let deadline = deadline.min(Instant::now() + timeout);
    let mut written = 0;
    while written < bytes.len() {
        let count = transfer(connection.0, deadline, |overlapped| unsafe { WriteFile(connection.0, Some(&bytes[written..]), None, Some(overlapped)) })?;
        if count == 0 { return Err("程序协调连接已断开。".into()); }
        written += count;
    }
    let mut response = Vec::new();
    loop {
        let mut buffer = [0u8; 4096];
        let count = transfer(connection.0, deadline, |overlapped| unsafe { ReadFile(connection.0, Some(&mut buffer), None, Some(overlapped)) })?;
        if count == 0 { return Err("程序协调连接已断开。".into()); }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > 16384 { return Err("程序协调响应过大。".into()); }
        if let Some(end) = response.iter().position(|byte| *byte == b'\n') {
            let peer: Value = serde_json::from_slice(&response[..end]).map_err(|error| error.to_string())?;
            return Ok(json!({ "serverPid": pid, "peer": peer }));
        }
    }
}
