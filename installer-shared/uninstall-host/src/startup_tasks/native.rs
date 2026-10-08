//! Native, installation-bound Task Scheduler snapshots and compensation.

use super::{TaskEntry, TaskSnapshot};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sidekickai_uninstall_core::path::paths_equal;
use std::path::Path;
use windows::core::{BSTR, Interface, VARIANT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::TaskScheduler::*;

mod descriptor;

struct Apartment(bool);
impl Drop for Apartment { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize(); } } } }

fn task_name(sid: &str, executable: &str) -> String {
    let normalized = executable.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    format!("SidekickAI-Community-{sid}-{}", &hash[..24])
}

unsafe fn validate_definition(definition: &ITaskDefinition, sid: &str, executable: &str) -> windows::core::Result<()> {
    let invalid = || windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32));
    let mut description = BSTR::new();
    definition.RegistrationInfo()?.Description(&mut description)?;
    let metadata: Value = serde_json::from_str(&description.to_string()).map_err(|_| invalid())?;
    if metadata["schema"] != 1 || metadata["edition"] != "community" || metadata["sid"] != sid
        || !metadata["executable"].as_str().is_some_and(|value| paths_equal(Path::new(value), Path::new(executable))) { return Err(invalid()); }
    let principal = definition.Principal()?;
    let mut user = BSTR::new(); let mut logon = TASK_LOGON_TYPE::default(); let mut level = TASK_RUNLEVEL_TYPE::default();
    principal.UserId(&mut user)?; principal.LogonType(&mut logon)?; principal.RunLevel(&mut level)?;
    if user.to_string() != sid || logon != TASK_LOGON_INTERACTIVE_TOKEN || level != TASK_RUNLEVEL_HIGHEST { return Err(invalid()); }
    let mut triggers = 0; definition.Triggers()?.Count(&mut triggers)?;
    let actions = definition.Actions()?; let mut count = 0; actions.Count(&mut count)?;
    if triggers != 0 || count != 1 { return Err(invalid()); }
    let action: IExecAction = actions.get_Item(1)?.cast()?;
    let mut target = BSTR::new(); let mut args = BSTR::new(); let mut working = BSTR::new();
    action.Path(&mut target)?; action.Arguments(&mut args)?; action.WorkingDirectory(&mut working)?;
    if !paths_equal(Path::new(&target.to_string()), Path::new(executable)) || args.to_string() != "--sidekick-admin-task"
        || !Path::new(executable).parent().is_some_and(|parent| paths_equal(Path::new(&working.to_string()), parent)) { return Err(invalid()); }
    let settings = definition.Settings()?;
    let mut enabled = Default::default(); let mut demand = Default::default();
    let mut batteries = Default::default(); let mut stop_batteries = Default::default();
    let mut idle = Default::default(); let mut network = Default::default();
    let mut limit = BSTR::new(); let mut restarts = 0; let mut instances = TASK_INSTANCES_POLICY::default();
    settings.Enabled(&mut enabled)?; settings.AllowDemandStart(&mut demand)?;
    settings.DisallowStartIfOnBatteries(&mut batteries)?; settings.StopIfGoingOnBatteries(&mut stop_batteries)?;
    settings.RunOnlyIfIdle(&mut idle)?; settings.RunOnlyIfNetworkAvailable(&mut network)?;
    settings.ExecutionTimeLimit(&mut limit)?; settings.RestartCount(&mut restarts)?; settings.MultipleInstances(&mut instances)?;
    if !enabled.as_bool() || !demand.as_bool() || batteries.as_bool() || stop_batteries.as_bool()
        || idle.as_bool() || network.as_bool() || limit.to_string() != "PT0S" || restarts != 0
        || instances != TASK_INSTANCES_PARALLEL { return Err(invalid()); }
    Ok(())
}

