use super::*;
use sidekickai_uninstall_core::scan::TargetIdentity;
use sidekickai_uninstall_core::ScannedTarget;
use sha2::Digest;

#[path = "../../test-fixtures.rs"]
mod edition_fixtures;

struct Fixture {
    directory: ExportDirectory,
    plan: plan::Plan,
    selection: BackupSelection,
    output: PathBuf,
    sentinel: PathBuf,
}

impl Fixture {
    fn new(edition: &str, legacy_success: bool) -> Self {
        let directory = ExportDirectory(execute::create_operation_dir("offline-export-fixture").unwrap());
        let install = directory.0.join("installed");
        let source = directory.0.join("data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(install.join("resources/app.asar"), edition_fixtures::archive_for_version(
            &sidekickai_uninstall_core::product::product().editions[edition].package_name, Some("0.9.42"), b"offline installation",
        )).unwrap();
        fs::write(install.join("uninstall.exe"), b"fixture maintenance entry").unwrap();
        if legacy_success { fs::write(install.join("SidekickAI.exe"), b"signed original application").unwrap(); }
        write_signed_runtime(&install,edition);
        edition_fixtures::seal_installation(&install);
        let status = Command::new("node").arg("--no-warnings").arg("-e")
            .arg(r#"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE module_state(id TEXT PRIMARY KEY);INSERT INTO app_settings VALUES('fixture','retained')");db.close()"#)
            .arg(source.join("settings.db")).status().unwrap();
        assert!(status.success());
        let output = directory.0.join("backup.zip");
        let sentinel = directory.0.join("untrusted-application-ran.txt");
        if legacy_success {
            let source_file = directory.0.join("legacy_export.rs");
            fs::write(&source_file, format!("fn main() {{ std::fs::write({:?}, b\"untrusted application executed\").unwrap(); }}", sentinel)).unwrap();
            let result = Command::new("rustc").arg("--crate-name").arg("legacy_export_fixture")
                .arg(&source_file).arg("-o").arg(install.join("SidekickAI.exe")).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        }
        let id = UninstallTargetId { token: "offline-fixture-target".into() };
        let location = UninstallLocation {
            id: id.clone(), edition: edition.into(), path: install.to_string_lossy().into_owned(), display_path: install.to_string_lossy().into_owned(),
            source: vec![UninstallEntry::Installed], scope: InstallScope::PerUser, arch: UninstallArch::X64, version: Some("0.9.42".into()),
            registered: false, registered_roots: vec![], executable_present: legacy_success, resources_present: true,
            identity_confidence: IdentityConfidence::Strong, running_pids: vec![], removable: true, non_removable_reason: None, recommended: true,
        };
        let target = ScannedTarget { identity: TargetIdentity::from_location(&location).unwrap(), id: id.clone() };
        let selection = BackupSelection { format: BackupFormat::Zip, output_path: output.to_string_lossy().into_owned(), encrypt: false,
            password: None, categories: vec!["basicData".into()], staging_path: Some(directory.0.join("staging").to_string_lossy().into_owned()) };
        let backup = sidekickai_uninstall_core::validate_backup_selection(&selection, &[target.identity.path.clone()]).unwrap();
        let plan = plan::Plan { targets: vec![target], data_roots: vec![DataRoot { path: source.to_string_lossy().into_owned(), source: "fixture".into(),
            removable: true, associated_target_ids: vec![id] }], backup: Some(backup) };
        Self { directory, plan, selection, output, sentinel }
    }

    fn export(&self) -> (BackupResult, execute::BackupProof) {
        export_root(&self.plan, &self.plan.data_roots[0], &self.selection, &self.output, &self.directory.0.join("proof.json"), "offline-export-fixture").unwrap()
    }
}

pub(crate) fn test_trust()->serde_json::Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
    let key=ed25519_dalek::SigningKey::from_bytes(&[0x57;32]);
    serde_json::json!({"id":"backup-test-publisher","publicKey":{"kty":"OKP","crv":"Ed25519","x":URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())}})
}

