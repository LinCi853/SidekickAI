#[cfg(test)]
#[path = "../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
use sidekickai_uninstall_core::path::{normalize_target_path, path_is_same_or_descendant, validate_tree};
use sidekickai_uninstall_core::protocol::*;
use sidekickai_uninstall_core::{current_scan, resolve_targets, validate_backup_selection, ScannedTarget, ValidatedBackupPath};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug)]
pub struct Plan {
    pub targets: Vec<ScannedTarget>,
    pub data_roots: Vec<DataRoot>,
    pub backup: Option<ValidatedBackupPath>,
}

fn pending_data_operation(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let base = [".bak-", ".restore-", ".failed-", ".reset-"].iter()
        .find_map(|suffix| name.rsplit_once(suffix).map(|(base, _)| path.with_file_name(base)))
        .unwrap_or_else(|| path.to_path_buf());
    ["restore.json", "reset.json"].iter().any(|suffix| Path::new(&format!("{}.{suffix}", base.display())).exists())
}

pub fn prepare(request: &UninstallRequest) -> Result<Plan, UninstallError> {
    validate_request(request)?;
    let targets = resolve_targets(&request.scan_id, &request.target_id, &request.additional_target_ids)?;
    let scan = current_scan().ok_or_else(|| failure(UninstallErrorCode::NoTarget, "扫描已过期，请重新扫描。"))?;
    if scan.scan_id != request.scan_id {
        return Err(failure(UninstallErrorCode::TargetChanged, "当前扫描已变更。"));
    }
    validate_plan(request, targets, &scan)
}