unsafe fn task(folder: &ITaskFolder, name: &str) -> Result<Option<IRegisteredTask>, String> {
    match folder.GetTask(&BSTR::from(name)) {
        Ok(task) => Ok(Some(task)),
        Err(error) if matches!(error.code().0 as u32, 0x80070002 | 0x80070003) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn run(request: &Value) -> Result<Value, String> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() && initialized.0 as u32 != 0x80010106 { return Err(initialized.to_string()); }
        let _apartment = Apartment(initialized.is_ok());
        let scheduler: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER).map_err(|error| error.to_string())?;
        scheduler.Connect(&VARIANT::default(), &VARIANT::default(), &VARIANT::default(), &VARIANT::default()).map_err(|error| error.to_string())?;
        let folder = scheduler.GetFolder(&BSTR::from("\\")).map_err(|error| error.to_string())?;
        let operation = request["operation"].as_str().ok_or("缺少启动任务操作。")?;
        if matches!(operation, "restore-snapshot" | "remove-snapshot") {
            let snapshot: TaskSnapshot = serde_json::from_value(request["snapshot"].clone()).map_err(|error| error.to_string())?;
            let executable = snapshot.executable.as_deref().ok_or("恢复清单未绑定程序。")?;
            for entry in &snapshot.tasks {
                if entry.sid != crate::execute::current_user_sid().map_err(|error| error.message)? || entry.name != task_name(&entry.sid, executable) {
                    return Err("启动任务恢复清单身份不一致。".into());
                }
                let definition = scheduler.NewTask(0).map_err(|error| error.to_string())?;
                definition.SetXmlText(&BSTR::from(&entry.xml)).map_err(|error| error.to_string())?;
                validate_definition(&definition, &entry.sid, executable).map_err(|_| "启动任务恢复清单超出限定权限。")?;
                if !descriptor::valid(&entry.sddl, &entry.sid) { return Err("启动任务恢复清单的访问权限无效。".into()); }
                let existing = task(&folder, &entry.name)?;
                if let Some(existing) = existing {
                    if existing.Xml().map_err(|error| error.to_string())?.to_string() != entry.xml
                        || existing.GetSecurityDescriptor(7).map_err(|error| error.to_string())?.to_string() != entry.sddl {
                        return Err("启动任务已由外部修改，已保留冲突。".into());
                    }
                    if operation == "remove-snapshot" { folder.DeleteTask(&BSTR::from(&entry.name), 0).map_err(|error| error.to_string())?; }
                } else if operation == "restore-snapshot" {
                    folder.RegisterTask(&BSTR::from(&entry.name), &BSTR::from(&entry.xml), TASK_CREATE.0 | TASK_IGNORE_REGISTRATION_TRIGGERS.0 | TASK_DONT_ADD_PRINCIPAL_ACE.0,
                        &VARIANT::from(entry.sid.as_str()), &VARIANT::default(), TASK_LOGON_INTERACTIVE_TOKEN,
                        &VARIANT::from(entry.sddl.as_str())).map_err(|error| error.to_string())?;
                }
            }
            return Ok(json!({ "ok": true }));
        }
        if !matches!(operation, "inspect-installation" | "snapshot-installation" | "maintain" | "remove-installation") { return Err("不支持的启动任务维护操作。".into()); }
        let executable = request["executable"].as_str().ok_or("缺少已核实程序位置。")?;
        let sid = crate::execute::current_user_sid().map_err(|error| error.message)?;
        let name = task_name(&sid, executable);
        let mut snapshot = TaskSnapshot { executable: Some(executable.into()), tasks: Vec::new() };
        if let Some(existing) = task(&folder, &name)? {
            validate_definition(&existing.Definition().map_err(|error| error.to_string())?, &sid, executable)
                .map_err(|_| "管理员启动任务身份或执行内容发生变化，已保留原任务。")?;
            snapshot.tasks.push(TaskEntry { name, sid, xml: existing.Xml().map_err(|error| error.to_string())?.to_string(),
                sddl: existing.GetSecurityDescriptor(7).map_err(|error| error.to_string())?.to_string() });
            let entry = &snapshot.tasks[0];
            if !descriptor::valid(&entry.sddl, &entry.sid) { return Err("管理员启动任务访问权限发生变化，已保留原任务。".into()); }
        }
        if operation == "snapshot-installation" { return serde_json::to_value(snapshot).map_err(|error| error.to_string()); }
        if operation == "inspect-installation" { return Ok(json!({ "tasks": snapshot.tasks.len() })); }
        if operation == "remove-installation" { return run(&json!({ "operation": "remove-snapshot", "snapshot": snapshot })); }
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_task_definition_is_not_a_valid_startup_snapshot() {
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
            assert!(initialized.is_ok());
            let _apartment = Apartment(true);
            let scheduler: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER).unwrap();
            let definition = scheduler.NewTask(0).unwrap();
            let sid = "S-1-5-21-1-2-3-1001";
            let executable = r"E:\fixture\SidekickAI.exe";
            definition.RegistrationInfo().unwrap().SetDescription(&BSTR::from(json!({
                "schema": 1, "edition": "community", "sid": sid, "executable": executable,
            }).to_string())).unwrap();
            let principal = definition.Principal().unwrap();
            principal.SetUserId(&BSTR::from(sid)).unwrap();
            principal.SetLogonType(TASK_LOGON_INTERACTIVE_TOKEN).unwrap();
            principal.SetRunLevel(TASK_RUNLEVEL_HIGHEST).unwrap();
            let action: IExecAction = definition.Actions().unwrap().Create(TASK_ACTION_EXEC).unwrap().cast().unwrap();
            action.SetPath(&BSTR::from(executable)).unwrap();
            action.SetArguments(&BSTR::from("--sidekick-admin-task")).unwrap();
            action.SetWorkingDirectory(&BSTR::from(r"E:\fixture")).unwrap();
            definition.Settings().unwrap().SetEnabled(windows::Win32::Foundation::VARIANT_BOOL(0)).unwrap();
            assert!(validate_definition(&definition, sid, executable).is_err());
        }
    }
}