fn signed(payload:serde_json::Value,purpose:&str)->serde_json::Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
    use ed25519_dalek::Signer;
    let key=ed25519_dalek::SigningKey::from_bytes(&[0x57;32]);
    let header=serde_json::json!({"alg":"EdDSA","kid":"backup-test-publisher","typ":purpose});
    let input=format!("{}.{}",URL_SAFE_NO_PAD.encode(sidekickai_uninstall_core::distribution::canonical_bytes(&header).unwrap()),
        URL_SAFE_NO_PAD.encode(sidekickai_uninstall_core::distribution::canonical_bytes(&payload).unwrap()));
    let signature=format!("{input}.{}",URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes()));
    serde_json::json!({"payload":payload,"signature":signature})
}

fn write_signed_runtime(install:&Path,edition:&str) {
    use sidekickai_uninstall_core::distribution as contract;
    use std::io::Read;
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let architecture=sidekickai_uninstall_core::architecture::native_architecture().unwrap();
    let source=root.join(format!("build/backup-runtime/win-{architecture}.zip"));
    assert!(source.is_file(),"Build the independent backup runtime before this integration test");
    fs::create_dir(install.join("maintenance")).unwrap();
    let archive=install.join("maintenance/backup-runtime.zip"); fs::copy(&source,&archive).unwrap();
    let mut zip=zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    let mut files=Vec::new();
    for index in 0..zip.len(){let mut entry=zip.by_index(index).unwrap();let mut digest=sha2::Sha256::new();let mut buffer=[0;65536];
        loop{let count=entry.read(&mut buffer).unwrap();if count==0{break;}digest.update(&buffer[..count]);}
        files.push(serde_json::json!({"path":entry.name(),"sizeBytes":entry.size(),"sha256":format!("{:x}",digest.finalize()),
            "executableArchitecture":if entry.name()=="node.exe" {Some(architecture)} else {None}}));}
    let archive_digest=contract::sha256_file(&archive).unwrap(); let archive_size=fs::metadata(&archive).unwrap().len();
    let runtime=signed(serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":edition,"componentId":"backup-runtime",
        "componentVersion":"1.0.0","nativeArchitecture":architecture,"archive":{"sha256":archive_digest,"sizeBytes":archive_size},"files":files,
        "exportProtocolVersion":1,"recoveryProtocolVersion":1,"entrypoints":{"export":"export.mjs","restore":"sidekick-backup.cjs"}}),contract::RUNTIME_PROOF_TYPE);
    fs::write(install.join("maintenance/runtime-proof.json"),serde_json::to_vec(&runtime).unwrap()).unwrap();
    let mut inventory=Vec::new(); let mut total=0;
    for path in ["maintenance/backup-runtime.zip","maintenance/runtime-proof.json","resources/app.asar"] {
        let file=install.join(path);let size=fs::metadata(&file).unwrap().len();total+=size;
        inventory.push(serde_json::json!({"path":path,"sizeBytes":size,"sha256":contract::sha256_file(&file).unwrap(),"executableArchitecture":null}));
    }
    let body=signed(serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":edition,"productVersion":"0.9.42","variant":"installed",
        "platform":"windows","nativeArchitectures":[architecture],"maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,
        "archive":{"sha256":"a".repeat(64),"sizeBytes":1,"expandedBytes":total,"fileCount":inventory.len()},"files":inventory,
        "components":[{"componentId":"backup-runtime","componentVersion":"1.0.0","nativeArchitecture":architecture,
            "archivePath":"maintenance/backup-runtime.zip","proofPath":"maintenance/runtime-proof.json","sha256":archive_digest,"sizeBytes":archive_size}]}),contract::BODY_PROOF_TYPE);
    fs::write(install.join("distribution-proof.json"),serde_json::to_vec(&body).unwrap()).unwrap();
}

fn manifest(file: &str) -> serde_json::Value {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    let mut json = String::new();
    zip.by_name("manifest.json").unwrap().read_to_string(&mut json).unwrap();
    serde_json::from_str(&json).unwrap()
}

