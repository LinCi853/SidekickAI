//! Completion records continue the admitted installation's durable log.

use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

struct Record { id: String, text: String, opened: Instant }
static CURRENT: Mutex<Option<Record>> = Mutex::new(None);

impl Record {
    fn append(&mut self, severity: &str, message: &str) -> serde_json::Value {
        self.text.push_str(&format!("{severity}|完成操作 +{} ms；{}\n", self.opened.elapsed().as_millis(), message.replace(['\r', '\n'], " ")));
        match sidekickai_uninstall_host::diagnostics::save_operation_log(&self.id, &self.text) {
            Ok(path) => serde_json::json!({ "text": self.text, "path": path }),
            Err(error) => serde_json::json!({ "text": self.text, "error": format!("完成日志未能保存：{error}") }),
        }
    }
}

pub fn bind(id: &str, text: String) {
    if let Ok(mut current) = CURRENT.lock() { *current = Some(Record { id: id.into(), text, opened: Instant::now() }); }
}

pub fn append(app: &AppHandle, severity: &str, message: &str) {
    if let Ok(mut current) = CURRENT.lock() {
        if let Some(record) = current.as_mut() {
            let payload = record.append(severity, message);
            let _ = app.emit("install-log", payload);
        }
    }
}

pub fn status(app: &AppHandle, message: &str) {
    append(app, "I", message);
    let _ = app.emit("install-status", message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Isolated { root: PathBuf, local: Option<std::ffi::OsString> }
    impl Drop for Isolated {
        fn drop(&mut self) {
            match &self.local { Some(value) => std::env::set_var("LOCALAPPDATA", value), None => std::env::remove_var("LOCALAPPDATA") }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn completion_log_keeps_installation_retry_failure_and_actual_closure() {
        let id = sidekickai_uninstall_core::random_id("completion").unwrap();
        let root = std::env::temp_dir().join(&id);
        let _isolated = Isolated { root: root.clone(), local: std::env::var_os("LOCALAPPDATA") };
        std::env::set_var("LOCALAPPDATA", &root);
        let mut record = Record { id, text: "I|Installation completed\n".into(), opened: Instant::now() };
        record.append("I", "Opening requested");
        record.append("E", "Authorization cancelled");
        record.append("I", "Opening retried");
        let saved = record.append("I", "Wizard window closed");
        let path = PathBuf::from(saved["path"].as_str().unwrap());
        assert!(path.starts_with(&root));
        let text = std::fs::read_to_string(path).unwrap();
        for message in ["Installation completed", "Opening requested", "Authorization cancelled", "Opening retried", "Wizard window closed"] { assert!(text.contains(message)); }
        assert_eq!(text.lines().count(), 5);
        assert!(text.contains(" ms；"));
    }
}
