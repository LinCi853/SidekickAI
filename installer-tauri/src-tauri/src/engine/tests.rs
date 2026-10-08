#[cfg(test)]
#[path = "../../../../installer-shared/test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
#[cfg(test)]
use super::*;
use super::config::write_install_config;
use super::deploy::{
    deploy_uninstaller_pair, program_items, replace_from_payload, restore_replaced, CORE_ITEMS,
};
use super::pipeline::{run_with as run_engine, EngineHooks};
use super::registry::{
    create_registry_key, delete_registry_key, read_registry_string,
    registered_install_location, remove_uninstall_entry_if_matches,
    restore_registration, snapshot_registration, write_uninstall_registration,
};
use super::scope::{acquire_operation_locks, prepare_operation_scope};
use super::shortcuts::{shortcut_points_to, shortcut_target};
use super::validate::{
    core_payload_matches, uninstaller_payload_matches, validate_uninstaller,
    UninstallerManifest,
};
use crate::manifest::{InstallMode, InstallRequest};
use sidekickai_uninstall_host::data_paths_for;
use std::path::Path;

#[path = "transaction_tests.rs"]
mod recovery;

#[path = "legacy_tests.rs"]
mod legacy;

#[cfg(windows)]
#[test]
fn legacy_target_refusal_keeps_its_running_process_alive() {
    use std::os::windows::process::CommandExt;
    let root = temporary_root("legacy-running-admission");
    let install = root.join("install"); let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    let node = std::process::Command::new("node").args(["-p", "process.execPath"]).creation_flags(0x08000000).output().unwrap();
    assert!(node.status.success());
    fs::copy(String::from_utf8(node.stdout).unwrap().trim(), install.join("SidekickAI.exe")).unwrap();
    fs::remove_file(install.join("distribution-proof.json")).unwrap();
    write_valid_payload(&payload, 0x55, 0x66);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(format!("HKCU\\Software\\SidekickAI-Legacy-Running-{}", std::process::id()));
    let mut child = std::process::Command::new(install.join("SidekickAI.exe")).args(["-e", "setInterval(() => {}, 1000)"])
        .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let started = std::time::Instant::now();
    let result = run_engine(&request(&install, false), &hooks);
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap(); child.wait().unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(result.unwrap_err().contains("新发行合同"));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(alive);
}