fn validate_plan(request: &UninstallRequest, targets: Vec<ScannedTarget>, scan: &UninstallScanResponse) -> Result<Plan, UninstallError> {
    let selected = targets.iter().map(|t| t.id.token.as_str()).collect::<HashSet<_>>();
    for target in &targets {
        target.identity.verify_unchanged()?;
        sidekickai_uninstall_core::distribution::verify_installed_identity(target.identity.path.as_path())
            .map_err(|message| failure(UninstallErrorCode::TargetNotInstall, &message))?;
        validate_tree(target.identity.path.as_path())?;
        for other in &targets {
            if other.id != target.id && (path_is_same_or_descendant(other.identity.path.as_path(), target.identity.path.as_path()) || path_is_same_or_descendant(target.identity.path.as_path(), other.identity.path.as_path())) {
                return Err(failure(UninstallErrorCode::TargetIsParent, "所选安装路径存在重叠。"));
            }
        }
    }
    let data_roots = scan.data_roots.iter().filter(|root| root.associated_target_ids.iter().any(|id| selected.contains(id.token.as_str()))).cloned().collect::<Vec<_>>();
    let confirmed_data = data_roots.iter().map(|root| std::path::PathBuf::from(&root.path)).collect::<Vec<_>>();
    for target in &targets {
        crate::discovery::validate_local_data_selection(target.identity.path.as_path(), &request.strategy, &confirmed_data)?;
    }
    // Validate all proposed scopes before permitting any process or file changes.
    for root in &data_roots {
        if request.strategy != DataStrategy::Keep && pending_data_operation(Path::new(&root.path)) {
            return Err(failure(UninstallErrorCode::TargetScopeInvalid, "应用仍有待处理的数据恢复或重置，请先启动应用完成操作，再重新扫描。"));
        }
        if request.strategy != DataStrategy::Keep && !root.removable {
            return Err(failure(UninstallErrorCode::TargetScopeInvalid, &format!(
                "无法确认用户数据的归属或安全性：{}。请在原登录账户下直接打开卸载器并重新扫描；也可选择保留用户数据。程序和数据未删除。", root.path)));
        }
        let unselected = root.associated_target_ids.iter().filter(|id| !selected.contains(id.token.as_str())).collect::<Vec<_>>();
        if request.strategy != DataStrategy::Keep && !unselected.is_empty() {
            let paths = unselected.iter().map(|id| scan.locations.iter().find(|location| &location.id == *id)
                .map(|location| location.display_path.as_str()).unwrap_or("未知安装位置")).collect::<Vec<_>>().join("、");
            return Err(failure(UninstallErrorCode::TargetScopeInvalid, &format!(
                "用户数据 {} 仍被未选中的安装使用：{}。请选择保留用户数据，或返回选择需要同时卸载的安装。程序和数据未删除。", root.path, paths)));
        }

    }
    let mut scopes = targets.iter().map(|t| t.identity.path.clone()).collect::<Vec<_>>();
    for root in &data_roots { scopes.push(normalize_target_path(&root.path)?); }
    let backup = match &request.backup {
        Some(selection) => Some(validate_backup_selection(selection, &scopes)?),
        None => None,
    };
    if request.strategy == DataStrategy::Export && data_roots.is_empty() {
        return Err(failure(UninstallErrorCode::BackupIncomplete, "没有可导出的数据目录；请选择保留用户数据。"));
    }
    Ok(Plan { targets, data_roots, backup })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sidekickai_uninstall_core::{random_id, register_scan};
    use std::fs;

    #[test]
    fn plan_validation_preserves_samples_and_rejects_shared_data() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(random_id("sidekick-plan-test").unwrap());
        let selected = root.join("Selected Installation");
        let sibling = root.join("Unselected Installation");
        let data = root.join("Data");
        for path in [&selected, &sibling, &data] { fs::create_dir_all(path).unwrap(); }
        for path in [&selected, &sibling] {
            fs::create_dir(path.join("resources")).unwrap();
            fs::write(path.join("resources/app.asar"), app_archive(b"isolated installation")).unwrap();
            fs::write(path.join("uninstall.exe"), b"isolated maintenance entry").unwrap();
            edition_fixtures::seal_installation(path);
        }
        fs::write(sibling.join("sentinel"), b"untouched").unwrap();
        fs::write(data.join("settings.db"), b"untouched").unwrap();
        let location = |path: &Path, token: &str| UninstallLocation {
            edition: sidekickai_uninstall_core::product::edition_id().into(),
            id: UninstallTargetId { token: token.into() }, path: path.to_string_lossy().into_owned(),
            display_path: path.to_string_lossy().into_owned(), source: vec![UninstallEntry::Installed],
            scope: InstallScope::PerUser, arch: UninstallArch::X64, version: None, registered: false,
            registered_roots: vec![], executable_present: false, resources_present: false,
            identity_confidence: IdentityConfidence::Strong, running_pids: vec![], removable: true,
            non_removable_reason: None, recommended: false,
        };
        let first = location(&selected, "first"); let second = location(&sibling, "second");
        let scan = register_scan("plan-test", "now", vec![first.clone(), second.clone()], vec![DataRoot {
            path: data.to_string_lossy().into_owned(), source: "fixture".into(), removable: true,
            associated_target_ids: vec![first.id, second.id],
        }], None).unwrap();
        let mut request = UninstallRequest {
            protocol_version: UNINSTALL_PROTOCOL_VERSION, request_id: "test-request".into(), scan_id: scan.scan_id,
            target_id: scan.locations[0].id.clone(), strategy: DataStrategy::Keep, backup: None,
            additional_target_ids: vec![], confirmation: UNINSTALL_CONFIRMATION.into(), resume_task_id: None,
        };
        let plan = prepare(&request).unwrap();
        assert_eq!(plan.targets.len(), 1); assert_eq!(plan.data_roots.len(), 1); assert!(plan.backup.is_none());
        request.strategy = DataStrategy::Delete;
        let shared_error = prepare(&request).unwrap_err();
        assert_eq!(shared_error.code, UninstallErrorCode::TargetScopeInvalid);
        assert!(shared_error.message.contains(sibling.to_string_lossy().as_ref()));
        assert!(shared_error.message.contains(data.to_string_lossy().as_ref()));
        assert!(shared_error.message.contains("保留用户数据"));
        let mut untrusted_scan = current_scan().unwrap();
        untrusted_scan.data_roots[0].removable = false;
        let error = validate_plan(&request, resolve_targets(&request.scan_id, &request.target_id, &[]).unwrap(), &untrusted_scan).unwrap_err();
        assert!(error.message.contains("原登录账户"));
        assert!(error.message.contains(data.to_string_lossy().as_ref()));
        request.strategy = DataStrategy::Export;
        request.backup = Some(BackupSelection { format: BackupFormat::Zip, output_path: selected.join("backup.zip").to_string_lossy().into_owned(), encrypt: false, password: None, categories: vec!["basicData".into()], staging_path: None });
        request.additional_target_ids = vec![scan.locations[1].id.clone()];
        assert_eq!(prepare(&request).unwrap_err().code, UninstallErrorCode::BackupPathInScope);

        request.strategy = DataStrategy::Delete;
        request.backup = None;
        let pending = root.join("Data.restore.json");
        fs::write(&pending, b"pending restore").unwrap();
        assert_eq!(prepare(&request).unwrap_err().code, UninstallErrorCode::TargetScopeInvalid);
        fs::remove_file(pending).unwrap();

        let recovery = root.join("Data.bak-1234567890123");
        fs::create_dir(&recovery).unwrap();
        fs::write(recovery.join("settings.db"), b"recovery data").unwrap();
        let pending = root.join("Data.restore.json");
        fs::write(&pending, b"pending restore").unwrap();
        assert!(pending_data_operation(&recovery));
        fs::remove_file(pending).unwrap();
        let mut recovery_roots = scan.data_roots.clone();
        let mut previous = recovery_roots[0].clone();
        previous.path = recovery.to_string_lossy().into_owned();
        recovery_roots.push(previous);
        let updated_scan = register_scan("recovery-plan", "now", scan.locations.clone(), recovery_roots, None).unwrap();
        request.scan_id = updated_scan.scan_id;
        request.target_id = updated_scan.locations[0].id.clone();
        request.additional_target_ids = vec![updated_scan.locations[1].id.clone()];
        request.strategy = DataStrategy::Export;
        request.backup = Some(BackupSelection { format: BackupFormat::Zip, output_path: root.join("backup.zip").to_string_lossy().into_owned(), encrypt: false, password: None, categories: vec!["basicData".into()], staging_path: None });
        let multi_root = prepare(&request).unwrap();
        assert_eq!(multi_root.data_roots.len(), 2);
        assert!(multi_root.backup.is_some());
        assert_eq!(fs::read(recovery.join("settings.db")).unwrap(), b"recovery data");
        assert_eq!(fs::read(sibling.join("sentinel")).unwrap(), b"untouched");
        assert_eq!(fs::read(data.join("settings.db")).unwrap(), b"untouched");
        assert!(root.is_absolute() && root.file_name().unwrap().to_string_lossy().starts_with("sidekick-plan-test-"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_portable_marker_cannot_authorize_new_maintenance() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(random_id("sidekick-plan-portable").unwrap());
        let portable = root.join("SidekickAI-Portable");
        let data = portable.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"portable data").unwrap();
        fs::write(portable.join("portable.txt"), b"portable").unwrap();

        let location = UninstallLocation {
            edition: sidekickai_uninstall_core::product::edition_id().into(),
            id: UninstallTargetId { token: "portable-first".into() },
            path: portable.to_string_lossy().into_owned(),
            display_path: portable.to_string_lossy().into_owned(),
            source: vec![UninstallEntry::Installed],
            scope: InstallScope::Portable,
            arch: UninstallArch::X64,
            version: None,
            registered: false,
            registered_roots: vec![],
            executable_present: true,
            resources_present: true,
            identity_confidence: IdentityConfidence::Strong,
            running_pids: vec![],
            removable: true,
            non_removable_reason: None,
            recommended: true,
        };
        let scan = register_scan("portable-plan", "now", vec![location], vec![DataRoot {
            path: data.to_string_lossy().into_owned(),
            source: "portable-marker".into(),
            removable: true,
            associated_target_ids: vec![UninstallTargetId { token: "portable-first".into() }],
        }], None).unwrap();
        let request = UninstallRequest {
            protocol_version: UNINSTALL_PROTOCOL_VERSION, request_id: "portable-request".into(), scan_id: scan.scan_id,
            target_id: scan.locations[0].id.clone(), strategy: DataStrategy::Keep, backup: None,
            additional_target_ids: vec![], confirmation: UNINSTALL_CONFIRMATION.into(), resume_task_id: None,
        };

        assert_eq!(prepare(&request).unwrap_err().code, UninstallErrorCode::TargetNotInstall);
        assert_eq!(fs::read(data.join("settings.db")).unwrap(), b"portable data");
        let _ = fs::remove_dir_all(&root);
    }

    /// A scan supersedes older tokens, and a token can never be replayed under a
    /// different scan id: the UI might still be showing results from either window.
    #[test]
    fn prepare_rejects_tokens_from_a_superseded_scan() {
        let _guard = crate::SCAN_TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(random_id("sidekick-plan-stale").unwrap());
        let first = root.join("SidekickAI");
        let second = root.join("SidekickAI-second");
        for directory in [&first, &second] {
            fs::create_dir_all(directory.join("resources")).unwrap();
            fs::write(directory.join("SidekickAI.exe"), b"exe").unwrap();
            fs::write(directory.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
            fs::write(directory.join("uninstall.exe"), b"uninstaller").unwrap();
            edition_fixtures::seal_installation(directory);
        }
        let location = |path: &Path, token: &str| UninstallLocation {
            edition: sidekickai_uninstall_core::product::edition_id().into(),
            id: UninstallTargetId { token: token.into() },
            path: path.to_string_lossy().into_owned(),
            display_path: path.to_string_lossy().into_owned(),
            source: vec![UninstallEntry::Installed],
            scope: InstallScope::PerUser,
            arch: UninstallArch::X64,
            version: None,
            registered: false,
            registered_roots: vec![],
            executable_present: true,
            resources_present: true,
            identity_confidence: IdentityConfidence::Strong,
            running_pids: vec![],
            removable: true,
            non_removable_reason: None,
            recommended: false,
        };

        let scan_a = register_scan("scan-a", "now", vec![location(&first, "token-a")], vec![], None).unwrap();
        let stale_token = scan_a.locations[0].id.clone();
        let scan_b = register_scan("scan-b", "now", vec![location(&second, "token-b")], vec![], None).unwrap();
        let fresh_token = scan_b.locations[0].id.clone();

        let base = |scan_id: &str, target_id: UninstallTargetId| UninstallRequest {
            protocol_version: UNINSTALL_PROTOCOL_VERSION, request_id: "stale-request".into(), scan_id: scan_id.to_string(),
            target_id, strategy: DataStrategy::Keep, backup: None,
            additional_target_ids: vec![], confirmation: UNINSTALL_CONFIRMATION.into(), resume_task_id: None,
        };

        // The superseded token is refused once a newer scan is active.
        assert_eq!(
            prepare(&base(&scan_a.scan_id, stale_token.clone())).unwrap_err().code,
            UninstallErrorCode::TargetNotConfirmed
        );
        // ...and it cannot be replayed under the active scan id either.
        assert_eq!(
            prepare(&base(&scan_b.scan_id, stale_token)).unwrap_err().code,
            UninstallErrorCode::TargetNotConfirmed
        );
        // The active scan's own token still works.
        assert!(prepare(&base(&scan_b.scan_id, fresh_token)).is_ok());

        let _ = fs::remove_dir_all(&root);
    }
}

fn failure(code: UninstallErrorCode, message: &str) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::Validating, false, "")
}
