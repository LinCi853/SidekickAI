use super::*;
use crate::execute::worker::tests::{fixture_data_root, fixture_request};
use crate::execute::worker::types::WorkerTarget;
use sidekickai_uninstall_core::scan::FileFingerprint;

#[path = "../../../../../test-fixtures.rs"]
mod edition_fixtures;

struct Fixture { root: PathBuf, install: PathBuf, data: PathBuf, request: WorkerRequest }
impl Fixture {
    fn new(strategy: DataStrategy, nested: bool) -> Self {
        let root = std::env::temp_dir().join(format!("uninstall-transaction-{}", super::super::prepare::random_nonce().unwrap()));
        let install = root.join("application");
        let data = if nested { install.join("data") } else { root.join("profile") };
        fs::create_dir_all(install.join("resources")).unwrap(); fs::create_dir_all(&data).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"fixture executable").unwrap();
        fs::write(install.join("uninstall.exe"), b"fixture uninstaller").unwrap();
        fs::write(install.join("resources/app.asar"), edition_fixtures::app_archive(b"fixture application")).unwrap();
        fs::write(data.join("settings.db"), b"original data").unwrap();
        let request = fixture_request(&format!("transaction-{}", super::super::prepare::random_nonce().unwrap()), strategy.clone(),
            vec![WorkerTarget { path: install.to_string_lossy().into_owned(), scope: InstallScope::PerUser,
                fingerprint: edition_fixtures::installed_fingerprint(&install).unwrap(), registered_roots: vec![] }],
            if strategy == DataStrategy::Keep { vec![] } else { vec![fixture_data_root(&data)] }, None);
        Self { root, install, data, request }
    }
    fn journal(&self) -> Journal {
        let targets = super::super::deletion::resolve_worker_targets(&self.request).unwrap();
        let data = self.request.data_roots.iter().map(|root| (root, normalize_target_path(&root.path).unwrap())).collect::<Vec<_>>();
        prepare(&self.request, &targets, &data).unwrap()
    }
    fn outcome(&self) -> WorkerOutcome {
        WorkerOutcome { protocol_version: UNINSTALL_PROTOCOL_VERSION, operation_id: self.request.operation_id.clone(), nonce: self.request.nonce.clone(),
            removed_install_paths: vec![], removed_data_roots: vec![], partially_removed_paths: vec![], warnings: vec![], error: None }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(self.root.is_absolute() && self.root.file_name().unwrap().to_string_lossy().starts_with("uninstall-transaction-"));
        let _ = fs::remove_dir_all(&self.root);
        if let Ok(path) = task_directory(&self.request.request_id) { let _ = fs::remove_dir_all(path); }
    }
}

#[test]
fn nested_data_is_isolated_once_and_restored_with_parent() {
    let fixture = Fixture::new(DataStrategy::Delete, true);
    let mut journal = fixture.journal();
    assert_eq!(journal.roots.len(), 1);
    let root = &journal.roots[0];
    rename_pinned(&root.original, &root.isolated, &root.identity).unwrap();
    assert!(!fixture.install.exists());
    assert_eq!(fs::read(root.isolated.join("data/settings.db")).unwrap(), b"original data");
    rollback(&mut journal).unwrap();
    assert_eq!(fs::read(fixture.data.join("settings.db")).unwrap(), b"original data");
    assert!(fixture.install.join("resources/app.asar").is_file());
}

#[test]
fn durable_intent_recovers_rename_without_completed_marker() {
    let fixture = Fixture::new(DataStrategy::Delete, false);
    let mut journal = fixture.journal();
    journal.state = State::Isolating; save(&journal).unwrap();
    let root = &journal.roots[0];
    rename_pinned(&root.original, &root.isolated, &root.identity).unwrap();
    drop(journal);
    let mut recovered = load(&fixture.request.request_id).unwrap();
    assert!(!recovered.roots[0].moved);
    rollback(&mut recovered).unwrap();
    assert_eq!(recovered.state, State::RolledBack);
    assert!(fixture.install.join("SidekickAI.exe").exists());
    assert_eq!(fs::read(fixture.data.join("settings.db")).unwrap(), b"original data");
}

#[test]
fn registration_failure_restores_all_isolated_roots() {
    let fixture = Fixture::new(DataStrategy::Delete, false);
    let targets = super::super::deletion::resolve_worker_targets(&fixture.request).unwrap();
    let data = fixture.request.data_roots.iter().map(|root| (root, normalize_target_path(&root.path).unwrap())).collect::<Vec<_>>();
    let mut outcome = fixture.outcome();
    let error = execute(&fixture.request, &targets, &data, &mut outcome, &mut |_| Err("injected registration failure".into())).unwrap_err();
    assert!(error.message.contains("injected registration failure"));
    assert!(outcome.removed_install_paths.is_empty()); assert!(outcome.removed_data_roots.is_empty());
    assert!(fixture.install.join("SidekickAI.exe").is_file());
    assert_eq!(fs::read(fixture.data.join("settings.db")).unwrap(), b"original data");
    assert_eq!(load(&fixture.request.request_id).unwrap().state, State::RolledBack);
}