#[test]
fn damaged_foreign_installation_uses_its_own_backup_edition() {
    let selected = if sidekickai_uninstall_core::product::edition_id() == "community" { "concept" } else { "community" };
    let fixture = Fixture::new(selected, false);
    let before = execute::export_tree_digest(Path::new(&fixture.plan.data_roots[0].path)).unwrap();
    let (result, proof) = fixture.export();
    let manifest = manifest(&result.path);
    assert_eq!(manifest["edition"], selected);
    assert_eq!(manifest["appVersion"], "0.9.42");
    assert_eq!(proof.tree_sha256, before);
    assert_eq!(execute::export_tree_digest(Path::new(&fixture.plan.data_roots[0].path)).unwrap(), before);
    let (cached, cached_proof) = fixture.export();
    assert_eq!(cached.path, result.path);
    assert_eq!(cached_proof.archive_sha256, proof.archive_sha256);
}

#[test]
fn replaced_application_is_not_executed_before_independent_export() {
    let fixture = Fixture::new(sidekickai_uninstall_core::product::edition_id(), true);
    let (result, _) = fixture.export();
    assert!(result.verified);
    assert_eq!(Path::new(&result.path), fixture.output);
    assert!(!fixture.sentinel.exists());
    assert_eq!(manifest(&result.path)["edition"], sidekickai_uninstall_core::product::edition_id());
}

#[test]
fn replaced_application_cannot_receive_the_encrypted_backup_password() {
    let mut fixture = Fixture::new(sidekickai_uninstall_core::product::edition_id(), true);
    fixture.output = fixture.directory.0.join("encrypted.sabackup");
    fixture.selection.output_path = fixture.output.to_string_lossy().into_owned();
    fixture.selection.encrypt = true;
    fixture.selection.format = BackupFormat::Sabackup;
    fixture.selection.password = Some("isolated-backup-password".into());
    let (result, _) = fixture.export();
    assert!(result.verified);
    assert!(!fixture.sentinel.exists());
    let archive = inspect_archive(Path::new(&result.path), Some("isolated-backup-password")).unwrap();
    assert_eq!(archive.edition.as_deref(), Some(sidekickai_uninstall_core::product::edition_id()));
}

#[test]
fn missing_signed_recovery_resources_preserve_the_source_tree() {
    let fixture=Fixture::new(sidekickai_uninstall_core::product::edition_id(),false);
    let source=Path::new(&fixture.plan.data_roots[0].path);
    let before=execute::export_tree_digest(source).unwrap();
    let install=fixture.plan.targets[0].identity.path.as_path();
    fs::remove_file(install.join("distribution-proof.json")).unwrap();
    let result=export_root(&fixture.plan,&fixture.plan.data_roots[0],&fixture.selection,&fixture.output,&fixture.directory.0.join("missing-proof.json"),"missing-proof");
    assert!(result.is_err());
    assert_eq!(execute::export_tree_digest(source).unwrap(),before);
    assert!(!fixture.output.exists());
}

