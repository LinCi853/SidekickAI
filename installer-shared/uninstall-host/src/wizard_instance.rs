//! One maintenance window across editions, versions and operation kinds.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};

pub struct WizardInstance(HANDLE);

impl WizardInstance {
    pub fn acquire() -> Result<Self, String> {
        Self::named("Local\\SidekickAI-Maintenance-Wizard")
    }

    fn named(name: &str) -> Result<Self, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }
            .map_err(|_| "无法确认安装维护向导状态，请关闭已有安装器或卸载器后重试。".to_string())?;
        let existing = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let instance = Self(handle);
        if existing { return Err("已有工百窗安装器或卸载器正在运行，请先完成或关闭已有向导。".to_string()); }
        Ok(instance)
    }
}

impl Drop for WizardInstance {
    fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; }
}

pub fn show_notice(message: &str) {
    let body: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "工百窗安装维护".encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(None, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONINFORMATION); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_competing_wizards_and_releases_after_exit() {
        let name = format!("Local\\SidekickAI-Wizard-Test-{}", sidekickai_uninstall_core::random_id("wizard").unwrap());
        let first = WizardInstance::named(&name).unwrap();
        assert!(WizardInstance::named(&name).is_err());
        drop(first);
        assert!(WizardInstance::named(&name).is_ok());
    }
}
