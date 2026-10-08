//! Signed external recovery resources for damaged application installations.
use crate::execute;
use sidekickai_uninstall_core::distribution::{self, VerifiedRuntime};
use sidekickai_uninstall_core::protocol::*;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn failure(message: impl Into<String>) -> UninstallError {
    UninstallError::new(UninstallErrorCode::BackupExportFailed, message, UninstallPhase::BackingUp, false, "")
}

pub(crate) fn prepare(installation: &Path, directory: &Path, edition: &str) -> Result<VerifiedRuntime, UninstallError> {
    execute::harden_operation_directory(directory)?;
    let architecture = sidekickai_uninstall_core::architecture::native_architecture().map_err(failure)?;
    let mut keys=distribution::trusted_keys().map_err(failure)?;
    #[cfg(test)]
    if let Some(keys)=keys.as_array_mut(){keys.push(crate::backup_export::integration_tests::test_trust());}
    distribution::prepare_runtime_with_keys(installation, directory, edition, architecture,&keys).map_err(|error| {
        failure(format!("独立恢复资源缺失或校验失败：{error}。原资料保留，请使用匹配的已核验本地载荷修复后重试。"))
    })
}

pub(crate) fn export(runtime: &VerifiedRuntime, request: &serde_json::Value) -> Result<(), UninstallError> {
    use std::os::windows::process::CommandExt;
    let mut child = Command::new(runtime.directory.join("node.exe"))
        .arg("--disable-warning=ExperimentalWarning")
        .arg(runtime.directory.join(&runtime.descriptor.entrypoints.export))
        .current_dir(&runtime.directory).creation_flags(0x0800_0000)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| failure(error.to_string()))?;
    let bytes = serde_json::to_vec(request).map_err(|error| failure(error.to_string()))?;
    if bytes.len() > 1024 * 1024 { let _ = child.kill(); let _ = child.wait(); return Err(failure("独立导出请求过大。")); }
    if let Err(error) = child.stdin.take().ok_or_else(|| failure("独立导出通道不可用。"))?.write_all(&bytes) {
        let _ = child.kill(); let _ = child.wait(); return Err(failure(error.to_string()));
    }
    let status = child.wait().map_err(|error| failure(error.to_string()))?;
    if !status.success() { return Err(failure("独立导出未完成；原资料保留。")); }
    Ok(())
}
