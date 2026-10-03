//! Explicit private-profile acceptance for native completion and window closure.

use std::path::{Path, PathBuf};
use std::time::Instant;
use serde_json::json;
use sha2::{Digest, Sha256};

#[test]
#[ignore = "Requires a verified private application and an interactive fixture driver"]
fn native_completion_closes_its_window_and_continues_the_installation_log() {
    let root = PathBuf::from(std::env::var("SIDEKICK_APPLICATION_TEST_ROOT").expect("private fixture root required"));
    let build = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build").canonicalize().unwrap();
    assert!(root.canonicalize().unwrap().starts_with(&build));
    assert!(root.join("ui-fixture.json").is_file());
    for variable in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        assert!(PathBuf::from(std::env::var_os(variable).unwrap()).canonicalize().unwrap().starts_with(root.canonicalize().unwrap()));
    }
    let target = PathBuf::from(std::env::var("SIDEKICK_APPLICATION_ACCEPTANCE_TARGET").expect("verified target required"));
    assert!(target.canonicalize().unwrap().starts_with(root.canonicalize().unwrap()));
    crate::application_launch::validate_target(&target).unwrap();
    let key = format!("{:x}", Sha256::digest(target.to_string_lossy().replace('/', "\\").to_lowercase().as_bytes()));
    let preference = PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("SidekickAI-Startup").join(&key[..24]).join("mode.json");
    std::fs::create_dir_all(preference.parent().unwrap()).unwrap();
    std::fs::write(&preference, r#"{"schema":1,"administrator":true}"#).unwrap();
    assert!(!crate::application_launch::needs_elevated_inspection(&target).unwrap());
    std::fs::remove_file(preference).unwrap();
    let operation = sidekickai_uninstall_core::random_id("install").unwrap();
    crate::completion_log::bind(&operation, "I|Private fixture deployment completed\n".into());
    std::fs::write(root.join("ui-operation.json"), json!({ "operationId": operation, "target": target, "inspectionElevated": false }).to_string()).unwrap();
    let opened = Instant::now();
    crate::run();
    crate::end_completion();
    let log_path = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join("SidekickAI/installer-logs").join(format!("{operation}.log"));
    let log = std::fs::read_to_string(&log_path).unwrap();
    let (pipe, owners) = super::inventory().unwrap();
    let milliseconds = opened.elapsed().as_millis();
    super::wait_for_exit(&pipe, &owners, std::time::Duration::from_secs(10)).unwrap();
    assert_eq!(owners.len(), 1);
    assert!(sidekickai_uninstall_core::path::paths_equal(&owners[0].executable, &target));
    for message in ["Private fixture deployment completed", "已选择打开本次安装", "正在核对已有程序", "正在启动本次安装", "窗口就绪", "本次安装的程序已打开", "向导窗口已关闭"] { assert!(log.contains(message), "missing {message}: {log}"); }
    assert!(!log.contains("正在保存并关闭已有程序"));
    assert!(!log.contains("等待系统授权"));
    std::fs::write(root.join("ui-result.json"), json!({ "ok": true, "operationId": operation, "targetPid": owners[0].pid,
        "milliseconds": milliseconds, "logPath": log_path, "noPreviousOwner": true, "inspectionElevated": false,
        "windowClosed": true, "applicationReady": true }).to_string()).unwrap();
}