#[cfg(windows)]
#[test]
fn healthy_repair_ignores_only_its_own_distribution_receipt_without_replacing_core() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("healthy-distribution-repair");
    let install = root.join("install"); let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44); write_valid_payload(&payload, 0x33, 0x44);
    let receipt = install.join("maintenance/distribution-receipt.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    value["installationId"] = "different-maintenance-generation".into();
    fs::write(receipt, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(core_payload_matches(&install, &payload));
    fs::write(install.join("maintenance/unexpected.bin"), b"unregistered dependency").unwrap();
    assert!(!core_payload_matches(&install, &payload));
    fs::remove_file(install.join("maintenance/unexpected.bin")).unwrap();
    let pinned = fs::OpenOptions::new().read(true).share_mode(1).open(install.join("SidekickAI.exe")).unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Healthy-Distribution-{}", std::process::id());
    let mut hooks = isolated_hooks(&root); hooks.extracted = Some(payload.clone()); hooks.registration_key = Some(key.clone());
    let mut req = request(&install,false); req.mode = InstallMode::Repair; req.installation_id.clear();
    let result = run_engine(&req,&hooks);
    drop(pinned); cleanup_registry_key(&key);
    assert!(result.is_ok(), "{result:?}");
    assert!(core_payload_matches(&install,&payload));
    fs::remove_dir_all(root).unwrap();
}


#[test]
fn obsolete_component_choices_are_ignored_and_repair_preserves_configuration() {
    for selected in [None, Some(false), Some(true)] {
        let root = temporary_root("edition-component-choice");
        let install = root.join("install");
        let payload = root.join("payload");
        write_valid_payload(&payload, 0x55, 0x66);
        let key = format!("HKCU\\Software\\SidekickAI-Component-{}", root.file_name().unwrap().to_string_lossy());
        let mut hooks = isolated_hooks(&root);
        hooks.registration_key = Some(key.clone());
        hooks.extracted = Some(payload.clone());
        let mut req = request(&install, false);
        if let Some(selected) = selected { req.features.insert("whiteboard".into(), serde_json::json!(selected)); }
        run_with(&req, &hooks).unwrap();
        let configuration = fs::read(install.join("install-config.json")).unwrap();
        let plugins = fs::read(install.join("plugins-manifest.json")).unwrap();
        let config: serde_json::Value = serde_json::from_slice(&configuration).unwrap();
        let installed: serde_json::Value = serde_json::from_slice(&plugins).unwrap();
        assert_eq!(config["modules"], serde_json::json!({}));
        assert_eq!(installed, serde_json::json!({}));
        if let Some(selected) = selected {
            let mut legacy = config.clone();
            legacy["modules"]["whiteboard"] = serde_json::json!({ "enabled": selected });
            fs::write(install.join("install-config.json"), serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
            fs::write(install.join("plugins-manifest.json"), serde_json::to_vec(&serde_json::json!({
                "whiteboard": { "installed": selected }
            })).unwrap()).unwrap();
        }
        let configuration = fs::read(install.join("install-config.json")).unwrap();
        let plugins = fs::read(install.join("plugins-manifest.json")).unwrap();
        write_valid_payload(&payload, 0x75, 0x76);
        req.mode = InstallMode::Repair;
        req.installation_id.clear();
        req.features.clear();
        for requested in [None, Some(!selected.unwrap_or(false))] {
            if let Some(requested) = requested { req.features.insert("whiteboard".into(), serde_json::json!(requested)); }
            run_with(&req, &hooks).unwrap();
            super::config::flush_install_config_with(&req, &hooks).unwrap();
            assert_eq!(fs::read(install.join("install-config.json")).unwrap(), configuration);
            assert_eq!(fs::read(install.join("plugins-manifest.json")).unwrap(), plugins);
        }
        cleanup_registry_key(&key);
        fs::remove_dir_all(root).unwrap();
    }
}



#[test]
fn unresolved_legacy_recovery_blocks_concept_installation() {
    if sidekickai_uninstall_core::product::edition_id() != "concept" { return; }
    let root = temporary_root("legacy-edition-recovery");
    let install = root.join("install");
    write_valid_install(&install);
    let journal = root.join(".sidekick-open-source-transaction.json");
    fs::write(&journal, b"retained recovery evidence").unwrap();
    assert!(prepare_operation_scope(&request(&install, false), None).is_err());
    assert_eq!(fs::read(&journal).unwrap(), b"retained recovery evidence");
    assert!(install.join("SidekickAI.exe").is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installation_boundaries_reject_nested_product_directories() {
    let root = temporary_root("nested-editions");
    let parent = root.join("parent");
    write_valid_install(&parent);
    let nested = parent.join("nested");
    assert!(prepare_operation_scope(&request(&nested, false), None).is_err());
    write_valid_install(&nested);
    assert!(prepare_operation_scope(&request(&parent, false), None).is_err());
    assert!(nested.join("SidekickAI.exe").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn foreign_edition_is_never_an_install_or_repair_target() {
    let root = temporary_root("foreign-edition");
    let install = root.join("foreign");
    write_valid_install(&install);
    let foreign_name = if sidekickai_uninstall_core::product::edition_id() == "concept" { "sidekick-ai" } else { "sidekickai-opensource" };
    let archive = edition_fixtures::archive_for_version(foreign_name, Some("0.1.0-beta.4"), b"foreign data");
    fs::write(install.join("resources/app.asar"), &archive).unwrap();
    fs::write(install.join("personal-sentinel"), b"retained").unwrap();
    for mode in [InstallMode::Install, InstallMode::Repair] {
        let mut req = request(&install, false);
        req.mode = mode;
        let error = prepare_operation_scope(&req, None).unwrap_err();
        let foreign_label = if sidekickai_uninstall_core::product::edition_id() == "concept" { "社区版" } else { "概念版" };
        assert!(error.contains(foreign_label));
        assert!(error.contains("0.1.0-beta.4"));
        assert!(error.contains("先卸载"));
        assert!(error.contains("默认保留用户数据"));
        assert_eq!(fs::read(install.join("resources/app.asar")).unwrap(), archive);
        assert_eq!(fs::read(install.join("personal-sentinel")).unwrap(), b"retained");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn custom_directories_allow_same_edition_updates_across_product_versions() {
    let root = temporary_root("custom-directory-upgrade");
    let install = root.join("My tools").join("Chosen location");
    let payload = root.join("payload");
write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    let package_name = &sidekickai_uninstall_core::product::edition().package_name;
    for version in ["0.1.0-alpha.3", "0.1.0-beta.4", "0.2.0"] {
        fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(package_name, Some(version), b"previous runtime")).unwrap();
        for mode in [InstallMode::Install, InstallMode::Repair] {
            let mut req = request(&install, false);
            req.mode = mode;
            assert_eq!(prepare_operation_scope(&req, None).unwrap().install_dir, install);
        }
    }
    fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(package_name, Some("0.1.0-beta.4"), b"previous runtime")).unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/settings.db"), b"retained data").unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Custom-Upgrade-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.registration_key = Some(key.clone());
    hooks.extracted = Some(payload.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    run_with(&req, &hooks).unwrap();
    assert!(core_payload_matches(&install, &payload));
    assert_eq!(fs::read(install.join("data/settings.db")).unwrap(), b"retained data");
    assert_eq!(registered_install_location(&key).unwrap().as_deref(), Some(install.to_string_lossy().as_ref()));
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn foreign_directory_message_does_not_invent_a_product_version() {
    let root = temporary_root("foreign-unknown-version");
    let foreign_name = if sidekickai_uninstall_core::product::edition_id() == "concept" { "sidekick-ai" } else { "sidekickai-opensource" };
    write_valid_install(&root);
    for version in [None, Some("\nforged instructions")] {
        fs::write(root.join("resources/app.asar"), edition_fixtures::archive_for_version(foreign_name, version, b"foreign")).unwrap();
        let error = prepare_operation_scope(&request(&root, false), None).unwrap_err();
        assert!(error.contains("先卸载"));
        assert!(!error.contains("（版本"));
        assert!(!error.contains("forged"));
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn duplicate_product_shortcuts_keep_both_targets() {
    let root = temporary_root("edition-shortcuts");
    let first = root.join("first");
    let second = root.join("second");
    write_valid_install(&first);
    write_valid_install(&second);
    let hooks = isolated_hooks(&root);
    super::shortcuts::create_shortcuts(&hooks, false, &first).unwrap();
    super::shortcuts::create_shortcuts(&hooks, false, &second).unwrap();
    let desktop = hooks.desktop_dir(false);
    assert!(shortcut_points_to(&desktop.join("SidekickAI.lnk"), &first.join("SidekickAI.exe")));
    assert!(shortcut_points_to(&desktop.join("SidekickAI (2).lnk"), &second.join("SidekickAI.exe")));
    super::shortcuts::remove_shortcuts(&hooks, false, &second);
    assert!(shortcut_points_to(&desktop.join("SidekickAI.lnk"), &first.join("SidekickAI.exe")));
    assert!(!desktop.join("SidekickAI (2).lnk").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_application_requires_a_receipt_and_matching_registration_to_repair() {
    let root = temporary_root("receipt-repair");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/settings.db"), b"retained data").unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Receipt-Repair-{}", std::process::id());
    cleanup_registry_key(&key);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload.clone());
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;

    fs::write(install.join("resources/app.asar"), b"corrupt archive").unwrap();
    assert!(run_with(&req, &hooks).is_err());
    assert_eq!(fs::read(install.join("resources/app.asar")).unwrap(), b"corrupt archive");
    fs::write(install.join("resources/app.asar"), app_archive(b"original")).unwrap();
    super::registry::register_uninstall(&hooks, &req, &install).unwrap();
    fs::write(install.join("resources/app.asar"), b"corrupt archive").unwrap();
    let registration = super::registry::read_install_registration(&key, "HKCU").unwrap().unwrap();
    assert!(sidekickai_uninstall_core::product::owns_registered_installation(&install, &registration));
    let mut different_case = registration.clone();
    different_case.install_location = different_case.install_location.to_ascii_uppercase();
    different_case.uninstall_string = format!("\"{}\" --uninstall", install.join("uninstall.exe").to_string_lossy().to_ascii_uppercase());
    assert!(sidekickai_uninstall_core::product::owns_registered_installation(&install, &different_case));
    for command in [format!("{} --silent", registration.uninstall_string), format!(" {}", registration.uninstall_string),
        format!("{} --uninstall", install.join("uninstall.exe").display())] {
        let mut invalid = registration.clone();
        invalid.uninstall_string = command;
        assert!(!sidekickai_uninstall_core::product::owns_registered_installation(&install, &invalid));
    }

    create_registry_key(&key).unwrap().set_value("InstallReceiptSha256", &"incorrect digest").unwrap();
    assert!(run_with(&req, &hooks).is_err());
    create_registry_key(&key).unwrap().set_value("InstallReceiptSha256", &registration.receipt_sha256).unwrap();
    let mut wrong_scope = req.clone();
    wrong_scope.for_all_users = true;
    assert!(run_with(&wrong_scope, &hooks).is_err());
    run_with(&req, &hooks).unwrap();
    assert!(core_payload_matches(&install, &payload));
    assert_eq!(fs::read(install.join("data/settings.db")).unwrap(), b"retained data");
    let proof = super::registry::read_install_registration(&key, "HKCU").unwrap().unwrap();
    assert!(sidekickai_uninstall_core::product::owns_registered_installation(&install, &proof));
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn receipt_cannot_override_foreign_identity_or_authorize_a_copied_directory() {
    let root = temporary_root("receipt-boundaries");
    let install = root.join("install");
    write_valid_installed_payload(&install, 0x33, 0x44);
    let key = format!("HKCU\\Software\\SidekickAI-Receipt-Boundaries-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.registration_key = Some(key.clone());
    let req = request(&install, false);
    super::registry::register_uninstall(&hooks, &req, &install).unwrap();
    let proof = super::registry::read_install_registration(&key, "HKCU").unwrap().unwrap();
    let foreign_name = if sidekickai_uninstall_core::product::edition_id() == "concept" { "sidekick-ai" } else { "sidekickai-opensource" };
    fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for(foreign_name, b"foreign")).unwrap();
    assert!(!sidekickai_uninstall_core::product::owns_registered_installation(&install, &proof));
    assert!(super::scope::prepare_operation_scope_with_hooks(&req, None, &hooks).is_err());

    fs::write(install.join("resources/app.asar"), b"broken").unwrap();
    let copied = root.join("copied");
    super::deploy::copy_dir(&install, &copied).unwrap();
    let mut copied_proof = proof.clone();
    copied_proof.install_location = copied.to_string_lossy().into_owned();
    copied_proof.uninstall_string = format!("\"{}\" --uninstall", copied.join("uninstall.exe").display());
    assert!(!sidekickai_uninstall_core::product::owns_registered_installation(&copied, &copied_proof));
    assert!(sidekickai_uninstall_core::product::validate_installation_boundaries(&install.join("nested")).is_err());
    assert!(sidekickai_uninstall_core::product::validate_installation_boundaries(&root).is_err());
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn registration_failure_restores_receipt_registry_and_program_payload() {
    let root = temporary_root("receipt-rollback");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    let legacy = sidekickai_uninstall_core::product::edition().legacy_executable.as_str();
    let has_legacy = legacy != sidekickai_uninstall_core::product::product().executable;
    if has_legacy { fs::write(install.join(legacy), pe_fixture(0x22)).unwrap(); }
    let key = format!("HKCU\\Software\\SidekickAI-Receipt-Rollback-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.registration_key = Some(key.clone());
    hooks.extracted = Some(payload);
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    super::registry::register_uninstall(&hooks, &req, &install).unwrap();
    let receipt_path = install.join(sidekickai_uninstall_core::product::INSTALL_RECEIPT);
    let receipt = fs::read(&receipt_path).unwrap();
    let registry = snapshot_registration(&key).unwrap();
    let executable = fs::read(install.join("SidekickAI.exe")).unwrap();
    let installation_id = req.installation_id.clone();
    let config = serde_json::to_vec(&serde_json::json!({ "installationId": installation_id, "configState": "complete" })).unwrap();
    fs::write(install.join("install-config.json"), &config).unwrap();
    req.installation_id.clear();
    hooks.fail_after_receipt = true;
    assert!(run_with(&req, &hooks).is_err());
    assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
    assert_eq!(snapshot_registration(&key).unwrap(), registry);
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), executable);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
    if has_legacy { assert_eq!(fs::read(install.join(legacy)).unwrap(), pe_fixture(0x22)); }
    assert!(stray_staging_dirs(&install).is_empty());
    hooks.fail_after_receipt = false;
    run_with(&req, &hooks).unwrap();
    let (repaired, _) = sidekickai_uninstall_core::product::read_install_receipt(&install).unwrap();
    assert_eq!(repaired.installation_id, installation_id);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), pe_fixture(0x55));
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_repair_migrates_only_owned_shortcuts_and_preserves_data() {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable { return; }
    let root = temporary_root("legacy-repair-migration");
    let install = root.join("install");
    let payload = root.join("payload");
    let foreign = root.join("foreign");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    write_valid_installed_payload(&foreign, 0x77, 0x88);
    fs::rename(install.join(&product.executable), install.join(&edition.legacy_executable)).unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/settings.db"), b"legacy data").unwrap();
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    let key = format!("HKCU\\Software\\SidekickAI-Legacy-Migration-{}", std::process::id());
    hooks.registration_key = Some(key.clone());
    let desktop = hooks.desktop_dir(false);
    fs::create_dir_all(&desktop).unwrap();
    let legacy_link = desktop.join(Path::new(&edition.legacy_executable).with_extension("lnk"));
    super::shortcuts::create_shortcut(&legacy_link, &install.join(&edition.legacy_executable).to_string_lossy(), &install.to_string_lossy()).unwrap();
    let foreign_link = desktop.join("SidekickAI.lnk");
    super::shortcuts::create_shortcut(&foreign_link, &foreign.join(&product.executable).to_string_lossy(), &foreign.to_string_lossy()).unwrap();
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    run_with(&req, &hooks).unwrap();
    assert!(!legacy_link.exists());
    assert!(shortcut_points_to(&desktop.join("SidekickAI (2).lnk"), &install.join(&product.executable)));
    assert!(shortcut_points_to(&foreign_link, &foreign.join(&product.executable)));
    assert!(!install.join(&edition.legacy_executable).exists());
    assert!(install.join(sidekickai_uninstall_core::product::INSTALL_RECEIPT).is_file());
    assert_eq!(fs::read(install.join("data/settings.db")).unwrap(), b"legacy data");
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_legacy_shortcut_migration_restores_the_original_runtime_and_entry() {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable { return; }
    let root = temporary_root("legacy-migration-incomplete");
    let install = root.join("install");
    let payload = root.join("payload");
    let (original_executable, _) = write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    fs::write(install.join("ffmpeg.dll"), b"old runtime").unwrap();
    fs::write(payload.join("ffmpeg.dll"), b"current runtime").unwrap();
    fs::rename(install.join(&product.executable), install.join(&edition.legacy_executable)).unwrap();
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    let key = format!("HKCU\\Software\\SidekickAI-Legacy-Incomplete-{}", std::process::id());
    hooks.registration_key = Some(key.clone());
    let desktop = hooks.desktop_dir(false);
    fs::create_dir_all(&desktop).unwrap();
    for name in sidekickai_uninstall_core::product::shortcut_names() { fs::create_dir(desktop.join(name)).unwrap(); }
    let legacy_link = desktop.join(Path::new(&edition.legacy_executable).with_extension("lnk"));
    super::shortcuts::create_shortcut(&legacy_link, &install.join(&edition.legacy_executable).to_string_lossy(), &install.to_string_lossy()).unwrap();
    let log = root.join("operation.log");
    let result = crate::controller::with_operation_context(log.clone(), || run_with(&request(&install, false), &hooks));
    assert!(result.unwrap_err().contains("安装尚未完成"));
    assert!(shortcut_points_to(&legacy_link, &install.join(&edition.legacy_executable)));
    assert_eq!(fs::read(install.join(&edition.legacy_executable)).unwrap(), original_executable);
    assert_eq!(fs::read(install.join("ffmpeg.dll")).unwrap(), b"old runtime");
    assert!(!install.join(&product.executable).exists());
    assert!(stray_staging_dirs(&install).is_empty());
    assert!(!fs::read_to_string(&log).unwrap().contains("S|安装完成"));
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_legacy_alias_preparation_restores_the_previous_install_and_registration() {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable { return; }
    let root = temporary_root("legacy-alias-rollback");
    let install = root.join("install");
    let payload = root.join("payload");
    let (old_executable, _) = write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    fs::rename(install.join(&product.executable), install.join(&edition.legacy_executable)).unwrap();
    fs::create_dir(payload.join(&edition.legacy_executable)).unwrap();
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    let key = format!("HKCU\\Software\\SidekickAI-Legacy-Alias-{}", std::process::id());
    hooks.registration_key = Some(key.clone());
    write_uninstall_registration(&install, &key).unwrap();
    let registration = snapshot_registration(&key).unwrap();
    let desktop = hooks.desktop_dir(false);
    fs::create_dir_all(&desktop).unwrap();
    let legacy_link = desktop.join(Path::new(&edition.legacy_executable).with_extension("lnk"));
    super::shortcuts::create_shortcut(&legacy_link, &install.join(&edition.legacy_executable).to_string_lossy(), &install.to_string_lossy()).unwrap();
    let error = run_with(&request(&install, false), &hooks).unwrap_err();
    assert!(error.contains("已恢复原安装与入口"), "{error}");
    assert_eq!(fs::read(install.join(&edition.legacy_executable)).unwrap(), old_executable);
    assert!(!install.join(&product.executable).exists());
    assert!(shortcut_points_to(&legacy_link, &install.join(&edition.legacy_executable)));
    assert_eq!(snapshot_registration(&key).unwrap(), registration);
    assert!(stray_staging_dirs(&install).is_empty());
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_restores_original_legacy_state_after_migration_failure_and_allows_retry() {
    let product = sidekickai_uninstall_core::product::product();
    let edition = sidekickai_uninstall_core::product::edition();
    if edition.legacy_executable == product.executable { return; }
    let root = temporary_root("legacy-repair-incomplete");
    for core_current in [false, true] {
        let case = root.join(if core_current { "current-core" } else { "old-core" });
        let install = case.join("install");
        let payload = case.join("payload");
        write_valid_installed_payload(&install, if core_current { 0x55 } else { 0x33 }, 0x66);
        write_valid_payload(&payload, 0x55, 0x66);
        fs::write(install.join(&edition.legacy_executable), pe_fixture(0x11)).unwrap();
        let source_digest = super::validate::directory_digest(&payload).unwrap();
        let mut hooks = isolated_hooks(&case);
        hooks.extracted = Some(payload.clone());
        let key = format!("HKCU\\Software\\SidekickAI-Legacy-Repair-{}-{core_current}", std::process::id());
        hooks.registration_key = Some(key.clone());
        let desktop = hooks.desktop_dir(false);
        fs::create_dir_all(&desktop).unwrap();
        for name in sidekickai_uninstall_core::product::shortcut_names() { fs::create_dir(desktop.join(name)).unwrap(); }
        let legacy_link = desktop.join(Path::new(&edition.legacy_executable).with_extension("lnk"));
        super::shortcuts::create_shortcut(&legacy_link, &install.join(&edition.legacy_executable).to_string_lossy(), &install.to_string_lossy()).unwrap();
        let mut req = request(&install, false);
        req.mode = InstallMode::Repair;
        let log = case.join("operation.log");
        let error = crate::controller::with_operation_context(log.clone(), || run_with(&req, &hooks)).unwrap_err();
        assert!(error.contains("修复尚未完成"));
        assert!(shortcut_points_to(&legacy_link, &install.join(&edition.legacy_executable)));
        assert_eq!(fs::read(install.join(&edition.legacy_executable)).unwrap(), pe_fixture(0x11));
        assert_eq!(fs::read(install.join(&product.executable)).unwrap(), pe_fixture(if core_current { 0x55 } else { 0x33 }));
        assert_eq!(core_payload_matches(&install, &payload), core_current);
        assert_eq!(super::validate::directory_digest(&payload).unwrap(), source_digest);
        assert!(!fs::read_to_string(&log).unwrap().contains("S|修复完成"));
        fs::remove_dir(desktop.join("SidekickAI.lnk")).unwrap();
        run_with(&req, &hooks).unwrap();
        assert!(!legacy_link.exists());
        assert!(!install.join(&edition.legacy_executable).exists());
        assert!(shortcut_points_to(&desktop.join("SidekickAI.lnk"), &install.join(&product.executable)));
        assert_eq!(super::validate::directory_digest(&payload).unwrap(), source_digest);
        cleanup_registry_key(&key);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn application_payload_rejects_installation_receipts() {
    let root = temporary_root("receipt-payload");
    write_valid_installed_payload(&root, 0x33, 0x44);
    fs::write(root.join(sidekickai_uninstall_core::product::INSTALL_RECEIPT), b"local state").unwrap();
    assert!(program_items(&root).is_err());
    fs::remove_dir_all(root).unwrap();
}

/// A structurally valid PE32+ image with one section, so architecture and
/// hash checks can be exercised without shipping a real binary.
fn pe_fixture(fill: u8) -> Vec<u8> {
    let mut exe = vec![fill; 0x400];
    exe[0] = b'M'; exe[1] = b'Z';
    exe[0x3c..0x40].copy_from_slice(&(0x80u32).to_le_bytes());
    exe[0x80..0x84].copy_from_slice(b"PE\0\0");
    exe[0x84..0x86].copy_from_slice(&(0x8664u16).to_le_bytes());
    exe[0x86..0x88].copy_from_slice(&(1u16).to_le_bytes());
    exe[0x94..0x96].copy_from_slice(&(0xF0u16).to_le_bytes());
    exe[0x98..0x9a].copy_from_slice(&(0x20bu16).to_le_bytes());
    let section = 0x80 + 24 + 0xF0;
    exe[section + 16..section + 20].copy_from_slice(&(0x100u32).to_le_bytes());
    exe[section + 20..section + 24].copy_from_slice(&(0x200u32).to_le_bytes());
    exe
}

fn manifest_for(exe: &[u8]) -> UninstallerManifest {
    use sha2::Digest;
    UninstallerManifest {
        protocol_version: 3,
        edition: sidekickai_uninstall_core::product::edition_id().into(),
        version: String::new(),
        product_version: product_version(),
        component_version: env!("CARGO_PKG_VERSION").into(),
        uninstall_protocol_version: Some(2),
        arch: "x64".into(),
        sha256: format!("{:x}", sha2::Sha256::digest(exe)),
        size: exe.len() as u64,
        input_fingerprint: "a".repeat(64),
    }
}

fn write_pair(directory: &Path, exe: &[u8], manifest: &UninstallerManifest) {
    fs::create_dir_all(directory).unwrap();
    fs::write(directory.join("uninstall.exe"), exe).unwrap();
    fs::write(directory.join("uninstall-manifest.json"), serde_json::to_vec(manifest).unwrap()).unwrap();
}

#[test]
fn component_uninstaller_can_be_bound_to_multiple_product_versions() {
    let root = temporary_root("uninstaller-release-binding");
    let exe = pe_fixture(0x35);
    let mut metadata = manifest_for(&exe);
    metadata.protocol_version = 3;
    metadata.version.clear();
    metadata.component_version = env!("CARGO_PKG_VERSION").into();
    metadata.uninstall_protocol_version = Some(2);
    for version in ["0.1.5-beta-rc", "0.9.0"] {
        metadata.product_version = version.into();
        write_pair(&root, &exe, &metadata);
        assert!(validate_uninstaller(&root, "x64", version).is_ok());
        assert!(validate_uninstaller(&root, "x64", "99.0.0").is_err());
        assert_eq!(fs::read(root.join("uninstall.exe")).unwrap(), exe);
    }
    metadata.component_version = "99.0.0".into();
    write_pair(&root, &exe, &metadata);
    assert!(validate_uninstaller(&root, "x64", "0.9.0").is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore = "Requires an explicit production-signed candidate payload"]
fn actual_candidate_uninstaller_requires_manifest_protocol_three() {
    let payload = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_PAYLOAD").expect("verified payload"));
    assert!(payload.is_absolute() && payload.is_dir());
    let proof = sidekickai_uninstall_core::distribution::parse_envelope(&fs::read(payload.join("distribution-proof.json")).unwrap()).unwrap();
    let body = crate::distribution::verify_body(&proof).unwrap();
    sidekickai_uninstall_core::distribution::verify_declared_files(&payload, &body.files).unwrap();
    assert_eq!(body.native_architectures.len(), 1);
    let architecture = &body.native_architectures[0];
    let metadata = validate_uninstaller(&payload, architecture, &body.product_version).unwrap();
    assert_eq!(metadata.protocol_version, 3);
    assert_eq!(metadata.uninstall_protocol_version, Some(2));
    let root = temporary_root("actual-uninstaller-protocol");
    let exe = fs::read(payload.join("uninstall.exe")).unwrap();
    let mut previous = metadata;
    previous.protocol_version = 2;
    write_pair(&root, &exe, &previous);
    assert!(validate_uninstaller(&root, architecture, &body.product_version).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn standalone_uninstaller_rejects_setup_footers() {
    let root = temporary_root("uninstaller-setup-footer");
    for (size, magic) in [(28, b"SKPAYLD1"), (68, b"SKPAYLD2"), (68, b"SKSETUP3")] {
        let mut exe = pe_fixture(0x37);
        let mut footer = vec![0; size];
        footer[..magic.len()].copy_from_slice(magic);
        exe.extend(footer);
        write_pair(&root, &exe, &manifest_for(&exe));
        let error = validate_uninstaller(&root, "x64", &product_version()).unwrap_err();
        assert!(error.contains("载荷"), "{error}");
    }
    fs::remove_dir_all(root).unwrap();
}

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("sidekick-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn request(dir: &Path, for_all_users: bool) -> InstallRequest {
    InstallRequest {
        distribution_source_path: String::new(), distribution_body_proof: String::new(), distribution_product_version: String::new(),
        distribution_release_id: String::new(), distribution_release_sha256: String::new(), distribution_release_proof: String::new(),
        installation_id: manifest::new_installation_id(),
        resources: Vec::new(),
        staging_dir: String::new(),
        action: String::new(),
        install_dir: dir.to_string_lossy().into_owned(),
        for_all_users,
        create_desktop_shortcut: false,
        launch_after_install: false,
        show_guide_after_install: false,
        features: serde_json::Map::new(),
        options: serde_json::Map::new(),
        mode: InstallMode::Install,
        cleanup_paths: Vec::new(),
        delete_user_data: false,
        data_strategy: String::new(),
        backup_path: String::new(),
        backup_password: String::new(),
        backup_encrypt: true,
        backup_categories: Vec::new(),
        accepted_licenses: Vec::new(),
        cloud_enabled: false,
        cloud_assets: Vec::new(),
    }
}

fn cleanup_registry_key(key: &str) {
    let _ = delete_registry_key(key);
}

fn run_with(req: &InstallRequest, hooks: &EngineHooks) -> Result<(), String> {
    run_engine(req, hooks)?;
    if req.distribution_body_proof.is_empty() && req.action != "flush-config" {
        edition_fixtures::seal_installation(Path::new(&req.install_dir));
    }
    Ok(())
}

fn write_valid_installed_payload(dir: &Path, exe_fill: u8, uninstaller_fill: u8) -> (Vec<u8>, Vec<u8>) {
    let bytes = write_valid_payload(dir, exe_fill, uninstaller_fill);
    edition_fixtures::seal_installation(dir);
    bytes
}

fn select_default_fixture_body() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use ed25519_dalek::Signer;
    use std::io::Write;
    use sidekickai_uninstall_core::distribution as contract;
    if !product_version().is_empty() { return; }
    let root = temporary_root("selected-engine-fixture");
    fs::create_dir(root.join("resources")).unwrap();
    let version = crate::setup_metadata::current().unwrap().product_version.clone();
    fs::write(root.join("resources/app.asar"), edition_fixtures::archive_for_version(
        &sidekickai_uninstall_core::product::edition().package_name, Some(&version), b"selected-fixture-asar")).unwrap();
    fs::write(root.join("SidekickAI.exe"), pe_fixture(0x32)).unwrap();
    edition_fixtures::seal_installation(&root);
    let mut proof: serde_json::Value = serde_json::from_slice(&fs::read(root.join("distribution-proof.json")).unwrap()).unwrap();
    let archive = root.join("application.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for item in proof["payload"]["files"].as_array().unwrap() {
        let name = item["path"].as_str().unwrap();
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&fs::read(root.join(name)).unwrap()).unwrap();
    }
    zip.finish().unwrap();
    proof["payload"]["archive"]["sha256"] = contract::sha256_file(&archive).unwrap().into();
    proof["payload"]["archive"]["sizeBytes"] = fs::metadata(&archive).unwrap().len().into();
    let header = serde_json::json!({"alg":"EdDSA","kid":"maintenance-test-publisher","typ":contract::BODY_PROOF_TYPE});
    let text = format!("{}.{}", URL_SAFE_NO_PAD.encode(contract::canonical_bytes(&header).unwrap()),
        URL_SAFE_NO_PAD.encode(contract::canonical_bytes(&proof["payload"]).unwrap()));
    let key = ed25519_dalek::SigningKey::from_bytes(&[0x63; 32]);
    proof["signature"] = format!("{text}.{}", URL_SAFE_NO_PAD.encode(key.sign(text.as_bytes()).to_bytes())).into();
    let mut req = request(&root, false);
    req.distribution_source_path = archive.to_string_lossy().into_owned();
    req.distribution_body_proof = serde_json::to_string(&proof).unwrap();
    req.distribution_product_version = version;
    crate::distribution::apply_request(&req).unwrap();
    fs::remove_dir_all(root).unwrap();
}

/// A complete payload directory: valid core plus a standalone uninstaller
/// pair whose manifest matches the executable.
fn write_valid_payload(dir: &Path, exe_fill: u8, uninstaller_fill: u8) -> (Vec<u8>, Vec<u8>) {
    select_default_fixture_body();
    fs::create_dir_all(dir.join("resources")).unwrap();
    let exe = pe_fixture(exe_fill);
    fs::write(dir.join("SidekickAI.exe"), &exe).unwrap();
    fs::write(dir.join("resources").join("app.asar"), edition_fixtures::archive_for_version(
        &sidekickai_uninstall_core::product::edition().package_name, Some(&product_version()), b"payload-asar")).unwrap();
    let uninstaller = pe_fixture(uninstaller_fill);
    write_pair(dir, &uninstaller, &manifest_for(&uninstaller));
    edition_fixtures::seal_installation(dir);
    fs::remove_file(dir.join("install-receipt.json")).unwrap();
    fs::remove_file(dir.join("maintenance/distribution-receipt.json")).unwrap();
    (exe, uninstaller)
}

/// Sibling staging directories that must not survive a completed
/// transaction.
fn stray_staging_dirs(install_dir: &Path) -> Vec<PathBuf> {
    let Some(parent) = install_dir.parent() else {
        return Vec::new();
    };
    fs::read_dir(parent)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .map(|name| {
                            let name = name.to_string_lossy();
                            name.starts_with("SidekickAI-Backup")
                                || name.starts_with("SidekickAI-Replace")
                        })
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Test seams for the full engine sequence: dedicated shortcut directories
/// and a roaming base, so nothing outside the fixture root is touched.
fn isolated_hooks(root: &Path) -> EngineHooks {
    EngineHooks {
        desktop: Some(root.join("desktop")),
        start_menu: Some(root.join("start-menu")),
        roaming: Some(root.join("roaming")),
        ..Default::default()
    }
}

/// Production hooks must still probe the real roaming directory; only a
/// test override replaces it.
#[test]
fn default_hooks_fall_back_to_the_process_roaming_directory() {
    let hooks = EngineHooks::default();
    assert_eq!(hooks.roaming_base(), std::env::var_os("APPDATA").map(PathBuf::from));
}

/// Engine logs follow the operation context: inside an operation the bound
/// private log is used, and outside one the informational fallback is
/// returned. Fixture tests never append to the fallback.
#[test]
fn engine_log_follows_the_operation_context() {
    let root = temporary_root("engine-log-context");
    let bound = root.join("install.log");
    crate::controller::with_operation_context(bound.clone(), || {
        assert_eq!(log_path(), bound);
        status("bound-status");
    });
    let text = fs::read_to_string(&bound).unwrap();
    assert!(text.contains("S|bound-status"), "bound log missing line: {text}");
    assert_ne!(log_path(), bound, "outside an operation the informational fallback applies");

    // Unbound writes are dropped in test builds instead of touching the
    // process-wide installer log.
    status("unbound-status");
    assert!(!fs::read_to_string(&bound).unwrap().contains("unbound-status"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn uninstaller_manifest_binds_hash_size_and_architecture() {
    let root = temporary_root("engine-test");
    let exe = pe_fixture(0);
    let manifest = manifest_for(&exe);
    write_pair(&root, &exe, &manifest);
    assert!(validate_uninstaller(&root, "x64", &product_version()).is_ok());
    // A wrong architecture, version or hash must all be rejected.
    assert!(validate_uninstaller(&root, "arm64", &product_version()).is_err());
    assert!(validate_uninstaller(&root, "x64", "9.9.9").is_err());
    let mut tampered = manifest;
    tampered.sha256 = "b".repeat(64);
    fs::write(root.join("uninstall-manifest.json"), serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert!(validate_uninstaller(&root, "x64", &product_version()).is_err());
    let _ = fs::remove_dir_all(&root);
}

/// Repair must replace an outdated uninstaller even when the rest of the
/// installation is healthy, and must restore the previous valid pair when
/// the incoming payload cannot be verified.
#[test]
fn deploy_pair_replaces_and_rolls_back_in_an_isolated_root() {
    let root = temporary_root("deploy-test");
    let install = root.join("install");
    let payload = root.join("payload");

    let old_exe = pe_fixture(0x11);
    let old_manifest = manifest_for(&old_exe);
    write_pair(&install, &old_exe, &old_manifest);

    // Successful deployment: bytes must come from the new payload.
    let new_exe = pe_fixture(0x22);
    let new_manifest = manifest_for(&new_exe);
    write_pair(&payload, &new_exe, &new_manifest);
    deploy_uninstaller_pair(&install, &payload).unwrap();
    assert_eq!(fs::read(install.join("uninstall.exe")).unwrap(), new_exe);
    assert!(validate_uninstaller(&install, "x64", &product_version()).is_ok());

    // Failed deployment: an unverifiable payload must leave the previous
    // valid pair byte-for-byte intact.
    let before = fs::read(install.join("uninstall.exe")).unwrap();
    let broken = root.join("broken-payload");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("uninstall.exe"), pe_fixture(0x33)).unwrap();
    assert!(deploy_uninstaller_pair(&install, &broken).is_err());
    assert_eq!(fs::read(install.join("uninstall.exe")).unwrap(), before);
    assert!(validate_uninstaller(&install, "x64", &product_version()).is_ok());

    let _ = fs::remove_dir_all(&root);
}

/// Verify the registration contract against a dedicated test key: the
/// compatibility flag is written, and a legacy silent value is removed.
/// The user's real SidekickAI uninstall entry is never touched.
#[test]
fn registration_writes_compat_flag_and_clears_legacy_silent_value() {
    let root = temporary_root("registration-test");
    let install = root.join("SidekickAI");
    fs::create_dir_all(&install).unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Uninstaller-Test-{}", std::process::id());
    cleanup_registry_key(&key);
    // Seed the legacy value an older installer would have written.
    let seeded = create_registry_key(&key).unwrap();
    seeded.set_value("QuietUninstallString", &"legacy --silent").unwrap();
    drop(seeded);

    write_uninstall_registration(&install, &key).unwrap();

    let expected = format!("\"{}\" --uninstall", install.join("uninstall.exe").display());
    assert_eq!(
        read_registry_string(&key, "UninstallString").unwrap().as_deref(),
        Some(expected.as_str())
    );
    assert!(read_registry_string(&key, "DisplayName").unwrap().is_some());
    assert!(
        read_registry_string(&key, "QuietUninstallString").unwrap().is_none(),
        "legacy silent value survived"
    );

    // Failing registry writes must surface as errors, not silent success.
    assert!(write_uninstall_registration(&install, "HKXX\\Software\\NoSuchHive").is_err());

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn identical_options_have_distinct_installation_generations_and_flush_keeps_resources() {
    let root = temporary_root("install-generation");
    write_valid_install(&root);
    let mut req = request(&root, false);
    let other = request(&root, false);
    assert_ne!(req.installation_id, other.installation_id);
    // A non-default resource snapshot detects a flush that drops recorded metadata.
    let resource = serde_json::json!({
        "resourceType": "rule", "status": "valid", "resourceId": "fixture-rules",
        "version": "1.0.0", "digest": "a".repeat(64)
    });
    req.resources.push(resource.clone());
    write_install_config(&req, &root).unwrap();
    let before: serde_json::Value = serde_json::from_slice(&fs::read(root.join("install-config.json")).unwrap()).unwrap();
    assert_eq!(before["schemaVersion"], 2);
    assert_eq!(before["configState"], "pending");
    // Only installable components are projected; the host owns core module defaults.
    assert_eq!(before["modules"], serde_json::json!({}));
    assert_eq!(before["resources"].as_array().unwrap().len(), 5);
    assert!(before["resources"].as_array().unwrap().contains(&resource));
    let mut final_options = other;
    final_options.action = "flush-config".into();
    final_options.options.insert("autoLaunch".into(), serde_json::json!(true));
    super::config::flush_install_config_with(&final_options, &isolated_hooks(&root)).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&fs::read(root.join("install-config.json")).unwrap()).unwrap();
    assert_eq!(after["installationId"], before["installationId"]);
    assert_eq!(after["resources"], before["resources"]);
    assert_eq!(before["options"]["autoLaunch"], false);
    assert_eq!(after["options"]["autoLaunch"], true);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn install_config_round_trips_and_detects_matches() {
    let root = temporary_root("config-test");
    fs::create_dir_all(&root).unwrap();
    let req = request(&root, false);
    assert!(!install_config_matches(&req));
    write_install_config(&req, &root).unwrap();
    assert!(install_config_matches(&req));
    let read = read_install_config(&root).unwrap();
    assert!(read.get("modules").is_some() && read.get("options").is_some());
    let options = manifest::options();
    assert_eq!(read["options"].as_object().unwrap().len(), options.len());
    for option in options { assert_eq!(read["options"][&option.id], option.default_value); }
    if sidekickai_uninstall_core::product::edition_id() == "concept" { assert!(read["options"].get("autoUpdate").is_none()); }
    // A partial JSON write must not be mistaken for a complete configuration.
    fs::write(root.join("install-config.json"), b"{").unwrap();
    assert!(!install_config_matches(&req));
    assert!(read_install_config(&root).is_none());
    let _ = fs::remove_dir_all(&root);
}

/// A directory that passes the same identity probe the installer uses to
/// recognize an existing installation.
fn write_valid_install(dir: &Path) {
    fs::create_dir_all(dir.join("resources")).unwrap();
    fs::write(dir.join("SidekickAI.exe"), pe_fixture(0x01)).unwrap();
    fs::write(dir.join("resources").join("app.asar"), edition_fixtures::archive_for_version(
        &sidekickai_uninstall_core::product::edition().package_name, Some(&product_version()), b"fixture-asar")).unwrap();
    edition_fixtures::seal_installation(dir);
}

/// The scope locks the target, the explicit cleanup installations and the
/// related data directories, so the installer and the uninstall worker take
/// the same mutexes.
#[test]
fn operation_scope_locks_install_cleanup_and_data_paths() {
    let root = temporary_root("scope-test");
    let install = root.join("install");
    let other = root.join("other");
    write_valid_install(&install);
    write_valid_install(&other);
    let mut req = request(&install, false);
    req.cleanup_paths = vec![other.to_string_lossy().into_owned()];

    let scope = prepare_operation_scope(&req, None).unwrap();
    assert!(scope.lock_paths.contains(&install));
    assert!(scope.lock_paths.contains(&other));
    assert_eq!(scope.cleanup_dirs, vec![other.clone()]);

    // Installed local data remains part of the maintenance scope.
    fs::create_dir_all(install.join("data")).unwrap();
    let scope = prepare_operation_scope(&req, None).unwrap();
    assert!(scope.lock_paths.contains(&install.join("data")));

    let _ = fs::remove_dir_all(&root);
}

/// The installer uses the shared host probes, so a directory name alone is
/// not evidence and portable installs report their in-place data directory.
#[test]
fn data_paths_follow_the_shared_discovery_probes() {
    let root = temporary_root("data-paths-test");
    let install = root.join("install");
    fs::create_dir_all(&install).unwrap();
    let roaming = root.join("roaming");
    let candidate = roaming.join(sidekickai_uninstall_core::product::edition().data_directories[0].as_str());
    fs::create_dir_all(&candidate).unwrap();
    fs::write(candidate.join("settings.db"), b"db").unwrap();

    // A settings database without an application-specific companion is not enough.
    assert!(data_paths_for(&install, Some(&roaming)).unwrap().is_empty());
    fs::write(candidate.join("chat.db"), b"db").unwrap();
    assert_eq!(data_paths_for(&install, Some(&roaming)).unwrap(), vec![candidate.clone()]);

    // Portable installs report their in-place data directory instead.
    fs::write(install.join("portable.txt"), b"portable").unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    assert_eq!(data_paths_for(&install, Some(&roaming)).unwrap(), vec![install.join("data")]);

    let _ = fs::remove_dir_all(&root);
}

/// Unsafe cleanup roots and overlapping targets are rejected; an explicit
/// cleanup path that is not a genuine installation is reported instead of
/// being silently skipped.
#[test]
fn cleanup_paths_reject_unsafe_roots_and_unconfirmed_directories() {
    let root = temporary_root("cleanup-validation-test");
    let install = root.join("install");
    write_valid_install(&install);

    // Relative paths are rejected outright.
    let mut req = request(&install, false);
    req.cleanup_paths = vec!["relative\\SidekickAI".into()];
    assert!(prepare_operation_scope(&req, None).is_err());

    // The install target itself and an ancestor of it must not be cleaned.
    req.cleanup_paths = vec![install.to_string_lossy().into_owned()];
    assert!(prepare_operation_scope(&req, None).is_err());
    req.cleanup_paths = vec![root.to_string_lossy().into_owned()];
    assert!(prepare_operation_scope(&req, None).is_err());

    // A same-named directory without a valid installation is reported.
    let lookalike = root.join("lookalike");
    fs::create_dir_all(&lookalike).unwrap();
    fs::write(lookalike.join("SidekickAI.exe"), b"not a real executable").unwrap();
    req.cleanup_paths = vec![lookalike.to_string_lossy().into_owned()];
    let error = prepare_operation_scope(&req, None).unwrap_err();
    assert!(
        error.contains("不是有效的 SidekickAI 安装"),
        "an explicit but unconfirmed cleanup path must be reported: {error}"
    );

    // A genuine installation is accepted.
    let genuine = root.join("genuine");
    write_valid_install(&genuine);
    req.cleanup_paths = vec![genuine.to_string_lossy().into_owned()];
    assert_eq!(
        prepare_operation_scope(&req, None).unwrap().cleanup_dirs,
        vec![genuine]
    );

    let _ = fs::remove_dir_all(&root);
}

/// The install target gets the same protected-path rejection as cleanup, so
/// a root or a profile/system directory can never become the replace target.
#[test]
fn install_directory_rejects_roots_and_protected_locations() {
    let root = temporary_root("install-target-validation");
    let install = root.join("install");
    write_valid_install(&install);

    let mut req = request(Path::new(r"C:\"), false);
    assert!(prepare_operation_scope(&req, None).is_err());

    if let Some(system_root) = std::env::var_os("SystemRoot") {
        req.install_dir = PathBuf::from(&system_root).to_string_lossy().into_owned();
        assert!(prepare_operation_scope(&req, None).is_err());
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        req.install_dir = PathBuf::from(&profile).to_string_lossy().into_owned();
        assert!(prepare_operation_scope(&req, None).is_err());
    }
    // A normal descendant path stays usable, so the guard does not block
    // legitimate installs.
    req.install_dir = install.to_string_lossy().into_owned();
    assert!(prepare_operation_scope(&req, None).is_ok());

    let _ = fs::remove_dir_all(&root);
}

/// Normal installation never treats program cleanup as user-data removal.
#[test]
fn portable_cleanup_preserves_user_data_and_ignores_legacy_delete_flags() {
    let root = temporary_root("portable-cleanup-test");
    let install = root.join("install");
    let portable = root.join("portable-old");
    write_valid_install(&install);
    write_valid_install(&portable);
    fs::write(portable.join("portable.txt"), b"portable").unwrap();
    fs::create_dir_all(portable.join("data")).unwrap();
    fs::write(portable.join("data").join("settings.db"), b"user data").unwrap();

    let mut req = request(&install, false);
    req.cleanup_paths = vec![portable.to_string_lossy().into_owned()];
    assert!(prepare_operation_scope(&req, None).is_err());

    req.delete_user_data = true;
    assert!(prepare_operation_scope(&req, None).is_err());

    req.delete_user_data = false;
    fs::remove_file(portable.join("data").join("settings.db")).unwrap();
    assert!(prepare_operation_scope(&req, None).is_err());

    fs::remove_dir(portable.join("data")).unwrap();
    fs::create_dir(portable.join("data.bak-1234567890123")).unwrap();
    assert!(prepare_operation_scope(&req, None).is_err());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rollback_preserves_portable_recovery_state() {
    let root = temporary_root("portable-recovery-rollback");
    let install = root.join("install");
    let backup = root.join("backup");
    fs::create_dir_all(&install).unwrap();
    fs::create_dir_all(&backup).unwrap();
    for name in ["data.restore.json", "data.reset.json", "portable.txt"] {
        fs::write(install.join(name), name.as_bytes()).unwrap();
    }
    for name in ["data", "data.instance", "data.bak-1234567890123", "data.restore-01234567-89ab-cdef-0123-456789abcdef"] {
        fs::create_dir(install.join(name)).unwrap();
        fs::write(install.join(name).join("sentinel"), b"user state").unwrap();
    }
    super::pipeline::restore_install_dir(&install, Some(&backup)).unwrap();
    assert_eq!(fs::read(install.join("data.restore.json")).unwrap(), b"data.restore.json");
    assert_eq!(fs::read(install.join("data.bak-1234567890123/sentinel")).unwrap(), b"user state");
    assert!(install.join("data.instance/sentinel").is_file());
    fs::remove_dir_all(root).unwrap();
}

/// Both roles must exclude a second holder and must be released together.
#[test]
fn operation_locks_exclude_a_second_holder_and_release_on_drop() {
    let root = temporary_root("lock-test");
    let install = root.join("install");
    write_valid_install(&install);
    let scope = vec![install.clone()];
    let held = acquire_operation_locks(&scope).unwrap();
    assert!(acquire_operation_locks(&scope).is_err());
    drop(held);
    assert!(acquire_operation_locks(&scope).is_ok());
    let _ = fs::remove_dir_all(&root);
}

/// A skip decision must compare the incoming payload, not just the version:
/// same bytes with a different manifest fingerprint is still a new payload.
#[test]
fn uninstaller_payload_matching_compares_bytes_and_manifest_fingerprint() {
    let root = temporary_root("uninstaller-match-test");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_install(&install);
    let exe = pe_fixture(0x44);
    let manifest = manifest_for(&exe);
    write_pair(&install, &exe, &manifest);
    write_pair(&payload, &exe, &manifest);
    assert!(uninstaller_payload_matches(&install, &payload, "x64"));

    // Rebuilt for the same version: same size and version, different bytes.
    let rebuilt = pe_fixture(0x55);
    write_pair(&payload, &rebuilt, &manifest_for(&rebuilt));
    assert!(!uninstaller_payload_matches(&install, &payload, "x64"));

    // Same bytes but a different recorded payload fingerprint must not skip.
    let mut refingerprinted = manifest.clone();
    refingerprinted.input_fingerprint = "b".repeat(64);
    write_pair(&payload, &exe, &refingerprinted);
    assert!(!uninstaller_payload_matches(&install, &payload, "x64"));

    // A missing or invalid deployed pair can never match.
    fs::remove_file(install.join("uninstall-manifest.json")).unwrap();
    assert!(!uninstaller_payload_matches(&install, &payload, "x64"));

    let _ = fs::remove_dir_all(&root);
}

/// Regression: the previous pair must be restored byte-for-byte when the
/// backup move fails after one file was already moved aside. The old code
/// returned early and left the moved file in the temporary backup.
#[cfg(windows)]
#[test]
fn deploy_pair_restores_previous_pair_when_a_backup_move_fails() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("deploy-partial-rollback-test");
    let install = root.join("install");
    let payload = root.join("payload");
    let old_exe = pe_fixture(0x66);
    let old_manifest_bytes = serde_json::to_vec(&manifest_for(&old_exe)).unwrap();
    write_pair(&install, &old_exe, &manifest_for(&old_exe));
    let new_exe = pe_fixture(0x77);
    write_pair(&payload, &new_exe, &manifest_for(&new_exe));

    // Deny sharing on the manifest so its backup move fails after the
    // executable was already moved aside.
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(install.join("uninstall-manifest.json"))
        .unwrap();
    let error = deploy_uninstaller_pair(&install, &payload).unwrap_err();
    drop(locked);
    assert!(error.contains("已恢复"), "rollback must be reported accurately: {error}");
    assert_eq!(fs::read(install.join("uninstall.exe")).unwrap(), old_exe);
    assert_eq!(fs::read(install.join("uninstall-manifest.json")).unwrap(), old_manifest_bytes);
    assert!(validate_uninstaller(&install, "x64", &product_version()).is_ok());

    let _ = fs::remove_dir_all(&root);
}

/// A restore that cannot complete must be reported as a failure and must
/// keep the backup instead of claiming the original was recovered.
#[cfg(windows)]
#[test]
fn restore_replaced_reports_a_failed_restore_and_keeps_the_backup() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("restore-failure-test");
    let install = root.join("install");
    let backup = root.join("backup");
    fs::create_dir_all(&install).unwrap();
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("uninstall.exe"), b"original").unwrap();
    let blocker = install.join("uninstall.exe").join("blocked.bin");
    fs::create_dir_all(install.join("uninstall.exe")).unwrap();
    fs::write(&blocker, b"x").unwrap();
    let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&blocker).unwrap();

    let moved = vec!["uninstall.exe".to_string()];
    let error = restore_replaced(&install, &backup, &moved).unwrap_err();
    drop(locked);
    assert!(error.contains("uninstall.exe"), "unexpected failure text: {error}");
    assert!(backup.join("uninstall.exe").exists(), "a failed restore must keep the backup");

    let _ = fs::remove_dir_all(&root);
}

/// Replacing core program files must preserve user configuration and restore
/// the previous files exactly when the post-replacement check fails.
#[test]
fn replace_from_payload_preserves_user_config_and_rolls_back() {
    let root = temporary_root("core-replace-test");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_install(&install);
write_valid_payload(&payload, 0x01, 0x02);
    fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();
    fs::write(install.join("SidekickAI.exe"), pe_fixture(0x81)).unwrap();
    fs::write(payload.join("SidekickAI.exe"), pe_fixture(0x82)).unwrap();
    fs::write(payload.join("resources").join("app.asar"), app_archive(b"new-asar")).unwrap();

    replace_from_payload(&install, &payload, &CORE_ITEMS, &|| Ok(())).unwrap();
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), pe_fixture(0x82));
    assert_eq!(fs::read(install.join("resources").join("app.asar")).unwrap(), app_archive(b"new-asar"));
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");

    let before_exe = fs::read(install.join("SidekickAI.exe")).unwrap();
    let before_asar = fs::read(install.join("resources").join("app.asar")).unwrap();
    let error = replace_from_payload(&install, &payload, &CORE_ITEMS, &|| Err("verify failed".to_string()))
        .unwrap_err();
    assert!(error.contains("verify failed") && error.contains("已恢复"), "unexpected error: {error}");
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), before_exe);
    assert_eq!(fs::read(install.join("resources").join("app.asar")).unwrap(), before_asar);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");

    let _ = fs::remove_dir_all(&root);
}

/// Registration removal is scoped to an explicit InstallLocation match so a
/// different installation's entry survives. Only a dedicated test key is
/// used; the real SidekickAI uninstall key is never touched.
#[test]
fn registration_removal_requires_a_matching_install_location() {
    let root = temporary_root("registration-match-test");
    let installed = root.join("installed");
    let other = root.join("other");
    fs::create_dir_all(&installed).unwrap();
    fs::create_dir_all(&other).unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Uninstaller-Match-{}", std::process::id());
    let empty_key = format!("HKCU\\Software\\SidekickAI-Uninstaller-Empty-{}", std::process::id());
    cleanup_registry_key(&key);
    cleanup_registry_key(&empty_key);

    write_uninstall_registration(&installed, &key).unwrap();
    assert_eq!(
        registered_install_location(&key).unwrap().as_deref(),
        Some(installed.to_string_lossy().as_ref())
    );

    // A different installation's location must not remove this registration.
    assert!(!remove_uninstall_entry_if_matches(&key, &other).unwrap());
    assert!(registered_install_location(&key).unwrap().is_some());

    // The explicit match removes exactly this key.
    assert!(remove_uninstall_entry_if_matches(&key, &installed).unwrap());
    assert!(registered_install_location(&key).unwrap().is_none());

    // A missing key is not an error and removes nothing.
    assert!(!remove_uninstall_entry_if_matches(&key, &installed).unwrap());

    // An empty InstallLocation is not an explicit match.
    let seeded = create_registry_key(&empty_key).unwrap();
    seeded.set_value("InstallLocation", &"").unwrap();
    drop(seeded);
    assert!(!remove_uninstall_entry_if_matches(&empty_key, &installed).unwrap());
    assert!(registered_install_location(&empty_key).unwrap().is_some());

    cleanup_registry_key(&key);
    cleanup_registry_key(&empty_key);
    let _ = fs::remove_dir_all(&root);
}

/// Replacing the installed program files must compare actual content, so a
/// same-version repair can skip an unchanged core.
#[test]
fn core_payload_matching_compares_actual_content() {
    let root = temporary_root("core-match-test");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x01, 0x02);
    write_valid_payload(&payload, 0x01, 0x02);
    assert!(core_payload_matches(&install, &payload));

    fs::write(payload.join("v8_context_snapshot.bin"), b"current-runtime").unwrap();
    fs::write(install.join("v8_context_snapshot.bin"), b"previous-runtime").unwrap();
    assert!(!core_payload_matches(&install, &payload), "runtime mismatches require replacement");
    fs::write(install.join("v8_context_snapshot.bin"), b"current-runtime").unwrap();
    assert!(core_payload_matches(&install, &payload));

    fs::write(payload.join("resources").join("app.asar"), app_archive(b"different")).unwrap();
    assert!(!core_payload_matches(&install, &payload));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn repair_replaces_runtime_files_and_preserves_local_state() {
    let root = temporary_root("repair-runtime-files");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x33, 0x44);
    fs::write(install.join("ffmpeg.dll"), b"old-library").unwrap();
    fs::write(payload.join("ffmpeg.dll"), b"current-library").unwrap();
    fs::write(payload.join("v8_context_snapshot.bin"), b"current-snapshot").unwrap();
    fs::create_dir_all(install.join("resources/cloud")).unwrap();
    fs::write(install.join("resources/cloud/default.json"), b"downloaded-resource").unwrap();
    fs::write(install.join("install-config.json"), b"personal-config").unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/settings.db"), b"personal-data").unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Repair-Runtime-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload.clone());
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;

    run_with(&req, &hooks).unwrap();

    assert!(core_payload_matches(&install, &payload));
    assert_eq!(fs::read(install.join("ffmpeg.dll")).unwrap(), b"current-library");
    assert_eq!(fs::read(install.join("v8_context_snapshot.bin")).unwrap(), b"current-snapshot");
    assert_eq!(fs::read(install.join("resources/cloud/default.json")).unwrap(), b"downloaded-resource");
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"personal-config");
    assert_eq!(fs::read(install.join("data/settings.db")).unwrap(), b"personal-data");
    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn completion_only_writes_changed_new_install_configuration() {
    let root = temporary_root("completion-config");
    fs::create_dir_all(&root).unwrap();
    let mut req = request(&root, false);
    assert!(super::config::install_config_needs_write(&req));
    write_install_config(&req, &root).unwrap();
    assert!(!super::config::install_config_needs_write(&req));
    req.options.insert("autoLaunch".into(), serde_json::json!(true));
    assert!(super::config::install_config_needs_write(&req));
    req.mode = manifest::InstallMode::Repair;
    let legacy = b"{\"modules\":{},\"options\":{\"legacy\":true}}";
    fs::write(root.join("install-config.json"), legacy).unwrap();
    assert!(!super::config::install_config_needs_write(&req));
    super::config::flush_install_config_with(&req, &isolated_hooks(&root)).unwrap();
    assert_eq!(fs::read(root.join("install-config.json")).unwrap(), legacy);
    fs::remove_file(root.join("install-config.json")).unwrap();
    assert!(!super::config::install_config_needs_write(&req));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_without_request_identity_preserves_the_existing_installation_generation() {
    let root = temporary_root("repair-wire-identity");
    for changed in [true, false] {
        let case = root.join(if changed { "changed" } else { "current" });
        let install = case.join("install");
        let payload = case.join("payload");
        write_valid_installed_payload(&install, 0x33, 0x44);
        write_valid_payload(&payload, 0x33, 0x44);
        fs::write(install.join("ffmpeg.dll"), b"previous-library").unwrap();
        fs::write(payload.join("ffmpeg.dll"), if changed { b"replaced-library" } else { b"previous-library" }).unwrap();
        let config = b"{\"schemaVersion\":2,\"installationId\":\"existing-generation\",\"configState\":\"complete\",\"options\":{\"autoLaunch\":false},\"resources\":[{\"status\":\"valid\"}]}";
        fs::write(install.join("install-config.json"), config).unwrap();
        let receipt_path = install.join("install-receipt.json");
        let mut receipt: serde_json::Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt["installationId"] = serde_json::json!("existing-generation");
        fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let key = format!("HKCU\\Software\\SidekickAI-Repair-Wire-{}-{changed}", std::process::id());
        let mut hooks = isolated_hooks(&case);
        hooks.extracted = Some(payload.clone());
        hooks.registration_key = Some(key.clone());
        let mut wire = serde_json::to_value(request(&install, false)).unwrap();
        wire["mode"] = serde_json::json!("repair");
        wire.as_object_mut().unwrap().remove("installationId");
        let req: InstallRequest = serde_json::from_value(wire).unwrap();
        assert!(req.installation_id.is_empty());
        let result = run_with(&req, &hooks);
        cleanup_registry_key(&key);
        assert!(result.is_ok(), "repair wire request failed: {result:?}");
        assert!(core_payload_matches(&install, &payload));
        assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
        let (receipt, _) = sidekickai_uninstall_core::product::read_install_receipt(&install).unwrap();
        assert_eq!(receipt.installation_id, "existing-generation");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_without_stored_identity_preserves_legacy_config_and_reuses_the_new_receipt() {
    let root = temporary_root("repair-legacy-generation");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x33, 0x44);
    let config = b"{\"modules\":{},\"options\":{\"autoLaunch\":false}}";
    fs::write(install.join("install-config.json"), config).unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Repair-Legacy-Id-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    req.installation_id.clear();
    run_with(&req, &hooks).unwrap();
    let (first, _) = sidekickai_uninstall_core::product::read_install_receipt(&install).unwrap();
    assert!(!first.installation_id.is_empty());
    req.installation_id = "untrusted-request-generation".into();
    run_with(&req, &hooks).unwrap();
    let (second, _) = sidekickai_uninstall_core::product::read_install_receipt(&install).unwrap();
    assert_eq!(second.installation_id, first.installation_id);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn conflicting_repair_identity_is_rejected_before_program_or_registration_changes() {
    let root = temporary_root("repair-conflicting-generation");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x33, 0x44);
    write_valid_payload(&payload, 0x55, 0x66);
    let key = format!("HKCU\\Software\\SidekickAI-Repair-Conflict-Id-{}", std::process::id());
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    super::registry::register_uninstall(&hooks, &req, &install).unwrap();
    fs::write(install.join("install-config.json"), b"{\"installationId\":\"conflicting-generation\"}").unwrap();
    let before = super::validate::directory_digest(&install).unwrap();
    let registered = snapshot_registration(&key).unwrap();
    req.mode = InstallMode::Repair;
    req.installation_id.clear();
    assert!(run_with(&req, &hooks).unwrap_err().contains("安装标识不一致"));
    assert_eq!(super::validate::directory_digest(&install).unwrap(), before);
    assert_eq!(snapshot_registration(&key).unwrap(), registered);
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_runtime_replacement_removes_new_files_and_restores_old_bytes() {
    let root = temporary_root("runtime-replacement-rollback");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_install(&install);
    write_valid_payload(&payload, 0x01, 0x02);
    fs::write(install.join("ffmpeg.dll"), b"old-runtime").unwrap();
    fs::write(payload.join("ffmpeg.dll"), b"new-runtime").unwrap();
    fs::write(payload.join("v8_context_snapshot.bin"), b"new-snapshot").unwrap();
    fs::write(payload.join("resources/app.asar"), app_archive(b"new-app")).unwrap();
    let names = program_items(&payload).unwrap();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    assert!(replace_from_payload(&install, &payload, &refs, &|| Err("verification rejected".into())).is_err());
    assert_eq!(fs::read(install.join("ffmpeg.dll")).unwrap(), b"old-runtime");
    assert_eq!(fs::read(install.join("resources/app.asar")).unwrap(), edition_fixtures::archive_for_version(
        &sidekickai_uninstall_core::product::edition().package_name, Some(&product_version()), b"fixture-asar"));
    assert!(!install.join("v8_context_snapshot.bin").exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn replacement_refuses_a_linked_resource_parent_without_changing_external_files() {
    let root = temporary_root("linked-resource-replacement");
    let install = root.join("install");
    let payload = root.join("payload");
    let outside = root.join("outside");
    fs::create_dir_all(&install).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("app.asar"), app_archive(b"external-content")).unwrap();
    write_valid_payload(&payload, 0x01, 0x02);
    std::os::windows::fs::symlink_dir(&outside, install.join("resources")).unwrap();
    let error = replace_from_payload(&install, &payload, &["resources/app.asar"], &|| Ok(())).unwrap_err();
    assert!(error.contains("重解析点"));
    assert_eq!(fs::read(outside.join("app.asar")).unwrap(), app_archive(b"external-content"));
    assert!(replace_from_payload(&install, &payload, &["../outside/app.asar"], &|| Ok(())).is_err());
    fs::remove_dir(install.join("resources")).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore = "Requires an explicit real payload and a new isolated acceptance directory"]
fn real_payload_repairs_a_mixed_runtime_and_installs_with_isolated_registration() {
    let root = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_DIR").expect("acceptance directory"));
    let payload = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_PAYLOAD").expect("verified payload"));
    let archive = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_ARCHIVE").expect("verified raw application archive"));
    let previous = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_PREVIOUS").expect("previous program copy"));
    assert!(root.is_absolute() && !root.exists()); assert!(payload.is_absolute() && previous.is_absolute() && archive.is_absolute());
    let proof_text = fs::read_to_string(payload.join("distribution-proof.json")).unwrap();
    let proof = sidekickai_uninstall_core::distribution::parse_envelope(proof_text.as_bytes()).unwrap();
    let body = crate::distribution::verify_body(&proof).unwrap();
    sidekickai_uninstall_core::distribution::verify_declared_files(&payload,&body.files).unwrap();
    fs::create_dir_all(&root).unwrap();
    let repaired = root.join("repaired");
    let key = format!("HKCU\\Software\\SidekickAI-Acceptance-{}", std::process::id());
    let mut hooks = isolated_hooks(&root); hooks.extracted = Some(payload.clone()); hooks.registration_key = Some(key.clone());
    let mut req = request(&repaired,false);
    req.distribution_source_path = archive.to_string_lossy().into_owned();
    req.distribution_body_proof = proof_text.clone(); req.distribution_product_version = body.product_version.clone();
    crate::distribution::apply_request(&req).unwrap();
    run_engine(&req,&hooks).unwrap();
    let before_config = fs::read(repaired.join("install-config.json")).unwrap();
    let before_identity = sidekickai_uninstall_core::distribution::verify_installed_identity(&repaired).unwrap();
    fs::copy(previous.join("SidekickAI.exe"),repaired.join("SidekickAI.exe")).unwrap();
    assert!(!core_payload_matches(&repaired,&payload));
    req.mode = InstallMode::Repair; req.installation_id.clear();
    run_engine(&req,&hooks).unwrap();
    assert!(core_payload_matches(&repaired,&payload));
    assert_eq!(fs::read(repaired.join("install-config.json")).unwrap(),before_config);
    let after_repair = sidekickai_uninstall_core::distribution::verify_installed_identity(&repaired).unwrap();
    assert_ne!(after_repair.receipt.installation_id,before_identity.receipt.installation_id);
    let (receipt,_) = sidekickai_uninstall_core::product::read_install_receipt(&repaired).unwrap();
    let config: serde_json::Value = serde_json::from_slice(&before_config).unwrap();
    assert_eq!(receipt.installation_id,config["installationId"].as_str().unwrap());
    let modified = fs::metadata(repaired.join("SidekickAI.exe")).unwrap().modified().unwrap();
    use std::os::windows::fs::OpenOptionsExt;
    let pin = fs::OpenOptions::new().read(true).share_mode(1).open(repaired.join("SidekickAI.exe")).unwrap();
    run_engine(&req,&hooks).unwrap(); drop(pin);
    assert_eq!(fs::metadata(repaired.join("SidekickAI.exe")).unwrap().modified().unwrap(),modified);
    let after_healthy = sidekickai_uninstall_core::distribution::verify_installed_identity(&repaired).unwrap();
    assert_ne!(after_healthy.receipt.installation_id,after_repair.receipt.installation_id);
    assert_eq!(fs::read(repaired.join("install-config.json")).unwrap(),before_config);
    let fresh = root.join("fresh");
    req = request(&fresh,false); req.distribution_source_path = archive.to_string_lossy().into_owned();
    req.distribution_body_proof = proof_text; req.distribution_product_version = body.product_version.clone();
    run_engine(&req,&hooks).unwrap();
    assert!(core_payload_matches(&fresh,&payload));
    sidekickai_uninstall_core::distribution::verify_installed_identity(&fresh).unwrap();
    assert!(!fresh.join("portable.txt").exists() && !repaired.join("portable.txt").exists());
    cleanup_registry_key(&key);
    fs::write(root.join("native-acceptance.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "repairRuntimeMatches":true,"repairConfigurationPreserved":true,"repairIdentityPreserved":true,
        "repairRequestIdentityAbsent":true,"freshRuntimeMatches":true,"healthyRepairDoesNotReplaceCore":true,
        "distributionIdentityChangesAfterEveryRepair":true,"registryIsolated":true,"version":body.product_version,
        "repaired":repaired,"fresh":fresh,"sourceArchive":archive,
        "sourceArchiveSha256":sidekickai_uninstall_core::distribution::sha256_file(&archive).unwrap(),
        "bodyProofSha256":sidekickai_uninstall_core::distribution::content_digest(&proof.payload).unwrap()
    })).unwrap()).unwrap();
}

/// A copy failure during a core replacement must be reported and the
/// previous copy restored from the same-volume backup.
#[cfg(windows)]
#[test]
fn replace_from_payload_reports_a_failed_copy_and_keeps_the_previous_copy() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = temporary_root("core-copy-failure-test");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_install(&install);
    write_valid_payload(&payload, 0x01, 0x02);
    fs::write(payload.join("SidekickAI.exe"), pe_fixture(0x91)).unwrap();
    let before_exe = fs::read(install.join("SidekickAI.exe")).unwrap();
    let before_asar = fs::read(install.join("resources").join("app.asar")).unwrap();

    // Deny read sharing on the incoming executable so the deployment copy
    // fails after the previous copy was already moved into the backup.
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(payload.join("SidekickAI.exe"))
        .unwrap();
    let error = replace_from_payload(&install, &payload, &CORE_ITEMS, &|| Ok(())).unwrap_err();
    drop(locked);

    assert!(error.contains("已恢复"), "unexpected error: {error}");
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), before_exe);
    assert_eq!(fs::read(install.join("resources").join("app.asar")).unwrap(), before_asar);
    assert!(stray_staging_dirs(&install).is_empty(), "a successful rollback must remove its backup");

    let _ = fs::remove_dir_all(&root);
}

/// A failed overwrite must restore the previous registration values exactly
/// instead of deleting a key this installation did not create. Only a
/// dedicated test subkey is used.
#[test]
fn registration_snapshot_restores_previous_values_after_a_failed_overwrite() {
    let root = temporary_root("registration-snapshot-test");
    let first = root.join("first");
    let second = root.join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Snapshot-{}", std::process::id());
    let absent = format!("HKCU\\Software\\SidekickAI-Snapshot-Absent-{}", std::process::id());
    cleanup_registry_key(&key);
    cleanup_registry_key(&absent);

    write_uninstall_registration(&first, &key).unwrap();
    let snapshot = snapshot_registration(&key).unwrap();
    assert!(snapshot.is_some());

    write_uninstall_registration(&second, &key).unwrap();
    assert_eq!(
        registered_install_location(&key).unwrap().as_deref(),
        Some(second.to_string_lossy().as_ref())
    );
    restore_registration(&key, &snapshot).unwrap();
    assert_eq!(
        registered_install_location(&key).unwrap().as_deref(),
        Some(first.to_string_lossy().as_ref())
    );
    assert!(read_registry_string(&key, "UninstallString")
        .unwrap()
        .unwrap()
        .contains(&first.to_string_lossy().to_string()));

    // A key that did not exist before is removed by the restore.
    assert!(snapshot_registration(&absent).unwrap().is_none());
    write_uninstall_registration(&second, &absent).unwrap();
    restore_registration(&absent, &None).unwrap();
    assert!(registered_install_location(&absent).unwrap().is_none());

    cleanup_registry_key(&key);
    cleanup_registry_key(&absent);
    let _ = fs::remove_dir_all(&root);
}

/// Full install sequencing against a fixture payload, dedicated registry key
/// and dedicated shortcut directories: no real installation, user profile or
/// real uninstall entry is touched.
#[test]
fn install_orchestration_deploys_registers_and_creates_shortcuts() {
    if manifest::host_arch() != "x64" {
        return; // pe_fixture is x64 only
    }
    let root = temporary_root("install-orchestration");
    let install = root.join("install");
    write_valid_install(&install);
    fs::write(install.join("SidekickAI.exe"), pe_fixture(0x11)).unwrap();
    fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/chat.db"), b"portable-conversations").unwrap();
    fs::create_dir(install.join("data.bak-1234567890123")).unwrap();
    fs::write(install.join("data.bak-1234567890123/secret"), b"recovery data").unwrap();
    fs::write(install.join("data.restore.json"), b"pending restore").unwrap();

    let payload = root.join("payload");
    let (new_exe, _) = write_valid_payload(&payload, 0x22, 0x33);

    let key = format!("HKCU\\Software\\SidekickAI-Install-Orch-{}", std::process::id());
    cleanup_registry_key(&key);
    let old = root.join("old-install");
    fs::create_dir_all(&old).unwrap();
    write_uninstall_registration(&old, &key).unwrap();

    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.create_desktop_shortcut = true;

    run_with(&req, &hooks).unwrap();

    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), new_exe);
    assert!(install.join("plugins-manifest.json").is_file());
    assert_eq!(fs::read(install.join("data/chat.db")).unwrap(), b"portable-conversations");
    assert_eq!(fs::read(install.join("data.bak-1234567890123/secret")).unwrap(), b"recovery data");
    assert_eq!(fs::read(install.join("data.restore.json")).unwrap(), b"pending restore");
    assert!(!install.join("portable.txt").exists());
    let expected_location = install.to_string_lossy().into_owned();
    assert_eq!(
        registered_install_location(&key).unwrap().as_deref(),
        Some(expected_location.as_str())
    );
    let uninstall_string = read_registry_string(&key, "UninstallString").unwrap().unwrap();
    assert!(
        uninstall_string.contains(&install.join("uninstall.exe").to_string_lossy().to_string()),
        "unexpected UninstallString: {uninstall_string}"
    );
    // Shortcuts are created only in the injected directories and point at
    // the new installation.
    for link in [
        root.join("desktop").join("SidekickAI.lnk"),
        root.join("start-menu").join("SidekickAI.lnk"),
    ] {
        assert!(link.is_file(), "missing shortcut {}", link.display());
        assert!(
            shortcut_points_to(&link, &install.join("SidekickAI.exe")),
            "shortcut {} points at {:?}",
            link.display(),
            shortcut_target(&link)
        );
    }
    assert!(stray_staging_dirs(&install).is_empty());

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}

/// A failed tail step must restore the previous files and the previous
/// registration values instead of removing the registration blindly.
#[test]
fn failed_install_restores_old_files_and_preserves_old_registration() {
    if manifest::host_arch() != "x64" {
        return; // pe_fixture is x64 only
    }
    let root = temporary_root("install-rollback");
    let install = root.join("install");
    write_valid_install(&install);
    let old_exe = fs::read(install.join("SidekickAI.exe")).unwrap();
    let old_asar = fs::read(install.join("resources").join("app.asar")).unwrap();
    fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();
    fs::create_dir_all(install.join("data")).unwrap();
    fs::write(install.join("data/chat.db"), b"portable-conversations").unwrap();
    fs::create_dir(install.join("data.bak-1234567890123")).unwrap();
    fs::write(install.join("data.bak-1234567890123/secret"), b"recovery data").unwrap();
    fs::write(install.join("data.restore.json"), b"pending restore").unwrap();

    let payload = root.join("payload");
    write_valid_payload(&payload, 0x44, 0x55);

    let key = format!("HKCU\\Software\\SidekickAI-Install-Rollback-{}", std::process::id());
    cleanup_registry_key(&key);
    write_uninstall_registration(&install, &key).unwrap();
    let old_location = registered_install_location(&key).unwrap();

    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    hooks.fail_after_registration = true;
    let req = request(&install, false);

    let error = run_with(&req, &hooks).unwrap_err();
    assert!(error.contains("安装失败"), "unexpected error: {error}");
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), old_exe);
    assert_eq!(fs::read(install.join("resources").join("app.asar")).unwrap(), old_asar);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");
    assert_eq!(fs::read(install.join("data/chat.db")).unwrap(), b"portable-conversations");
    assert_eq!(fs::read(install.join("data.bak-1234567890123/secret")).unwrap(), b"recovery data");
    assert_eq!(fs::read(install.join("data.restore.json")).unwrap(), b"pending restore");
    // The registration written by the failed attempt is replaced by the
    // previous values, not deleted.
    assert_eq!(registered_install_location(&key).unwrap(), old_location);
    assert!(read_registry_string(&key, "UninstallString").unwrap().is_some());
    assert!(stray_staging_dirs(&install).is_empty());

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn startup_task_validation_failure_restores_install_and_repair_payloads() {
    if manifest::host_arch() != "x64" { return; }
    for mode in [InstallMode::Install, InstallMode::Repair] {
        let root = temporary_root("startup-task-rollback");
        let install = root.join("install");
        let payload = root.join("payload");
        write_valid_installed_payload(&install, 0x21, 0x22);
        write_valid_payload(&payload, 0x23, 0x24);
        fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();
        let old_executable = fs::read(install.join("SidekickAI.exe")).unwrap();
        let old_uninstaller = fs::read(install.join("uninstall.exe")).unwrap();
        let key = format!("HKCU\\Software\\SidekickAI-Startup-Rollback-{}", std::process::id());
        cleanup_registry_key(&key);
        write_uninstall_registration(&install, &key).unwrap();
        let before = snapshot_registration(&key).unwrap();
        let mut hooks = isolated_hooks(&root);
        hooks.extracted = Some(payload);
        hooks.registration_key = Some(key.clone());
        hooks.fail_startup_maintenance = true;
        let mut req = request(&install, false);
        req.mode = mode;
        let error = run_with(&req, &hooks).unwrap_err();
        assert!(error.contains("管理员启动任务校验失败"), "{error}");
        assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), old_executable);
        assert_eq!(fs::read(install.join("uninstall.exe")).unwrap(), old_uninstaller);
        assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");
        assert_eq!(snapshot_registration(&key).unwrap(), before);
        assert!(stray_staging_dirs(&install).is_empty());
        cleanup_registry_key(&key);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn healthy_repair_reports_task_validation_failure_before_registration() {
    if manifest::host_arch() != "x64" { return; }
    let root = temporary_root("healthy-startup-task-validation");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_installed_payload(&install, 0x41, 0x42);
    write_valid_payload(&payload, 0x41, 0x42);
    let key = format!("HKCU\\Software\\SidekickAI-Startup-Healthy-{}", std::process::id());
    cleanup_registry_key(&key);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    hooks.fail_startup_maintenance = true;
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    assert!(run_with(&req, &hooks).unwrap_err().contains("管理员启动任务校验失败"));
    assert!(snapshot_registration(&key).unwrap().is_none());
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), pe_fixture(0x41));
    assert!(stray_staging_dirs(&install).is_empty());
    fs::remove_dir_all(root).unwrap();
}

/// Repair must replace only a stale uninstaller and leave the core alone
/// when the installed program files already match the payload exactly.
#[test]
fn repair_replaces_only_the_stale_uninstaller() {
    if manifest::host_arch() != "x64" {
        return; // pe_fixture is x64 only
    }
    let root = temporary_root("repair-orchestration");
    let install = root.join("install");
    write_valid_install(&install);
    fs::write(install.join("SidekickAI.exe"), pe_fixture(0x66)).unwrap();
    fs::write(install.join("resources").join("app.asar"), app_archive(b"payload-asar")).unwrap();
    let stale = pe_fixture(0x77);
    write_pair(&install, &stale, &manifest_for(&stale));
    fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();
    let core_before = fs::read(install.join("SidekickAI.exe")).unwrap();

    let payload = root.join("payload");
    let (_, new_uninstaller) = write_valid_payload(&payload, 0x66, 0x88);

    let key = format!("HKCU\\Software\\SidekickAI-Repair-Orch-{}", std::process::id());
    cleanup_registry_key(&key);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;

    run_with(&req, &hooks).unwrap();

    assert_eq!(fs::read(install.join("uninstall.exe")).unwrap(), new_uninstaller);
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), core_before, "a matching core must be left alone");
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");
    assert_eq!(
        registered_install_location(&key).unwrap().as_deref(),
        Some(install.to_string_lossy().as_ref())
    );

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}

/// When the core payload really differs, repair replaces it while preserving
/// configuration, and does not need the uninstaller check to decide.
#[test]
fn repair_replaces_core_only_when_the_payload_content_differs() {
    if manifest::host_arch() != "x64" {
        return; // pe_fixture is x64 only
    }
    let root = temporary_root("repair-core-diff");
    let install = root.join("install");
    let payload = root.join("payload");
    write_valid_install(&install);
    let (new_exe, new_uninstaller) = write_valid_payload(&payload, 0x99, 0xaa);
    // The deployed uninstaller already matches the payload, so only the core
    // is stale.
    write_pair(&install, &new_uninstaller, &manifest_for(&new_uninstaller));
    fs::write(install.join("install-config.json"), b"{\"user\":true}").unwrap();

    let key = format!("HKCU\\Software\\SidekickAI-Repair-Core-{}", std::process::id());
    cleanup_registry_key(&key);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;

    run_with(&req, &hooks).unwrap();

    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), new_exe);
    assert_eq!(fs::read(install.join("resources").join("app.asar")).unwrap(), edition_fixtures::archive_for_version(
        &sidekickai_uninstall_core::product::edition().package_name, Some(&product_version()), b"payload-asar"));
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), b"{\"user\":true}");
    assert!(stray_staging_dirs(&install).is_empty());

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}

/// A same-volume backup rename that fails must abort without any destructive
/// fallback: the previous installation stays byte-for-byte intact and no
/// partial backup is left behind.
#[cfg(windows)]
#[test]
fn install_backup_rename_failure_leaves_the_old_installation_untouched() {
    use std::os::windows::fs::OpenOptionsExt;
    if manifest::host_arch() != "x64" {
        return; // pe_fixture is x64 only
    }
    let root = temporary_root("install-backup-rename-failure");
    let install = root.join("install");
    write_valid_install(&install);
    let old_exe = fs::read(install.join("SidekickAI.exe")).unwrap();
    let payload = root.join("payload");
    write_valid_payload(&payload, 0xbb, 0xcc);

    // An open handle without delete sharing prevents the directory rename.
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(install.join("resources").join("app.asar"))
        .unwrap();

    let key = format!("HKCU\\Software\\SidekickAI-Backup-Rename-{}", std::process::id());
    cleanup_registry_key(&key);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload);
    hooks.registration_key = Some(key.clone());
    let req = request(&install, false);

    let error = run_with(&req, &hooks).unwrap_err();
    drop(locked);

    assert!(error.contains("旧版本未受影响"), "unexpected error: {error}");
    assert_eq!(fs::read(install.join("SidekickAI.exe")).unwrap(), old_exe);
    assert!(install.join("resources").join("app.asar").is_file());
    assert!(stray_staging_dirs(&install).is_empty(), "no partial backup may be left");
    assert!(registered_install_location(&key).unwrap().is_none());

    cleanup_registry_key(&key);
    let _ = fs::remove_dir_all(&root);
}