#[cfg(windows)]
#[test]
#[ignore = "Requires a production-signed candidate installed in a new isolated acceptance directory"]
fn actual_candidate_damaged_archive_exports_offline_before_relocated_uninstall() {
    use sidekickai_uninstall_core::distribution as contract;
    use sidekickai_uninstall_core::scan::FileFingerprint;
    use std::os::windows::process::CommandExt;

    let root = PathBuf::from(std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_DIR").expect("acceptance directory"));
    let expected_body = std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_BODY_SHA256").expect("candidate body digest");
    let expected_uninstaller = std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_UNINSTALLER_SHA256").expect("candidate uninstaller digest");
    let candidate_run = std::env::var("SIDEKICK_INSTALLER_ACCEPTANCE_CANDIDATE_RUN").expect("candidate run");
    let local_profile = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("isolated local profile"));
    let job_root = PathBuf::from(std::env::var_os("SIDEKICK_BACKUP_JOB_ROOT").expect("isolated backup job root"));
    assert!(root.is_absolute() && root.is_dir());
    assert!(local_profile.starts_with(&root) && local_profile != root);
    assert!(job_root.starts_with(&root) && job_root != root);
    let install = root.join("fresh");
    let prior: serde_json::Value = serde_json::from_slice(&fs::read(root.join("native-acceptance.json")).unwrap()).unwrap();
    assert_eq!(Path::new(prior["fresh"].as_str().unwrap()), install);
    assert_eq!(prior["bodyProofSha256"].as_str().unwrap(), expected_body);

    let mut production_keys = contract::trusted_keys().unwrap();
    production_keys.as_array_mut().unwrap().retain(|key| !matches!(key["id"].as_str(),
        Some("maintenance-test-publisher" | "backup-test-publisher" | "metadata-test-publisher")));
    let identity = contract::verify_installed_identity_with_keys(&install, &production_keys).unwrap();
    assert_eq!(identity.body.edition, sidekickai_uninstall_core::product::edition_id());
    assert_eq!(identity.receipt.body_proof_sha256, expected_body);
    assert_eq!(identity.receipt.native_architecture, "x64");
    contract::verify_declared_files(&install, &identity.body.files).unwrap();
    let uninstaller = install.join("uninstall.exe");
    assert_eq!(execute::sha256_file(&uninstaller).unwrap(), expected_uninstaller);
    assert_eq!(contract::pe_architecture(&uninstaller).unwrap(), "x64");
    let retained_data = root.join("retained-installation-data");
    let retained_data_digest = if install.join("data").exists() {
        let digest = execute::export_tree_digest(&install.join("data")).unwrap();
        assert!(!retained_data.exists());
        fs::rename(install.join("data"), &retained_data).unwrap();
        Some(digest)
    } else { None };
    let runtime_component = identity.body.components.iter().find(|component| component.native_architecture == "x64").unwrap();
    let runtime_digest = runtime_component.sha256.clone();
    let runtime_proof_digest = execute::sha256_file(&install.join(&runtime_component.proof_path)).unwrap();
    let runtime_check = ExportDirectory(execute::create_operation_dir("candidate-runtime-check").unwrap());
    let pinned = contract::prepare_bound_runtime_with_keys(&install, &runtime_check.0, &identity.body, "x64", &production_keys).unwrap();
    assert_eq!(pinned.descriptor.edition, identity.body.edition);
    drop(pinned);
    drop(runtime_check);

    fs::write(install.join("resources/app.asar"), b"damaged candidate application archive").unwrap();
    contract::verify_installed_identity_with_keys(&install, &production_keys).unwrap();
    assert!(verified_application(&install, &install.join("SidekickAI.exe")).is_err());
    let data = root.join("offline-data");
    assert!(!data.exists());
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&local_profile).unwrap();
    fs::create_dir_all(&job_root).unwrap();
    let created = Command::new("node").arg("--no-warnings").arg("-e")
        .arg(r#"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE module_state(id TEXT PRIMARY KEY);INSERT INTO app_settings VALUES('candidate','retained')");db.close()"#)
        .arg(data.join("settings.db")).creation_flags(0x08000000).status().unwrap();
    assert!(created.success());
    let sentinel = root.join("unselected/sentinel.txt");
    fs::create_dir(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, b"unselected data retained").unwrap();
    let before = execute::export_tree_digest(&data).unwrap();
    let id = UninstallTargetId { token: "actual-candidate-target".into() };
    let location = UninstallLocation {
        id: id.clone(), edition: identity.body.edition.clone(), path: install.to_string_lossy().into_owned(),
        display_path: install.to_string_lossy().into_owned(), source: vec![UninstallEntry::Installed],
        scope: InstallScope::PerUser, arch: UninstallArch::X64, version: Some(identity.body.product_version.clone()),
        registered: false, registered_roots: vec![], executable_present: true, resources_present: true,
        identity_confidence: IdentityConfidence::Strong, running_pids: vec![], removable: true,
        non_removable_reason: None, recommended: true,
    };
    let target = ScannedTarget { identity: TargetIdentity::from_location(&location).unwrap(), id: id.clone() };
    let data_roots = vec![data.to_string_lossy().into_owned()];
    let session = execute::WorkerSession::start(&uninstaller, "actual-candidate-export", "actual-candidate-export-request",
        &[execute::WorkerTarget { path: location.path.clone(), scope: InstallScope::PerUser,
            fingerprint: FileFingerprint::from_path(&install).unwrap(), registered_roots: vec![] }],
        &DataStrategy::Export, &data_roots, false, || false).unwrap();
    assert!(install.join("uninstall.exe").is_file());

    let plain = root.join("offline-backup.zip");
    let mut selection = BackupSelection { format: BackupFormat::Zip, output_path: plain.to_string_lossy().into_owned(),
        encrypt: false, password: None, categories: vec!["basicData".into()],
        staging_path: Some(root.join("backup-staging").to_string_lossy().into_owned()) };
    let backup = sidekickai_uninstall_core::validate_backup_selection(&selection, &[target.identity.path.clone()]).unwrap();
    let plan = plan::Plan { targets: vec![target], data_roots: vec![DataRoot { path: data_roots[0].clone(),
        source: "actual-candidate".into(), removable: true, associated_target_ids: vec![id] }], backup: Some(backup) };
    let (plain_result, plain_proof) = export_root(&plan, &plan.data_roots[0], &selection, &plain,
        &root.join("plain-export-proof.json"), "actual-candidate-plain").unwrap();
    assert!(plain_result.verified);
    assert_eq!(manifest(&plain_result.path)["edition"], identity.body.edition);
    assert_eq!(manifest(&plain_result.path)["appVersion"], identity.body.product_version);
    assert_eq!(plain_proof.tree_sha256, before);
    assert_eq!(execute::export_tree_digest(&data).unwrap(), before);

    let encrypted = root.join("offline-backup.sabackup");
    selection.format = BackupFormat::Sabackup;
    selection.output_path = encrypted.to_string_lossy().into_owned();
    selection.encrypt = true;
    selection.password = Some("actual-candidate-private-password".into());
    let (encrypted_result, encrypted_proof) = export_root(&plan, &plan.data_roots[0], &selection, &encrypted,
        &root.join("encrypted-export-proof.json"), "actual-candidate-encrypted").unwrap();
    assert!(encrypted_result.verified);
    assert!(inspect_archive(Path::new(&encrypted_result.path), Some("wrong-candidate-password")).is_err());
    assert_eq!(inspect_archive(Path::new(&encrypted_result.path), selection.password.as_deref()).unwrap().edition.as_deref(),
        Some(identity.body.edition.as_str()));
    assert_eq!(encrypted_proof.tree_sha256, before);
    assert_eq!(execute::export_tree_digest(&data).unwrap(), before);
    let encrypted_digest = encrypted_proof.archive_sha256.clone();
    let outcome = session.commit_all(&DataStrategy::Export, &data_roots, &[encrypted_proof]).unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.removed_install_paths, vec![install.to_string_lossy().into_owned()]);
    assert_eq!(outcome.removed_data_roots, data_roots);
    assert!(!install.exists() && !data.exists());
    if let Some(digest) = &retained_data_digest {
        assert_eq!(&execute::export_tree_digest(&retained_data).unwrap(), digest);
    }
    assert_eq!(fs::read(&sentinel).unwrap(), b"unselected data retained");
    assert_eq!(execute::sha256_file(Path::new(&plain_result.path)).unwrap(), plain_proof.archive_sha256);
    assert_eq!(execute::sha256_file(Path::new(&encrypted_result.path)).unwrap(), encrypted_digest);
    inspect_archive(Path::new(&encrypted_result.path), selection.password.as_deref()).unwrap();
    fs::write(root.join("native-maintenance-acceptance.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "passed": true, "edition": identity.body.edition, "version": identity.body.product_version,
        "candidateRun": candidate_run, "x64BodyProofSha256": expected_body,
        "uninstallerSha256": expected_uninstaller, "runtimeArchiveSha256": runtime_digest,
        "runtimeProofFileSha256": runtime_proof_digest, "plainBackupSha256": plain_proof.archive_sha256,
        "encryptedBackupSha256": encrypted_digest, "sourceTreeSha256": before,
        "damagedAsarUsesIndependentRuntime": true, "privateStdinPassword": true,
        "relocatedUninstallerRemovesConfirmedProgramAndData": true, "unselectedDataPreserved": true,
        "retainedMigratedDataSha256": retained_data_digest,
        "limitations": ["No application UI launch", "No interactive UAC", "No ARM64 hardware", "No public service deployment"]
    })).unwrap()).unwrap();
}
