use super::*;
use std::time::{Duration, Instant};

fn fixture(root: &Path) -> (InstallRequest, EngineHooks, String) {
    let req = request(&root.join("install"), false);
    let key = format!("HKCU\\Software\\SidekickAI-InstallRecovery-{}", root.file_name().unwrap().to_string_lossy());
    let mut hooks = isolated_hooks(root);
    hooks.registration_key = Some(key.clone());
    hooks.extracted = Some(root.join("payload"));
    (req, hooks, key)
}

#[test]
fn interrupted_installation_child() {
    let Ok(path) = std::env::var("SIDEKICK_INSTALL_CRASH_FIXTURE") else { return; };
    let root = PathBuf::from(path);
    assert!(root.file_name().unwrap().to_string_lossy().starts_with("sidekick-install-crash-"));
    assert_eq!(fs::read(root.join("fixture-owner")).unwrap(), b"isolated installation recovery");
    let (mut req, hooks, _) = fixture(&root);
    if std::env::var("SIDEKICK_INSTALL_INTERRUPT_AT").as_deref() == Ok("registry-second-prepared") {
        let (_, _, key) = fixture(&root);
        let _transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
        use winreg::types::ToRegValue;
        super::super::transaction::registry_intent(&key, "DisplayVersion", Some("first".to_reg_value())).unwrap();
        create_registry_key(&key).unwrap().set_value("DisplayVersion", &"first").unwrap();
        super::super::transaction::registry_intent(&key, "DisplayVersion", Some("second".to_reg_value())).unwrap();
        hooks.checkpoint("registry-second-prepared").unwrap();
    }
    if std::env::var("SIDEKICK_INSTALL_CRASH_MODE").as_deref() == Ok("repair") { req.mode = InstallMode::Repair; }
    req.create_desktop_shortcut = true;
    run_with(&req, &hooks).unwrap();
}

