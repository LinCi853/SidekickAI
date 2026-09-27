use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn log_root() -> Result<PathBuf, String> {
    #[cfg(test)]
    { return Ok(std::env::temp_dir().join(format!("sidekick-diagnostic-tests-{}", std::process::id()))); }
    #[cfg(not(test))]
    { std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("SidekickAI/installer-logs"))
        .ok_or_else(|| "无法定位本地日志目录".into()) }
}

fn log_path(operation_id: &str) -> Result<PathBuf, String> {
    if operation_id.is_empty() || operation_id.len() > 160 || !operation_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err("日志操作标识无效".into());
    }
    let root = log_root()?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建日志目录：{error}"))?;
    super::harden_private_directory(&root).map_err(|error| error.message)?;
    Ok(root.join(format!("{operation_id}.log")))
}

pub fn save_operation_log(operation_id: &str, text: &str) -> Result<String, String> {
    let path = log_path(operation_id)?;
    fs::write(&path, text).map_err(|error| format!("无法保存操作日志：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub(crate) fn append_operation_log(operation_id: &str, text: &str) -> Result<String, String> {
    let path = log_path(operation_id)?;
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or_default();
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|error| error.to_string())?;
    writeln!(file, "{timestamp}\t{text}").map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_operation_log(log_path: String) -> Result<(), String> {
    let path = Path::new(&log_path);
    let root = fs::canonicalize(log_root()?).map_err(|error| error.to_string())?;
    let resolved = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if resolved.parent() != Some(root.as_path()) || resolved.extension().and_then(|value| value.to_str()) != Some("log") || !resolved.is_file() {
        return Err("只能打开本应用保存的操作日志".into());
    }
    std::process::Command::new("notepad.exe").arg(resolved).spawn().map_err(|error| format!("无法打开日志：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_logs_survive_replacement_and_reject_path_components() {
        let id = format!("diagnostic-{}", std::process::id());
        let path = save_operation_log(&id, "I|begin\n").unwrap();
        append_operation_log(&id, "completed").unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("I|begin") && content.contains("completed"));
        assert!(save_operation_log("../escape", "invalid").is_err());
        fs::remove_file(path).unwrap();
    }
}
