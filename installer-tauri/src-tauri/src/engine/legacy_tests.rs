use super::*;
use sidekickai_uninstall_core::product;


#[test]
#[ignore = "Requires a frozen real legacy program copy, signed payload and new isolated directory"]
fn real_legacy_installation_migrates_transactionally_to_signed_payload() {
    use sidekickai_uninstall_core::distribution as contract;
    let root = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_DIR").expect("acceptance directory"));
    let source = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_LEGACY_SOURCE").expect("frozen legacy program copy"));
    let payload = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_PAYLOAD").expect("verified payload"));
    let archive = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_ARCHIVE").expect("verified application archive"));
    assert!(root.is_absolute() && !root.exists());
    assert!(source.is_absolute() && source.is_dir() && payload.is_absolute() && archive.is_absolute());
    let source_digest = super::super::validate::directory_digest(&source).unwrap();
    let source_receipt: product::InstallReceipt = serde_json::from_slice(&fs::read(source.join(product::INSTALL_RECEIPT)).unwrap()).unwrap();
    assert_eq!(source_receipt.edition, product::edition_id());
    assert!(!source.join("distribution-proof.json").exists());
    assert!(!source.join("maintenance/distribution-receipt.json").exists());
    fs::create_dir_all(&root).unwrap();
    let install = root.join("fresh");
    super::super::deploy::copy_dir(&source, &install).unwrap();
    let mut receipt = source_receipt.clone();
    receipt.install_location = sidekickai_uninstall_core::path::normalize_absolute_path(&install).unwrap().as_string();
    receipt.registry_root = "HKCU".into();
    receipt.installation_id = "isolated-legacy-generation".into();
    let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
    fs::write(install.join(product::INSTALL_RECEIPT), &receipt_bytes).unwrap();
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    req.installation_id = receipt.installation_id.clone();
    write_install_config(&req, &install).unwrap();
    let config_path = install.join("install-config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["options"]["autoStart"] = true.into();
    let config_bytes = (serde_json::to_string_pretty(&config).unwrap() + "\r\n").into_bytes();
    fs::write(&config_path, &config_bytes).unwrap();
    fs::create_dir(install.join("data")).unwrap();
    fs::write(install.join("data/personal-sentinel.txt"), b"isolated retained data").unwrap();
    fs::create_dir_all(install.join("resources/cloud")).unwrap();
    fs::write(install.join("resources/cloud/local-sentinel.txt"), b"isolated retained cloud content").unwrap();
    let key = format!("HKCU\\Software\\SidekickAI-Real-Legacy-{}", std::process::id());
    cleanup_registry_key(&key);
    let registered = create_registry_key(&key).unwrap();
    for (name, value) in [("InstallLocation", receipt.install_location.clone()), ("DisplayVersion", receipt.version.clone()),
        ("Edition", product::edition_id().into()), ("InstallReceiptSha256", product::receipt_digest(&receipt_bytes)),
        ("UninstallString", format!("\"{}\" --uninstall", install.join("uninstall.exe").display()))] {
        registered.set_value(name, &value).unwrap();
    }
    drop(registered);
    let mut hooks = isolated_hooks(&root);
    hooks.extracted = Some(payload.clone());
    hooks.registration_key = Some(key.clone());
    let admitted = prepare(&req, &hooks).unwrap();
    assert!(admitted.legacy_identity.is_some());
    let before = super::super::validate::directory_digest(&install).unwrap();
    let registered_before = snapshot_registration(&key).unwrap();
    let proof_text = fs::read_to_string(payload.join("distribution-proof.json")).unwrap();
    let proof = contract::parse_envelope(proof_text.as_bytes()).unwrap();
    let body = crate::distribution::verify_body(&proof).unwrap();
    contract::verify_declared_files(&payload, &body.files).unwrap();
    req.distribution_source_path = archive.to_string_lossy().into_owned();
    req.distribution_body_proof = proof_text;
    req.distribution_product_version = body.product_version.clone();
    crate::distribution::apply_request(&req).unwrap();
    let mut failures = Vec::new();
    for failure in ["startup", "receipt", "registration"] {
        let mut failing = hooks.clone();
        failing.fail_startup_maintenance = failure == "startup";
        failing.fail_after_receipt = failure == "receipt";
        failing.fail_after_registration = failure == "registration";
        let mut failed_request = req.clone();
        if failure == "registration" { failed_request.mode = InstallMode::Install; }
        let error = run_engine(&failed_request, &failing).unwrap_err();
        let cause = match failure { "startup" => "管理员启动任务校验失败", "receipt" => "receipt registration interrupted", _ => "注入的安装后置失败" };
        assert!(error.contains(cause) && error.contains("已恢复"), "{failure}: {error}");
        assert_eq!(super::super::validate::directory_digest(&install).unwrap(), before, "{failure}");
        assert_eq!(snapshot_registration(&key).unwrap(), registered_before, "{failure}");
        assert!(prepare(&req, &hooks).unwrap().legacy_identity.is_some());
        failures.push(serde_json::json!({"failure":failure,"originalBytesRestored":true,"registrationRestored":true}));
        println!("Verified legacy rollback: {failure}");
    }
    run_engine(&req, &hooks).unwrap();
    let migrated = contract::verify_installed_identity(&install).unwrap();
    assert_eq!(migrated.body.product_version, body.product_version);
    assert!(core_payload_matches(&install, &payload));
    contract::verify_declared_files(&install, &body.files).unwrap();
    assert_eq!(product::read_install_receipt(&install).unwrap().0.installation_id, receipt.installation_id);
    assert_eq!(fs::read(&config_path).unwrap(), config_bytes);
    assert_eq!(fs::read(install.join("data/personal-sentinel.txt")).unwrap(), b"isolated retained data");
    assert_eq!(fs::read(install.join("resources/cloud/local-sentinel.txt")).unwrap(), b"isolated retained cloud content");
    assert!(prepare(&req, &hooks).unwrap().legacy_identity.is_none());
    run_engine(&req, &hooks).unwrap();
    let repaired = contract::verify_installed_identity(&install).unwrap();
    assert_ne!(repaired.receipt.installation_id, migrated.receipt.installation_id);
    assert_eq!(fs::read(&config_path).unwrap(), config_bytes);
    let normal_install = root.join("normal-install");
    super::super::deploy::copy_dir(&source, &normal_install).unwrap();
    let mut normal_receipt = source_receipt.clone();
    normal_receipt.install_location = sidekickai_uninstall_core::path::normalize_absolute_path(&normal_install).unwrap().as_string();
    normal_receipt.registry_root = "HKCU".into();
    normal_receipt.installation_id = "isolated-normal-legacy-generation".into();
    let normal_receipt_bytes = serde_json::to_vec(&normal_receipt).unwrap();
    fs::write(normal_install.join(product::INSTALL_RECEIPT), &normal_receipt_bytes).unwrap();
    let mut normal_request = req.clone();
    normal_request.mode = InstallMode::Install;
    normal_request.install_dir = normal_install.to_string_lossy().into_owned();
    normal_request.installation_id = normal_receipt.installation_id.clone();
    write_install_config(&normal_request, &normal_install).unwrap();
    fs::create_dir_all(normal_install.join("data")).unwrap();
    fs::write(normal_install.join("data/retained.bin"), b"normal install retained data").unwrap();
    fs::create_dir_all(normal_install.join("resources/cloud/nested")).unwrap();
    fs::write(normal_install.join("resources/cloud/nested/retained.bin"), b"normal install acquired resource").unwrap();
    let normal_cloud_digest = super::super::validate::directory_digest(&normal_install.join("resources/cloud")).unwrap();
    let normal_key = format!("{key}-normal");
    cleanup_registry_key(&normal_key);
    let registered = create_registry_key(&normal_key).unwrap();
    for (name, value) in [("InstallLocation", normal_receipt.install_location.clone()), ("DisplayVersion", normal_receipt.version.clone()),
        ("Edition", product::edition_id().into()), ("InstallReceiptSha256", product::receipt_digest(&normal_receipt_bytes)),
        ("UninstallString", format!("\"{}\" --uninstall", normal_install.join("uninstall.exe").display()))] {
        registered.set_value(name, &value).unwrap();
    }
    drop(registered);
    let mut normal_hooks = hooks.clone();
    normal_hooks.registration_key = Some(normal_key.clone());
    assert!(prepare(&normal_request, &normal_hooks).unwrap().legacy_identity.is_some());
    normal_request.installation_id = "isolated-normal-request-generation".into();
    normal_request.options.insert("autoLaunch".into(), true.into());
    run_engine(&normal_request, &normal_hooks).unwrap();
    contract::verify_installed_identity(&normal_install).unwrap();
    contract::verify_declared_files(&normal_install, &body.files).unwrap();
    assert!(core_payload_matches(&normal_install, &payload));
    assert_eq!(super::super::validate::directory_digest(&normal_install.join("resources/cloud")).unwrap(), normal_cloud_digest);
    assert_eq!(fs::read(normal_install.join("data/retained.bin")).unwrap(), b"normal install retained data");
    let normal_config: serde_json::Value = serde_json::from_slice(&fs::read(normal_install.join("install-config.json")).unwrap()).unwrap();
    assert_eq!(normal_config["installationId"], normal_request.installation_id);
    assert_eq!(normal_config["options"]["autoLaunch"], true);
    assert_eq!(product::read_install_receipt(&normal_install).unwrap().0.installation_id, normal_request.installation_id);
    cleanup_registry_key(&normal_key);
    assert_eq!(super::super::validate::directory_digest(&source).unwrap(), source_digest);
    cleanup_registry_key(&key);
    let result = serde_json::json!({"passed":true,"edition":product::edition_id(),"version":body.product_version,
        "legacyVersion":source_receipt.version,"legacySource":source,"legacySourceSha256":source_digest,
        "sourceArchive":archive,"sourceArchiveSha256":contract::sha256_file(&archive).unwrap(),
        "bodyProofSha256":contract::content_digest(&proof.payload).unwrap(),"fresh":install,"upgraded":install,
        "oldProtocolInstallationMigrated":true,"configurationSha256":product::receipt_digest(&config_bytes),
        "installationGenerationPreserved":true,"localDataAndCloudBytesPreserved":true,
        "strictNewIdentityAndHealthyRepairAccepted":true,"registryIsolated":true,"rollbackCases":failures,
        "normalInstallLegacyTargetAccepted":true,"normalInstallAcquiredResourcesPreserved":true,
        "normalInstallRequestedConfigurationApplied":true,"normalInstall":normal_install,"normalInstallCloudSha256":normal_cloud_digest});
    fs::write(root.join("legacy-migration-acceptance.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    fs::write(root.join("native-acceptance.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}
fn prepare(req: &InstallRequest, hooks: &EngineHooks) -> Result<super::super::scope::OperationScope, String> {
    super::super::scope::prepare_operation_scope_with_hooks(req, None, hooks)
}

#[test]
fn inconsistent_legacy_evidence_never_grants_replacement() {
    for case in ["missing-registration", "receipt-digest", "registered-version", "uninstall-command", "config-id",
        "asar-version", "uninstaller-digest", "uninstaller-protocol", "program-architecture", "receipt-location",
        "portable-marker", "partial-new-proof", "partial-new-receipt", "invalid-config"] {
        let root = temporary_root(case);
        let (req, hooks) = legacy_install(&root);
        let install = Path::new(&req.install_dir);
        let key = hooks.registration_key.as_ref().unwrap();
        match case {
            "missing-registration" => cleanup_registry_key(key),
            "receipt-digest" | "registered-version" | "uninstall-command" => {
                let name = match case { "receipt-digest" => "InstallReceiptSha256", "registered-version" => "DisplayVersion", _ => "UninstallString" };
                create_registry_key(key).unwrap().set_value(name, &"unmatched-value").unwrap();
            },
            "config-id" | "invalid-config" => {
                let value = if case == "config-id" { b"{\"schemaVersion\":2,\"installationId\":\"other\"}".as_slice() } else { b"[" };
                fs::write(install.join("install-config.json"), value).unwrap();
            },
            "asar-version" => fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(
                &product::edition().package_name, Some("9.9.9"), b"other-version")).unwrap(),
            "uninstaller-digest" => fs::write(install.join("uninstall.exe"), pe_fixture(0x77)).unwrap(),
            "uninstaller-protocol" => {
                let mut value: serde_json::Value = serde_json::from_slice(&fs::read(install.join("uninstall-manifest.json")).unwrap()).unwrap();
                value["protocolVersion"] = 3.into();
                fs::write(install.join("uninstall-manifest.json"), serde_json::to_vec(&value).unwrap()).unwrap();
            },
            "program-architecture" => {
                let mut value = fs::read(install.join("SidekickAI.exe")).unwrap();
                let offset = u32::from_le_bytes(value[0x3c..0x40].try_into().unwrap()) as usize;
                value[offset + 4..offset + 6].copy_from_slice(&0xaa64u16.to_le_bytes());
                fs::write(install.join("SidekickAI.exe"), value).unwrap();
            },
            "receipt-location" => {
                let mut value: serde_json::Value = serde_json::from_slice(&fs::read(install.join(product::INSTALL_RECEIPT)).unwrap()).unwrap();
                value["installLocation"] = root.join("other").to_string_lossy().into_owned().into();
                fs::write(install.join(product::INSTALL_RECEIPT), serde_json::to_vec(&value).unwrap()).unwrap();
            },
            "portable-marker" => fs::write(install.join("portable.txt"), b"portable").unwrap(),
            "partial-new-proof" => fs::write(install.join("distribution-proof.json"), b"{}").unwrap(),
            "partial-new-receipt" => {
                fs::create_dir(install.join("maintenance")).unwrap();
                fs::write(install.join("maintenance/distribution-receipt.json"), b"{}").unwrap();
            },
            _ => unreachable!(),
        }
        let before = super::super::validate::directory_digest(install).unwrap();
        assert!(prepare(&req, &hooks).is_err(), "{case} granted replacement");
        assert_eq!(super::super::validate::directory_digest(install).unwrap(), before);
        cleanup_registry_key(key);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn valid_legacy_identity_is_bound_across_save_and_lock_acquisition() {
    let root = temporary_root("legacy-identity-change");
    let (req, hooks) = legacy_install(&root);
    let before = prepare(&req, &hooks).unwrap();
    let path = Path::new(&req.install_dir).join("install-config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["options"]["autoStart"] = true.into();
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    let after = prepare(&req, &hooks).unwrap();
    assert!(super::super::scope::verify_legacy_unchanged(&before, &after).is_err());
    cleanup_registry_key(hooks.registration_key.as_ref().unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_cleanup_target_remains_outside_migration_authority() {
    let root = temporary_root("legacy-cleanup-authority");
    let (mut req, hooks) = legacy_install(&root);
    req.cleanup_paths = vec![req.install_dir.clone()];
    req.install_dir = root.join("new-install").to_string_lossy().into_owned();
    assert!(prepare(&req, &hooks).is_err());
    cleanup_registry_key(hooks.registration_key.as_ref().unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_configuration_changes_after_transaction_prepare_refuse_replacement() {
    for mode in [InstallMode::Repair, InstallMode::Install] {
        let root = temporary_root("legacy-prepared-identity-change");
        let (mut req, mut hooks) = legacy_install(&root);
        req.mode = mode;
        let install = Path::new(&req.install_dir);
        let config_path = install.join("install-config.json");
        let before = super::super::validate::directory_digest(install).unwrap();
        let config_before = fs::read(&config_path).unwrap();
        let key = hooks.registration_key.as_ref().unwrap().clone();
        let registered_before = snapshot_registration(&key).unwrap();
        let payload = root.join("payload");
        write_valid_payload(&payload, 0x55, 0x66);
        hooks.extracted = Some(payload);
        hooks.configuration_change_after_prepare = Some(config_path.clone());
        let result = run_engine(&req, &hooks);
        let registered_after = snapshot_registration(&key).unwrap();
        cleanup_registry_key(&key);
        let error = result.expect_err("Changed legacy identity was accepted after transaction preparation");
        assert!(error.contains("旧安装身份在维护期间发生变化") && error.contains("已恢复"), "{error}");
        assert_eq!(super::super::validate::directory_digest(install).unwrap(), before);
        assert_eq!(fs::read(&config_path).unwrap(), config_before);
        let conflict = fs::read_dir(&root).unwrap().filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with(".sidekick-recovery-conflict")).unwrap().path();
        assert_ne!(fs::read(conflict.join("install-config.json")).unwrap(), config_before);
        assert_eq!(registered_after, registered_before);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn normal_install_preserves_acquired_resources_and_applies_request_configuration() {
    for mixed_case in [false, true] {
        let root = temporary_root("normal-install-acquired-resources");
        let (mut req, mut hooks) = legacy_install(&root);
        let install = PathBuf::from(&req.install_dir);
        if mixed_case {
            fs::rename(install.join("resources"), install.join("resource-case-temporary")).unwrap();
            fs::rename(install.join("resource-case-temporary"), install.join("Resources")).unwrap();
        }
        let cloud = install.join(if mixed_case { "Resources/Cloud" } else { "resources/cloud" });
        fs::create_dir_all(cloud.join("nested/empty")).unwrap();
        fs::write(cloud.join("nested/retained.bin"), b"previously acquired resource").unwrap();
        let retained = cloud.join("nested/retained.bin");
        let mut permissions = fs::metadata(&retained).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&retained, permissions).unwrap();
        let cloud_before = super::super::validate::directory_digest(&cloud).unwrap();
        fs::create_dir_all(install.join("data")).unwrap();
        fs::write(install.join("data/retained.bin"), b"retained user data").unwrap();
        fs::write(install.join("data.restore.json"), b"retained data sidecar").unwrap();
        let before = super::super::validate::directory_digest(&install).unwrap();
        let key = hooks.registration_key.as_ref().unwrap().clone();
        let registration = snapshot_registration(&key).unwrap();
        let payload = root.join("payload");
        write_valid_payload(&payload, 0x55, 0x66);
        req.mode = InstallMode::Install;
        req.options.insert("autoLaunch".into(), true.into());
        hooks.extracted = Some(payload);
        let mut failing = hooks.clone();
        failing.fail_after_registration = true;
        let error = run_engine(&req, &failing).unwrap_err();
        assert!(error.contains("已恢复"), "{error}");
        assert_eq!(super::super::validate::directory_digest(&install).unwrap(), before);
        assert_eq!(snapshot_registration(&key).unwrap(), registration);
        for generation in ["normal-install-generation", "normal-reinstall-generation"] {
            req.installation_id = generation.into();
            let retained = install.join("resources/cloud/nested/retained.bin");
            let mut permissions = fs::metadata(&retained).unwrap().permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&retained, permissions).unwrap();
            run_with(&req, &hooks).unwrap();
            let current = install.join("resources/cloud");
            assert!(current.is_dir(), "Previously acquired resources disappeared after normal installation");
            assert_eq!(super::super::validate::directory_digest(&current).unwrap(), cloud_before);
            assert!(current.join("nested/empty").is_dir());
            assert!(fs::metadata(current.join("nested/retained.bin")).unwrap().permissions().readonly());
            assert_eq!(fs::read(install.join("data/retained.bin")).unwrap(), b"retained user data");
            assert_eq!(fs::read(install.join("data.restore.json")).unwrap(), b"retained data sidecar");
            let config: serde_json::Value = serde_json::from_slice(&fs::read(install.join("install-config.json")).unwrap()).unwrap();
            assert_eq!(config["installationId"], generation);
            assert_eq!(config["options"]["autoLaunch"], true);
            assert_eq!(product::read_install_receipt(&install).unwrap().0.installation_id, generation);
            sidekickai_uninstall_core::distribution::verify_installed_identity(&install).unwrap();
            assert!(stray_staging_dirs(&install).is_empty());
        }
        cleanup_registry_key(&key);
        super::super::payload::clear_readonly_attributes(&root);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn normal_install_resource_destination_conflict_restores_original_installation() {
    let root = temporary_root("normal-install-resource-conflict");
    let (mut req, mut hooks) = legacy_install(&root);
    let install = PathBuf::from(&req.install_dir);
    fs::create_dir_all(install.join("resources/cloud")).unwrap();
    fs::write(install.join("resources/cloud/retained.bin"), b"retained acquisition").unwrap();
    let before = super::super::validate::directory_digest(&install).unwrap();
    let key = hooks.registration_key.as_ref().unwrap().clone();
    let registration = snapshot_registration(&key).unwrap();
    let payload = root.join("payload");
    write_valid_payload(&payload, 0x55, 0x66);
    fs::create_dir_all(payload.join("resources/cloud")).unwrap();
    req.mode = InstallMode::Install;
    hooks.extracted = Some(payload);
    let error = run_engine(&req, &hooks).expect_err("An occupied resource destination replaced acquired content");
    assert!(error.contains("已获取资源目录存在冲突") && error.contains("已恢复"), "{error}");
    assert_eq!(super::super::validate::directory_digest(&install).unwrap(), before);
    assert_eq!(snapshot_registration(&key).unwrap(), registration);
    cleanup_registry_key(&key);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_repair_preserves_configuration_through_fixture_registration() {
    let root = temporary_root("legacy-repair-new-identity");
    let (mut req, mut hooks) = legacy_install(&root);
    let install = Path::new(&req.install_dir);
    let config = fs::read(install.join("install-config.json")).unwrap();
    let original_id = product::read_install_receipt(install).unwrap().0.installation_id;
    fs::create_dir(install.join("data")).unwrap();
    fs::write(install.join("data/personal.bin"), b"retained-personal-data").unwrap();
    let payload = root.join("payload");
    write_valid_payload(&payload, 0x55, 0x66);
    hooks.extracted = Some(payload.clone());
    run_with(&req, &hooks).unwrap();
    let current = sidekickai_uninstall_core::distribution::verify_installed_identity(install).unwrap();
    assert_eq!(current.body.product_version, product_version());
    assert_eq!(product::read_install_receipt(install).unwrap().0.installation_id, original_id);
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
    assert_eq!(fs::read(install.join("data/personal.bin")).unwrap(), b"retained-personal-data");
    assert!(prepare(&req, &hooks).unwrap().legacy_identity.is_none());
    run_with(&req, &hooks).unwrap();
    assert_eq!(fs::read(install.join("install-config.json")).unwrap(), config);
    cleanup_registry_key(hooks.registration_key.as_ref().unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_transaction_failures_restore_exact_original_identity_and_registration() {
    for failure in ["receipt", "registration", "startup"] {
        let root = temporary_root("legacy-transaction-rollback");
        let (mut req, mut hooks) = legacy_install(&root);
        let install = Path::new(&req.install_dir);
        let before = super::super::validate::directory_digest(install).unwrap();
        let key = hooks.registration_key.as_ref().unwrap().clone();
        let registered = snapshot_registration(&key).unwrap();
        let payload = root.join("payload");
        write_valid_payload(&payload, 0x55, 0x66);
        hooks.extracted = Some(payload);
        hooks.fail_after_receipt = failure == "receipt";
        hooks.fail_after_registration = failure == "registration";
        hooks.fail_startup_maintenance = failure == "startup";
        if failure == "registration" { req.mode = InstallMode::Install; }
        let error = run_engine(&req, &hooks).unwrap_err();
        let cause = match failure { "receipt" => "receipt registration interrupted", "registration" => "注入的安装后置失败", _ => "管理员启动任务校验失败" };
        assert!(error.contains(cause), "{failure}: {error}");
        assert!(error.contains("已恢复"), "{failure}: {error}");
        assert_eq!(super::super::validate::directory_digest(install).unwrap(), before, "{failure}");
        assert_eq!(snapshot_registration(&key).unwrap(), registered, "{failure}");
        assert!(prepare(&req, &hooks).unwrap().legacy_identity.is_some());
        cleanup_registry_key(&key);
        fs::remove_dir_all(root).unwrap();
    }
}
fn legacy_install(root: &Path) -> (InstallRequest, EngineHooks) {
    let install = root.join("install");
    write_valid_installed_payload(&install, 0x31, 0x41);
    fs::remove_file(install.join("distribution-proof.json")).unwrap();
    fs::remove_dir_all(install.join("maintenance")).unwrap();
    let version = "0.1.6";
    fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(
        &product::edition().package_name, Some(version), b"registered-legacy-program")).unwrap();
    let (mut receipt, _) = product::read_install_receipt(&install).unwrap();
    receipt.version = version.into();
    let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
    fs::write(install.join(product::INSTALL_RECEIPT), &receipt_bytes).unwrap();
    let mut req = request(&install, false);
    req.mode = InstallMode::Repair;
    req.installation_id = receipt.installation_id;
    write_install_config(&req, &install).unwrap();
    let executable = fs::read(install.join("uninstall.exe")).unwrap();
    let mut metadata = manifest_for(&executable);
    metadata.protocol_version = 2;
    metadata.component_version = "1.0.0".into();
    metadata.product_version = version.into();
    metadata.uninstall_protocol_version = Some(1);
    write_pair(&install, &executable, &metadata);
    let key = format!("HKCU\\Software\\SidekickAI-Legacy-Migration-{}", root.file_name().unwrap().to_string_lossy());
    let registered = create_registry_key(&key).unwrap();
    for (name, value) in [("InstallLocation", install.to_string_lossy().to_string()), ("DisplayVersion", version.into()),
        ("Edition", product::edition_id().into()), ("InstallReceiptSha256", product::receipt_digest(&receipt_bytes)),
        ("UninstallString", format!("\"{}\" --uninstall", install.join("uninstall.exe").display()))] {
        registered.set_value(name, &value).unwrap();
    }
    drop(registered);
    let mut hooks = isolated_hooks(root);
    hooks.registration_key = Some(key);
    (req, hooks)
}

#[test]
fn valid_registered_legacy_target_can_prepare_upgrade() {
    let root = temporary_root("registered-legacy-upgrade");
    let (req, hooks) = legacy_install(&root);
    let result = super::super::scope::prepare_operation_scope_with_hooks(&req, None, &hooks);
    cleanup_registry_key(hooks.registration_key.as_ref().unwrap());
    assert!(result.is_ok(), "registered legacy installation was rejected: {result:?}");
    fs::remove_dir_all(root).unwrap();
}