#[test]
fn killed_installation_restores_original_files_values_and_shortcuts() {
    for (mode, checkpoint) in [("install", "prepared"), ("install", "backup-before-seal"), ("install", "old-directory-moved"), ("install", "new-directory-present"), ("install", "portable-state-before-move"), ("install", "portable-state-moved-before-seal"), ("install", "registration-written"), ("install", "before-commit"), ("install", "registry-second-prepared"), ("repair", "prepared"), ("repair", "repair-registration-written"), ("repair", "before-commit")] {
        let id = sidekickai_uninstall_core::random_id("sidekick-install-crash").unwrap();
        let root = std::env::temp_dir().join(id);
        fs::create_dir(&root).unwrap();
        fs::write(root.join("fixture-owner"), b"isolated installation recovery").unwrap();
        let (req, hooks, key) = fixture(&root);
let (old_exe, _) = write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
        write_valid_payload(&root.join("payload"), 0x55, 0x56);
        fs::create_dir(root.join("install/data")).unwrap();
        fs::write(root.join("install/data/original.db"), b"original application data").unwrap();
        fs::create_dir_all(root.join("install/resources/cloud")).unwrap();
        fs::write(root.join("install/resources/cloud/retained.json"), b"retained acquired resource").unwrap();
        create_registry_key(&key).unwrap().set_value("DisplayVersion", &"original-version").unwrap();
        create_registry_key(&key).unwrap().set_value("ExternalValue", &"untouched").unwrap();
        super::super::shortcuts::create_shortcuts(&hooks, false, &root.join("install")).unwrap();
        let link = hooks.desktop_dir(false).join("SidekickAI.lnk");
        let link_bytes = fs::read(&link).unwrap();
        let marker = root.join("interrupted.txt");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap()).hidden()
            .args(["--exact", "engine::tests::recovery::interrupted_installation_child", "--nocapture"])
            .env("SIDEKICK_INSTALL_CRASH_FIXTURE", &root)
            .env("SIDEKICK_INSTALL_CRASH_MODE", mode)
            .env("SIDEKICK_INSTALL_INTERRUPT_AT", checkpoint)
            .env("SIDEKICK_INSTALL_INTERRUPT_MARKER", &marker)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while !marker.exists() {
            if let Some(code) = child.try_wait().unwrap() { panic!("fixture exited before {checkpoint}: {code}; {}", root.display()); }
            if Instant::now() >= deadline { child.kill().unwrap(); child.wait().unwrap(); panic!("fixture deadline at {checkpoint}: {}", root.display()); }
            std::thread::sleep(Duration::from_millis(25));
        }
        child.kill().unwrap(); child.wait().unwrap();
        let error = run_with(&req, &hooks).unwrap_err();
        assert!(error.contains("已恢复上次中断"), "{checkpoint}: {error}");
        assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), old_exe, "{checkpoint}");
        assert_eq!(fs::read(root.join("install/data/original.db")).unwrap(), b"original application data");
        assert_eq!(fs::read(root.join("install/resources/cloud/retained.json")).unwrap(), b"retained acquired resource", "{checkpoint}");
        assert_eq!(read_registry_string(&key, "DisplayVersion").unwrap().as_deref(), Some("original-version"));
        assert_eq!(read_registry_string(&key, "ExternalValue").unwrap().as_deref(), Some("untouched"));
        assert_eq!(read_registry_string(&key, "NoRepair").unwrap(), None);
        assert_eq!(fs::read(&link).unwrap(), link_bytes);
        assert!(!super::super::transaction::root_for(&root.join("install")).unwrap().exists());
        let unfinished = stray_staging_dirs(&root.join("install"));
        if ["backup-before-seal", "portable-state-before-move", "portable-state-moved-before-seal"].contains(&checkpoint) {
            assert_eq!(unfinished.len(), 1);
            assert_eq!(fs::read(unfinished[0].join("SidekickAI.exe")).unwrap(), old_exe);
        } else { assert!(unfinished.is_empty()); }
        cleanup_registry_key(&key);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn registry_write_ahead_accepts_the_previous_planned_value_after_interruption() {
    let root = temporary_root("install-registry-write-ahead");
    let (req, hooks, key) = fixture(&root);
    write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    create_registry_key(&key).unwrap().set_value("DisplayVersion", &"original").unwrap();
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    use winreg::types::ToRegValue;
    super::super::transaction::registry_intent(&key, "DisplayVersion", Some("first".to_reg_value())).unwrap();
    create_registry_key(&key).unwrap().set_value("DisplayVersion", &"first").unwrap();
    super::super::transaction::registry_intent(&key, "DisplayVersion", Some("second".to_reg_value())).unwrap();
    drop(transaction);
    assert!(super::super::transaction::recover(&req, &hooks).unwrap());
    assert_eq!(read_registry_string(&key, "DisplayVersion").unwrap().as_deref(), Some("original"));
    cleanup_registry_key(&key); fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollback_removes_a_new_registration_without_erasing_external_values() {
    let root = temporary_root("install-new-registration-rollback");
    let (req, hooks, key) = fixture(&root);
    write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    cleanup_registry_key(&key);
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    write_uninstall_registration(&root.join("install"), &key).unwrap();
    drop(transaction);
    super::super::transaction::recover(&req, &hooks).unwrap();
    assert!(snapshot_registration(&key).unwrap().is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn committed_installation_only_retries_backup_cleanup() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("install-committed-cleanup");
    let (req, hooks, key) = fixture(&root);
    write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    let journal = super::super::transaction::root_for(&root.join("install")).unwrap();
    let locked = fs::OpenOptions::new().read(true).share_mode(0).open(journal.join("original-0/SidekickAI.exe")).unwrap();
    fs::write(root.join("install/SidekickAI.exe"), b"committed installation").unwrap();
    assert!(transaction.commit().unwrap_err().contains("安装已提交"));
    assert!(super::super::transaction::committed(&root.join("install")).unwrap());
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), b"committed installation");
    drop(locked);
    run_with(&req, &hooks).unwrap();
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), b"committed installation");
    assert!(!journal.exists());
    cleanup_registry_key(&key); fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_preserves_external_registry_changes_and_file_conflicts() {
    let root = temporary_root("install-recovery-conflict");
    let (req, hooks, key) = fixture(&root);
    write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    let original = fs::read(root.join("install/SidekickAI.exe")).unwrap();
    create_registry_key(&key).unwrap().set_value("DisplayVersion", &"original-version").unwrap();
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    use winreg::types::ToRegValue;
    super::super::transaction::registry_intent(&key, "DisplayVersion", Some("next-version".to_reg_value())).unwrap();
    create_registry_key(&key).unwrap().set_value("DisplayVersion", &"external-version").unwrap();
    fs::write(root.join("install/SidekickAI.exe"), b"external file change").unwrap();
    drop(transaction);
    let error = super::super::transaction::recover(&req, &hooks).unwrap_err();
    assert!(error.contains("未覆盖外部改动"));
    assert_eq!(read_registry_string(&key, "DisplayVersion").unwrap().as_deref(), Some("external-version"));
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), original);
    let conflict = fs::read_dir(&root).unwrap().filter_map(Result::ok).find(|entry| entry.file_name().to_string_lossy().starts_with(".sidekick-recovery-conflict")).unwrap().path();
    assert_eq!(fs::read(conflict.join("SidekickAI.exe")).unwrap(), b"external file change");
    create_registry_key(&key).unwrap().set_value("DisplayVersion", &"original-version").unwrap();
    assert!(super::super::transaction::recover(&req, &hooks).unwrap());
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn write_probe_preserves_existing_names_and_handles_missing_parents() {
    let root = temporary_root("installation-write-probe");
    let sentinel = root.join(format!(".sidekick-write-test-{}", std::process::id()));
    fs::write(&sentinel, b"original probe collision").unwrap();
    assert!(crate::elevate::dir_is_writable(&root));
    assert!(crate::elevate::dir_is_writable(&root.join("missing/target")));
    assert_eq!(fs::read(&sentinel).unwrap(), b"original probe collision");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reopening_an_empty_recovery_directory_preserves_the_original_installation() {
    let root = temporary_root("install-empty-recovery");
    let (req, hooks, key) = fixture(&root);
    let (original, _) = write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    let journal = super::super::transaction::root_for(&root.join("install")).unwrap();
    fs::create_dir(&journal).unwrap();
    sidekickai_uninstall_host::harden_private_directory(&journal).unwrap();
    let error = run_with(&req, &hooks).unwrap_err();
    assert!(error.contains("已恢复上次中断"), "{error}");
    assert!(!journal.exists());
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), original);
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn committed_cleanup_retries_retained_backups_without_changing_the_installation() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("install-retained-cleanup");
    let (req, hooks, key) = fixture(&root);
    write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    let backup = root.join("SidekickAI-Backup-private-fixture");
    super::super::transaction::retain(&backup).unwrap();
    fs::create_dir(&backup).unwrap();
    fs::write(backup.join("old-file"), b"old bytes").unwrap();
    super::super::transaction::bind_retained(&backup).unwrap();
    super::super::transaction::seal_retained(&backup).unwrap();
    let locked = fs::OpenOptions::new().read(true).share_mode(0).open(backup.join("old-file")).unwrap();
    fs::write(root.join("install/SidekickAI.exe"), b"committed installation").unwrap();
    let result = transaction.commit();
    assert!(result.as_ref().is_err_and(|error| error.contains("安装已提交")), "{result:?}");
    assert!(super::super::transaction::committed(&root.join("install")).unwrap());
    drop(locked);
    run_with(&req, &hooks).unwrap();
    assert!(!backup.exists());
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), b"committed installation");
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn staging_selection_rejects_owned_targets_and_allows_an_independent_directory() {
    let root = temporary_root("install-staging-selection");
    let (mut req, hooks, key) = fixture(&root);
    let (original, _) = write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    write_valid_payload(&root.join("payload"), 0x55, 0x56);
    req.staging_dir = root.join("install/temporary").to_string_lossy().into_owned();
    let error = run_with(&req, &hooks).unwrap_err();
    assert!(error.contains("暂存位置不能位于"), "{error}");
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), original);
    assert!(!root.join("install/temporary").exists());
    req.staging_dir = root.join("selected-staging").to_string_lossy().into_owned();
    let selected = super::super::preflight::staging_directory(&req).unwrap();
    assert!(sidekickai_uninstall_core::path::paths_equal(&selected, &root.join("selected-staging")));
    run_with(&req, &hooks).unwrap();
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), pe_fixture(0x55));
    assert!(fs::read_dir(&selected).unwrap().next().is_none());
    let mut old_request = serde_json::to_value(&req).unwrap();
    old_request.as_object_mut().unwrap().remove("stagingDir");
    assert!(serde_json::from_value::<InstallRequest>(old_request).unwrap().staging_dir.is_empty());
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn committed_cleanup_preserves_replaced_or_modified_retained_directories() {
    let mut outcomes = Vec::new();
    for replacement in [false, true] {
        let root = temporary_root(if replacement { "install-retained-replaced" } else { "install-retained-modified" });
        let (req, hooks, key) = fixture(&root);
        write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
        let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
        let retained = root.join("SidekickAI-Backup-private-fixture");
        fs::create_dir(&retained).unwrap();
        fs::write(retained.join("old-file"), b"old bytes").unwrap();
        super::super::transaction::retain(&retained).unwrap();
        if replacement {
            fs::rename(&retained, root.join("original-retained")).unwrap();
            fs::create_dir(&retained).unwrap();
        }
        fs::write(retained.join("external-file"), b"external bytes").unwrap();
        let result = transaction.commit();
        let preserved = fs::read(retained.join("external-file")).ok().as_deref() == Some(b"external bytes".as_slice());
        outcomes.push((replacement, result.is_err(), preserved));
        if result.is_err() {
            assert!(super::super::transaction::committed(&root.join("install")).unwrap());
            assert!(run_with(&req, &hooks).is_err());
            assert_eq!(fs::read(retained.join("external-file")).unwrap(), b"external bytes");
        }
        cleanup_registry_key(&key);
        fs::remove_dir_all(root).unwrap();
    }
    assert!(outcomes.iter().all(|(_, rejected, preserved)| *rejected && *preserved), "{outcomes:?}");
}

