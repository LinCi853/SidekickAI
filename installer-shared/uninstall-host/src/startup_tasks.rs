//! Installation-bound administrator startup task maintenance.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sidekickai_uninstall_core::product;
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod native;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskEntry { pub name: String, pub sid: String, pub xml: String, pub sddl: String }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSnapshot { pub executable: Option<String>, pub tasks: Vec<TaskEntry> }

pub fn snapshot_installation(directory: &Path) -> Result<TaskSnapshot, String> {
    let Some(executable) = community_executable(directory) else { return Ok(TaskSnapshot::default()); };
    let result = run_helper(&json!({ "operation": "snapshot-installation", "executable": executable }))?;
    serde_json::from_value(result).map_err(|error| format!("无法读取启动任务恢复清单：{error}"))
}

pub fn remove_snapshot(snapshot: &TaskSnapshot) -> Result<(), String> {
    if snapshot.tasks.is_empty() { return Ok(()); }
    run_helper(&json!({ "operation": "remove-snapshot", "snapshot": snapshot })).map(|_| ())
}

pub fn restore_snapshot(snapshot: &TaskSnapshot) -> Result<(), String> {
    if snapshot.tasks.is_empty() { return Ok(()); }
    run_helper(&json!({ "operation": "restore-snapshot", "snapshot": snapshot })).map(|_| ())
}

fn community_executable(directory: &Path) -> Option<PathBuf> {
    product::installation_edition(directory)
        .filter(|(edition, _)| *edition == "community")
        .map(|_| directory.join(&product::product().executable))
}

fn invoke_with(
    operation: &str,
    directory: &Path,
    runner: &mut impl FnMut(&Value) -> Result<Value, String>,
) -> Result<Option<Value>, String> {
    let Some(executable) = community_executable(directory) else { return Ok(None); };
    runner(&json!({ "operation": operation, "executable": executable }))
        .map(Some)
        .map_err(|error| format!("无法维护管理员启动任务（{}）：{error}", directory.display()))
}

fn task_count_with(
    directory: &Path,
    runner: &mut impl FnMut(&Value) -> Result<Value, String>,
) -> Result<u64, String> {
    match invoke_with("inspect-installation", directory, runner)? {
        None => Ok(0),
        Some(value) => value.get("tasks").and_then(Value::as_u64)
            .ok_or_else(|| "管理员启动任务检查返回了无效结果。".into()),
    }
}

fn maintain_with(
    directory: &Path,
    runner: &mut impl FnMut(&Value) -> Result<Value, String>,
) -> Result<(), String> {
    match invoke_with("maintain", directory, runner)? {
        None => Ok(()),
        Some(value) if value.get("ok") == Some(&Value::Bool(true)) => Ok(()),
        Some(_) => Err("管理员启动任务维护未确认成功。".into()),
    }
}

fn remove_with(
    directory: &Path,
    runner: &mut impl FnMut(&Value) -> Result<Value, String>,
) -> Result<(), String> {
    if task_count_with(directory, runner)? == 0 { return Ok(()); }
    match invoke_with("remove-installation", directory, runner)? {
        Some(value) if value.get("ok") == Some(&Value::Bool(true)) => Ok(()),
        _ => Err("管理员启动任务清理未确认成功，尚未移除此安装。".into()),
    }
}

/// A read-only probe used before the existing installer/uninstaller UAC flow.
pub fn removal_requires_elevation(directories: &[PathBuf]) -> Result<bool, String> {
    for directory in directories {
        if task_count_with(directory, &mut run_helper)? > 0 { return Ok(true); }
    }
    Ok(false)
}

/// Validate registered task ownership without creating or replacing a task.
pub fn maintain_installation(directory: &Path) -> Result<(), String> {
    maintain_with(directory, &mut run_helper)
}

/// Remove only tasks bound to the verified community installation.
pub fn remove_installation(directory: &Path) -> Result<(), String> {
    remove_with(directory, &mut run_helper)
}

#[cfg(all(windows, not(test)))]
fn run_helper(request: &Value) -> Result<Value, String> { native::run(request) }

#[cfg(any(not(windows), test))]
fn run_helper(request: &Value) -> Result<Value, String> {
    if request["operation"] == "inspect-installation" { Ok(json!({ "tasks": 0 })) }
    else if request["operation"] == "snapshot-installation" {
        Ok(json!({ "executable": request["executable"], "tasks": [] }))
    } else { Ok(json!({ "ok": true })) }
}

#[cfg(test)]
#[path = "startup_tasks_tests.rs"]
mod tests;
