pub fn ensure_webview2() -> Result<(), String> {
    if tauri::webview_version().is_ok_and(|version| !version.trim().is_empty()) { return Ok(()); }
    let message = "此维护向导需要 Microsoft Edge WebView2 Runtime。请准备该系统组件后重新打开向导。应用与恢复载荷无需重复下载，现有程序和资料未修改。\n\n是否打开微软官方下载页面？";
    #[cfg(windows)]
    {
        use windows::{core::PCWSTR, Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO}}};
        let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let title = wide("工百窗维护向导"); let text = wide(message);
        if unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_YESNO | MB_ICONWARNING) } == IDYES {
            let action = wide("open"); let url = wide("https://developer.microsoft.com/microsoft-edge/webview2/#download-section");
            unsafe { let _ = ShellExecuteW(None, PCWSTR(action.as_ptr()), PCWSTR(url.as_ptr()), None, None, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL); }
        }
    }
    Err("缺少 Microsoft Edge WebView2 Runtime，向导尚未启动。".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn installed_system_webview_is_detected_without_opening_a_window() {
        let version = tauri::webview_version().expect("the native verification environment requires WebView2");
        assert!(!version.trim().is_empty());
    }
}