#[test]
fn retained_identity_rejects_a_replacement_with_identical_bytes() {
    let root = temporary_root("retained-identical-replacement");
    let directory = root.join("owned");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("file"), b"same bytes").unwrap();
    let seal = super::super::retained::TreeSeal::capture(&directory).unwrap();
    fs::rename(&directory, root.join("original")).unwrap();
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("file"), b"same bytes").unwrap();
    assert!(seal.verify(&directory, false).is_err());
    assert!(seal.remove_verified(&directory).is_err());
    assert_eq!(fs::read(directory.join("file")).unwrap(), b"same bytes");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_cleanup_never_enumerates_late_external_content_for_deletion() {
    let root = temporary_root("retained-late-content");
    let directory = root.join("owned");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("original"), b"owned bytes").unwrap();
    let seal = super::super::retained::TreeSeal::capture(&directory).unwrap();
    seal.verify(&directory, false).unwrap();
    fs::write(directory.join("late-external"), b"external bytes").unwrap();
    let error = seal.remove_verified(&directory).unwrap_err();
    assert!(error.contains("未登记内容"), "{error}");
    assert_eq!(fs::read(directory.join("late-external")).unwrap(), b"external bytes");
    assert!(seal.verify(&directory, true).is_err());
    fs::remove_file(directory.join("late-external")).unwrap();
    seal.verify(&directory, true).unwrap();
    seal.remove_verified(&directory).unwrap();
    assert!(!directory.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsealed_retained_content_survives_rollback_and_does_not_block_a_new_task() {
    let root = temporary_root("retained-unsealed-recovery");
    let (req, hooks, key) = fixture(&root);
    let (original, _) = write_valid_installed_payload(&root.join("install"), 0x35, 0x36);
    let transaction = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    let retained = root.join("SidekickAI-Replace-unsealed");
    super::super::transaction::retain(&retained).unwrap();
    fs::create_dir(&retained).unwrap();
    super::super::transaction::bind_retained(&retained).unwrap();
    fs::write(retained.join("unknown"), b"unsealed bytes").unwrap();
    fs::write(root.join("install/SidekickAI.exe"), b"interrupted installation").unwrap();
    drop(transaction);
    super::super::transaction::recover(&req, &hooks).unwrap();
    assert_eq!(fs::read(root.join("install/SidekickAI.exe")).unwrap(), original);
    assert_eq!(fs::read(retained.join("unknown")).unwrap(), b"unsealed bytes");
    let next = super::super::transaction::Transaction::begin(&req, &hooks).unwrap();
    next.commit().unwrap();
    assert_eq!(fs::read(retained.join("unknown")).unwrap(), b"unsealed bytes");
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_manifest_rejects_paths_outside_its_root() {
    let root = temporary_root("retained-manifest-boundary");
    let directory = root.join("owned");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("original"), b"owned bytes").unwrap();
    fs::write(root.join("external"), b"external bytes").unwrap();
    let seal = super::super::retained::TreeSeal::capture(&directory).unwrap();
    let mut manifest = serde_json::to_value(seal).unwrap();
    manifest["entries"][1]["relative"] = serde_json::json!("../external");
    let invalid: super::super::retained::TreeSeal = serde_json::from_value(manifest).unwrap();
    assert!(invalid.remove_verified(&directory).unwrap_err().contains("越界"));
    assert_eq!(fs::read(root.join("external")).unwrap(), b"external bytes");
    assert_eq!(fs::read(directory.join("original")).unwrap(), b"owned bytes");
    fs::remove_dir_all(root).unwrap();
}
