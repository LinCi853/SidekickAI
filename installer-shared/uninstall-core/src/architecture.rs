pub fn architecture_for_machine(machine: u16) -> Result<&'static str, String> {
    match machine {
        0x8664 => Ok("x64"),
        0xaa64 => Ok("arm64"),
        _ => Err("Windows 原生架构不受支持。".into()),
    }
}

#[cfg(windows)]
pub fn native_architecture() -> Result<&'static str, String> {
    use windows::Win32::System::{
        SystemInformation::{GetNativeSystemInfo, IMAGE_FILE_MACHINE, SYSTEM_INFO},
        Threading::{GetCurrentProcess, IsWow64Process2},
    };
    let mut process = IMAGE_FILE_MACHINE::default();
    let mut native = IMAGE_FILE_MACHINE::default();
    unsafe {
        if IsWow64Process2(GetCurrentProcess(), &mut process, Some(&mut native)).is_ok() {
            return architecture_for_machine(native.0);
        }
        let mut info = SYSTEM_INFO::default();
        GetNativeSystemInfo(&mut info);
        match info.Anonymous.Anonymous.wProcessorArchitecture.0 {
            9 => Ok("x64"),
            12 => Ok("arm64"),
            _ => Err("无法确认受支持的 Windows 原生架构。".into()),
        }
    }
}

#[cfg(not(windows))]
pub fn native_architecture() -> Result<&'static str, String> {
    Err("此维护程序仅支持 Windows。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_machine_is_never_guessed() {
        assert_eq!(architecture_for_machine(0x8664).unwrap(), "x64");
        assert_eq!(architecture_for_machine(0xaa64).unwrap(), "arm64");
        for machine in [0, 0x14c, 0xffff] {
            assert!(architecture_for_machine(machine).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn operating_system_reports_a_supported_native_machine() {
        assert!(matches!(native_architecture().unwrap(), "x64" | "arm64"));
    }
}