#[test]
fn restoration_conflict_keeps_both_original_bytes_and_new_directory() {
    let fixture = Fixture::new(DataStrategy::Keep, false);
    let mut journal = fixture.journal();
    let root = &journal.roots[0];
    rename_pinned(&root.original, &root.isolated, &root.identity).unwrap();
    fs::create_dir(&fixture.install).unwrap(); fs::write(fixture.install.join("external.txt"), b"external change").unwrap();
    assert!(rollback(&mut journal).is_err());
    assert_eq!(journal.state, State::RecoveryRequired);
    assert_eq!(fs::read(fixture.install.join("external.txt")).unwrap(), b"external change");
    assert!(journal.roots[0].isolated.join("SidekickAI.exe").is_file());
}

#[test]
fn completed_commit_is_discoverable_without_application_markers() {
    let fixture = Fixture::new(DataStrategy::Delete, true);
    let mut journal = fixture.journal();
    for root in &journal.roots { rename_pinned(&root.original, &root.isolated, &root.identity).unwrap(); }
    journal.state = State::Committed; save(&journal).unwrap();
    assert!(!fixture.install.exists());
    assert!(discover().unwrap().iter().any(|task| task.task_id == fixture.request.request_id));
    let mut outcome = fixture.outcome();
    cleanup(&mut journal, &mut outcome).unwrap();
    assert_eq!(journal.state, State::Completed);
    assert_eq!(outcome.removed_install_paths, vec![fixture.install.to_string_lossy().to_string()]);
    assert!(!discover().unwrap().iter().any(|task| task.task_id == fixture.request.request_id));
}

#[test]
fn keep_local_data_moves_only_program_entries() {
    let fixture = Fixture::new(DataStrategy::Keep, true);
    fs::write(fixture.install.join("data.restore.json"), b"pending restore metadata").unwrap();
    let mut request = fixture.request.clone();
    request.targets[0].fingerprint = edition_fixtures::installed_fingerprint(&fixture.install).unwrap();
    let targets = super::super::deletion::resolve_worker_targets(&request).unwrap();
    let mut outcome = fixture.outcome();
    execute(&request, &targets, &[], &mut outcome, &mut |_| Ok(())).unwrap();
    assert_eq!(fs::read(fixture.data.join("settings.db")).unwrap(), b"original data");
    assert_eq!(fs::read(fixture.install.join("data.restore.json")).unwrap(), b"pending restore metadata");
    assert!(!fixture.install.join("SidekickAI.exe").exists());
    assert!(outcome.removed_data_roots.is_empty());
}

#[cfg(windows)]
#[test]
fn locked_residual_is_retained_and_cleanup_retries_same_task() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let fixture = Fixture::new(DataStrategy::Delete, true);
    let mut journal = fixture.journal();
    let root = &journal.roots[0];
    rename_pinned(&root.original, &root.isolated, &root.identity).unwrap();
    let locked = fs::OpenOptions::new().read(true).share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
        .open(root.isolated.join("data/settings.db")).unwrap();
    journal.state = State::Committed; save(&journal).unwrap();
    let mut outcome = fixture.outcome();
    cleanup(&mut journal, &mut outcome).unwrap();
    assert_eq!(journal.state, State::Cleaning);
    assert!(outcome.warnings.iter().any(|warning| warning.starts_with("CLEANUP_PENDING:")));
    drop(locked);
    let mut recovered = load(&fixture.request.request_id).unwrap();
    cleanup(&mut recovered, &mut fixture.outcome()).unwrap();
    assert_eq!(recovered.state, State::Completed);
}

#[test]
fn replaced_quarantine_container_is_never_cleaned() {
    let fixture = Fixture::new(DataStrategy::Keep, false);
    let journal = fixture.journal();
    let container = &journal.roots[0].container;
    let saved = container.with_extension("old");
    fs::rename(container, &saved).unwrap(); fs::create_dir(container).unwrap();
    fs::write(container.join("sentinel"), b"unrelated").unwrap();
    assert!(load(&fixture.request.request_id).is_err());
    assert_eq!(fs::read(container.join("sentinel")).unwrap(), b"unrelated");
}

#[test]
fn completed_history_does_not_require_old_parent_directories() {
    let fixture = Fixture::new(DataStrategy::Delete, true);
    let mut journal = fixture.journal();
    for root in &journal.roots { rename_pinned(&root.original, &root.isolated, &root.identity).unwrap(); }
    journal.state = State::Committed; save(&journal).unwrap();
    cleanup(&mut journal, &mut fixture.outcome()).unwrap();
    fs::remove_dir(&fixture.root).unwrap();
    assert!(discover().unwrap().is_empty());
}
