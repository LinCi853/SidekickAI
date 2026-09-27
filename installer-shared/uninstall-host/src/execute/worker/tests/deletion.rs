#[cfg(test)]
#[path = "../../../../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
// Deletion and backup-binding tests.

use super::*;

    /// End-to-end deletion against an isolated fixture root: the confirmed
    /// installation is removed, while an unselected sibling installation and a
    /// sentinel inside it stay byte-for-byte intact.
    #[test]
    fn worker_removes_only_the_confirmed_target_in_an_isolated_root() {
        for selected_id in ["concept", "community"] {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let confirmed = root.join("SidekickAI");
        let unselected = root.join("SidekickAI-other");
        for directory in [&confirmed, &unselected] {
            fs::create_dir_all(directory.join("resources")).unwrap();
            fs::write(directory.join("SidekickAI.exe"), b"fixture executable").unwrap();
            fs::write(directory.join("resources").join("app.asar"), app_archive(b"fixture asar")).unwrap();
            fs::write(directory.join("uninstall.exe"), b"fixture uninstaller").unwrap();
        }
        let product = sidekickai_uninstall_core::product::product();
        fs::write(confirmed.join("resources/app.asar"), edition_fixtures::archive_for(&product.editions[selected_id].package_name, b"selected edition")).unwrap();
        let foreign_name = if selected_id == "concept" { "sidekick-ai" } else { "sidekickai-opensource" };
        fs::write(unselected.join("resources/app.asar"), edition_fixtures::archive_for(foreign_name, b"foreign edition")).unwrap();
        fs::write(unselected.join("sentinel.txt"), b"must survive").unwrap();

        // Never allow a recursive delete outside the isolated fixture root.
        assert!(root.is_absolute());
        assert!(confirmed.starts_with(&root) && unselected.starts_with(&root));

        let fingerprint = FileFingerprint::from_path(&confirmed).unwrap();
        let operation = create_operation_dir("e2e-fixture").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "e2e-fixture",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: confirmed.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(execute_worker_with(&request_path, &worker).unwrap());

        assert!(!confirmed.exists(), "confirmed installation should be removed");
        assert!(unselected.join("sentinel.txt").is_file(), "unselected installation must survive");
        assert_eq!(fs::read(unselected.join("sentinel.txt")).unwrap(), b"must survive");

        let outcome = read_outcome(&operation, &nonce, "e2e-fixture").unwrap();
        assert!(outcome.error.is_none());
        assert_eq!(outcome.removed_install_paths.len(), 1);
        assert!(outcome.removed_data_roots.is_empty());
        assert!(outcome.warnings.iter().any(|w| w == "USER_DATA_PRESERVED"));

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn keep_request_refuses_in_place_data_even_without_a_portable_marker() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("install");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::create_dir_all(install.join("data")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"fixture executable").unwrap();
        fs::write(install.join("resources/app.asar"), app_archive(b"fixture")).unwrap();
        fs::write(install.join("uninstall.exe"), b"fixture uninstaller").unwrap();
        fs::write(install.join("data/settings.db"), b"retained user data").unwrap();
        let operation = create_operation_dir("keep-local-data").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request("keep-local-data", DataStrategy::Keep, vec![WorkerTarget {
            path: install.to_string_lossy().into_owned(), scope: InstallScope::PerUser,
            fingerprint: FileFingerprint::from_path(&install).unwrap(), registered_roots: vec![],
        }], vec![], None);
        let request_path = write_fixture_request(&operation, &request);
        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        let outcome = read_outcome(&operation, &request.nonce, "keep-local-data").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetScopeInvalid);
        assert!(outcome.removed_install_paths.is_empty());
        assert_eq!(fs::read(install.join("data/settings.db")).unwrap(), b"retained user data");
        assert!(install.join("SidekickAI.exe").is_file());
        cleanup_directory(&operation);
        fs::remove_dir_all(root).unwrap();
    }

    /// A target whose core files changed after scanning must abort before any
    /// deletion, leaving the whole fixture intact.
    #[test]
    fn worker_aborts_when_the_target_changed_after_scanning() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"original").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"original")).unwrap();
        fs::write(target.join("uninstall.exe"), b"original").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();
        // The installation is modified between scanning and execution.
        fs::write(target.join("SidekickAI.exe"), b"tampered payload").unwrap();

        let operation = create_operation_dir("changed-fixture").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "changed-fixture",
            DataStrategy::Delete,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());

        assert!(target.is_dir(), "changed target must not be deleted");
        assert!(target.join("SidekickAI.exe").is_file());
        let outcome = read_outcome(&operation, &nonce, "changed-fixture").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(outcome.removed_install_paths.is_empty());
        assert!(outcome.removed_data_roots.is_empty());

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// All scopes are validated before the first deletion. A data root that
    /// changed after preparation aborts the run and the installation survives
    /// even though data deletion is attempted first.
    #[test]
    fn worker_revalidates_data_roots_before_deleting_anything() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        let data = root.join("SidekickAI-data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"settings").unwrap();

        let install_fingerprint = FileFingerprint::from_path(&install).unwrap();
        // Capture the strong identity before the change.
        let data_root = fixture_data_root(&data);
        // The data root changes after the controller captured its identity: a new
        // entry changes the directory modification time and the tree digest.
        fs::write(data.join("added-after-preparation.db"), b"new data").unwrap();

        let operation = create_operation_dir("data-changed").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "data-changed",
            DataStrategy::Delete,
            vec![WorkerTarget {
                path: install.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint: install_fingerprint,
                registered_roots: Vec::new(),
            }],
            vec![data_root],
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(install.is_dir(), "the installation must survive a changed data root");
        assert!(data.join("settings.db").is_file(), "the data root must survive");
        let outcome = read_outcome(&operation, &nonce, "data-changed").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(outcome.removed_install_paths.is_empty());
        assert!(outcome.removed_data_roots.is_empty());

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// A data root that contains the installation would remove it as a side
    /// effect; the request is refused before anything is deleted.
    #[test]
    fn worker_rejects_a_data_root_that_contains_the_installation() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();

        let install_fingerprint = FileFingerprint::from_path(&install).unwrap();

        let operation = create_operation_dir("dangerous-ancestor").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "dangerous-ancestor",
            DataStrategy::Delete,
            vec![WorkerTarget {
                path: install.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint: install_fingerprint,
                registered_roots: Vec::new(),
            }],
            vec![fixture_data_root(&root)],
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(root.is_dir() && install.is_dir(), "an overlapping scope must abort before deletion");
        let outcome = read_outcome(&operation, &nonce, "dangerous-ancestor").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetIsParent);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// A failure while removing a later target must keep the paths that were
    /// already removed instead of reporting an empty, side-effect-free failure.
    #[test]
    fn worker_preserves_already_removed_paths_when_a_later_target_fails() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let first = root.join("SidekickAI-first");
        let second = root.join("SidekickAI-second");
        for directory in [&first, &second] {
            fs::create_dir_all(directory.join("resources")).unwrap();
            fs::write(directory.join("SidekickAI.exe"), b"exe").unwrap();
            fs::write(directory.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
            fs::write(directory.join("uninstall.exe"), b"uninstaller").unwrap();
        }
        fs::write(second.join("locked.txt"), b"locked").unwrap();
        let first_fingerprint = FileFingerprint::from_path(&first).unwrap();
        let second_fingerprint = FileFingerprint::from_path(&second).unwrap();

        let operation = create_operation_dir("partial-failure").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "partial-failure",
            DataStrategy::Delete,
            vec![
                WorkerTarget {
                    path: first.to_string_lossy().into_owned(),
                    scope: InstallScope::PerUser,
                    fingerprint: first_fingerprint,
                    registered_roots: Vec::new(),
                },
                WorkerTarget {
                    path: second.to_string_lossy().into_owned(),
                    scope: InstallScope::PerUser,
                    fingerprint: second_fingerprint,
                    registered_roots: Vec::new(),
                },
            ],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        // Hold the file without FILE_SHARE_DELETE so the second target cannot be
        // removed while the first one is. Rust's default share mode allows
        // deletion, so the share mode must be narrowed explicitly.
        use std::os::windows::fs::OpenOptionsExt;
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(second.join("locked.txt"))
            .unwrap();
        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        drop(locked);

        assert!(!first.exists(), "the first target should have been removed");
        assert!(second.is_dir(), "the locked target must survive");
        let outcome = read_outcome(&operation, &nonce, "partial-failure").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::DeleteFailed);
        assert_eq!(outcome.removed_install_paths.len(), 1, "the already-removed path must be reported");
        assert!(outcome.removed_install_paths[0].ends_with("SidekickAI-first"));
        // A partial scope must be called out, never presented as a clean failure.
        let details = outcome.error.as_ref().unwrap().details.as_ref().unwrap();
        assert!(details.contains_key("removedEntries"), "the partial count must be reported: {details:?}");
        assert!(details.contains_key("partiallyRemovedPath"));
        if details.get("removedEntries") != Some(&DetailValue::Number(0)) {
            assert!(
                outcome.partially_removed_paths.iter().any(|path| path.ends_with("SidekickAI-second")),
                "a partially removed scope must be listed: {:?}",
                outcome.partially_removed_paths
            );
            assert!(outcome.warnings.iter().any(|warning| warning.starts_with("PARTIALLY_REMOVED")));
        }

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// A request that names an unknown registry root must be refused before any
    /// deletion; only HKCU and HKLM may drive registry cleanup.
    #[test]
    fn worker_rejects_unknown_registry_roots_before_deleting() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(target.join("uninstall.exe"), b"uninstaller").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("bad-root").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "bad-root",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: vec!["HKCR".into()],
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.is_dir(), "an unknown registry root must not cause deletion");
        let outcome = read_outcome(&operation, &nonce, "bad-root").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::InvalidRequest);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// Alternate-admin elevation runs the worker as another account. The worker
    /// must refuse the request before touching a single target.
    #[test]
    fn worker_refuses_a_different_user_identity_before_deleting() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(target.join("uninstall.exe"), b"uninstaller").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("other-user").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let mut request = fixture_request(
            "other-user",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        request.caller_user_sid = "S-1-5-21-0000000000-0000000000-0000000000-5000".into();
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.is_dir(), "a different user identity must not delete the target");
        let outcome = read_outcome(&operation, &nonce, "other-user").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::ElevationFailed);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// A request whose controller process is gone cannot be trusted and must not
    /// authorize deletion.
    #[test]
    fn worker_refuses_a_request_from_a_dead_controller() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(target.join("uninstall.exe"), b"uninstaller").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("dead-controller").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let mut request = fixture_request(
            "dead-controller",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        request.controller_pid = spawn_and_reap_process();
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.is_dir(), "a dead controller must not authorize deletion");
        let outcome = read_outcome(&operation, &nonce, "dead-controller").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::Internal);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// The worker holds the worker-role lock for the whole deletion, so an
    /// installer that already owns it blocks the run before any deletion.
    #[test]
    fn worker_is_blocked_while_another_worker_role_lock_is_held() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(target.join("uninstall.exe"), b"uninstaller").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("lock-held").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "lock-held",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        let held = PathLocks::acquire(&[target.clone()], "worker").unwrap();
        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        drop(held);

        assert!(target.is_dir(), "a held worker lock must prevent deletion");
        let outcome = read_outcome(&operation, &nonce, "lock-held").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::AlreadyRunning);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// The handle-pinned remover must delete a nested tree completely (every
    /// child is opened and dispositioned through its own pinned handle).
    #[cfg(windows)]
    #[test]
    fn tree_removal_deletes_a_nested_tree() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let scope = root.join("SidekickAI");
        fs::create_dir_all(scope.join("resources").join("nested")).unwrap();
        fs::write(scope.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(scope.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(scope.join("resources").join("nested").join("deep.bin"), b"deep").unwrap();
        let identity = DirectoryIdentity::from_path(&scope).unwrap();
        remove_tree_pinned(&scope, &identity).unwrap();
        assert!(!scope.exists(), "the nested tree must be fully removed");
        let _ = fs::remove_dir_all(&root);
    }

    /// A child that is a reparse point must stop the removal instead of being
    /// followed; the outside directory keeps its bytes.
    #[cfg(windows)]
    #[test]
    fn tree_removal_refuses_a_reparse_child() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let scope = root.join("SidekickAI");
        let outside = root.join("outside");
        fs::create_dir_all(&scope).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(scope.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(outside.join("precious.txt"), b"keep me").unwrap();
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, scope.join("linked")) {
            eprintln!("notice: cannot create symlink fixture: {error}; reparse test skipped");
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let identity = DirectoryIdentity::from_path(&scope).unwrap();
        let failure = remove_tree_pinned(&scope, &identity).unwrap_err();
        assert_eq!(failure.path, scope.join("linked"));
        assert!(scope.is_dir());
        assert_eq!(fs::read(outside.join("precious.txt")).unwrap(), b"keep me");
        let _ = fs::remove_dir_all(&root);
    }

    /// A request whose recorded worker hash does not match the running image must
    /// be refused before any deletion.
    #[test]
    fn worker_rejects_a_swapped_worker_image() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        fs::create_dir_all(target.join("resources")).unwrap();
        fs::write(target.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(target.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(target.join("uninstall.exe"), b"uninstaller").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("swapped-image").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let mut request = fixture_request(
            "swapped-image",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        request.worker_sha256 = "0".repeat(64);
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.is_dir(), "a swapped worker image must not delete the target");
        let outcome = read_outcome(&operation, &nonce, "swapped-image").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::InvalidRequest);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// The worker must refuse a data root whose directory object was replaced
    /// after the controller captured its identity, even when the tree matches.
    #[cfg(windows)]
    #[test]
    fn worker_detects_a_replaced_data_root() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        let data = root.join("SidekickAI-data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"settings").unwrap();
        let install_fingerprint = FileFingerprint::from_path(&install).unwrap();
        let data_root = fixture_data_root(&data);

        // Replace the directory object at the same path with identical bytes.
        fs::remove_dir_all(&data).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"settings").unwrap();

        let operation = create_operation_dir("replaced-data").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "replaced-data",
            DataStrategy::Delete,
            vec![WorkerTarget {
                path: install.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint: install_fingerprint,
                registered_roots: Vec::new(),
            }],
            vec![data_root],
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(install.is_dir(), "the installation must survive a replaced data root");
        let outcome = read_outcome(&operation, &nonce, "replaced-data").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// A portable installation keeps its data root *inside* the installation
    /// directory. Pinning the installation as an ancestor of its own data root
    /// used to keep the root pending (a read-only alias handle), so the install
    /// removal was reported as a partial failure and no portable deletion could
    /// complete. External ancestors only, and data first, must remove both
    /// scopes in one run.
    #[cfg(windows)]
    #[test]
    fn portable_install_with_in_place_data_is_removed_in_one_run() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI-Portable");
        let data = install.join("data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("portable.txt"), b"portable").unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"portable data").unwrap();

        let install_fingerprint = FileFingerprint::from_path(&install).unwrap();
        let operation = create_operation_dir("portable-e2e").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "portable-e2e",
            DataStrategy::Delete,
            vec![WorkerTarget {
                path: install.to_string_lossy().into_owned(),
                scope: InstallScope::Portable,
                fingerprint: install_fingerprint,
                registered_roots: Vec::new(),
            }],
            vec![fixture_data_root(&data)],
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(execute_worker_with(&request_path, &worker).unwrap());
        assert!(!data.exists(), "the in-place portable data root must be removed");
        assert!(!install.exists(), "the portable installation must be removed");
        let outcome = read_outcome(&operation, &nonce, "portable-e2e").unwrap();
        assert!(outcome.error.is_none(), "worker reported: {:?}", outcome.error);
        assert_eq!(outcome.removed_data_roots.len(), 1);
        assert_eq!(outcome.removed_install_paths.len(), 1);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// Ancestors are opened from the volume root downward, and an ancestor that
    /// grants `DELETE` access is held without delete sharing, which is what
    /// actually blocks a rename of that directory (a read-only handle does not).
    #[cfg(windows)]
    #[test]
    fn ancestor_pins_are_root_first_and_block_a_rename() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let scope = root.join("SidekickAI");
        fs::create_dir_all(&scope).unwrap();

        let pins = pin_external_ancestors(&[scope.clone()]).unwrap();
        assert!(pins.len() >= 2, "expected the whole ancestor chain to be pinned");
        for pair in pins.windows(2) {
            assert!(
                path_is_same_or_descendant(&pair[1].path, &pair[0].path),
                "ancestors must be pinned root-first: {:?}",
                pins.iter().map(|pin| &pin.path).collect::<Vec<_>>()
            );
        }
        // The scope's own parent is deletable by this user, so it is pinned with
        // DELETE access and the directory cannot be renamed (which is what a
        // junction/reparse swap would need).
        assert!(pins.iter().any(|pin| paths_equal(&pin.path, &root)), "the immediate parent must be pinned");
        let renamed = root.parent().unwrap().join(format!("{}-renamed", root.file_name().unwrap().to_string_lossy()));
        assert!(fs::rename(&root, &renamed).is_err(), "a DELETE-pinned ancestor must not be renameable");
        drop(pins);
        fs::rename(&root, &renamed).unwrap();
        let _ = fs::remove_dir_all(&renamed);
    }

    /// A reparse point anywhere in the ancestor chain is refused instead of being
    /// followed, matching the no-reparse rule the deletion path enforces.
    #[cfg(windows)]
    #[test]
    fn ancestor_pinning_refuses_a_reparse_ancestor() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, &link) {
            eprintln!("notice: cannot create symlink fixture: {error}; ancestor reparse test skipped");
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let error = match pin_external_ancestors(&[link.join("SidekickAI")]) {
            Err(error) => error,
            Ok(_) => panic!("a reparse ancestor must be refused"),
        };
        assert_eq!(error.code, UninstallErrorCode::UnsafePath);
        assert!(outside.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    /// The worker must use the controller-captured directory identity and never
    /// the identity of whatever currently sits at the path. A real rename swap
    /// (original directory moved away, an identical directory created at the same
    /// path so every fingerprint field matches) is refused.
    #[cfg(windows)]
    #[test]
    fn worker_refuses_a_target_swapped_by_a_rename_after_preparation() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("SidekickAI");
        let write_install = |path: &Path| {
            fs::create_dir_all(path.join("resources")).unwrap();
            fs::write(path.join("SidekickAI.exe"), b"exe").unwrap();
            fs::write(path.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
            fs::write(path.join("uninstall.exe"), b"uninstaller").unwrap();
        };
        write_install(&target);
        // The controller captures the directory object before the swap.
        let controller_identity = DirectoryIdentity::from_path(&target).unwrap();

        let operation = create_operation_dir("rename-swap").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "rename-swap",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint: FileFingerprint::from_path(&target).unwrap(),
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );

        // Move the original away and recreate an identical tree at the same path,
        // then bind the request to the controller's original capture.
        let moved = root.join("SidekickAI-moved");
        fs::rename(&target, &moved).unwrap();
        write_install(&target);
        let mut request = request;
        request.targets[0].fingerprint = FileFingerprint::from_path(&target).unwrap();
        request.target_identities[0].directory = controller_identity;

        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.is_dir(), "the replacement directory must survive");
        assert!(moved.is_dir(), "the original directory must survive");
        let outcome = read_outcome(&operation, &nonce, "rename-swap").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(outcome.removed_install_paths.is_empty());

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// The worker refuses a protected system root before it walks or deletes
    /// anything: a matching fingerprint alone proves nothing about the directory.
    #[cfg(windows)]
    #[test]
    fn worker_refuses_a_protected_system_root_before_deleting() {
        let Some(system_root) = std::env::var_os("SystemRoot") else {
            eprintln!("notice: SystemRoot unavailable; protected root test skipped");
            return;
        };
        let target = PathBuf::from(system_root);
        let fingerprint = FileFingerprint::from_path(&target).unwrap();
        let operation = create_operation_dir("protected-root").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "protected-root",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        let outcome = read_outcome(&operation, &nonce, "protected-root").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetScopeInvalid);
        assert!(target.is_dir(), "the OS directory must still exist");

        cleanup_directory(&operation);
    }

    /// An arbitrary directory is not an installation: the worker requires the
    /// same `resources\app.asar` + `uninstall.exe` markers the scan requires.
    #[test]
    fn worker_refuses_a_target_without_installation_markers() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let target = root.join("Not-An-Install");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("notes.txt"), b"arbitrary data").unwrap();
        let fingerprint = FileFingerprint::from_path(&target).unwrap();

        let operation = create_operation_dir("not-an-install").unwrap();
        let worker = operation.join("worker.exe");
        fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
        let request = fixture_request(
            "not-an-install",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: target.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );
        let request_path = write_fixture_request(&operation, &request);
        let nonce = request.nonce.clone();

        assert!(!execute_worker_with(&request_path, &worker).unwrap());
        assert!(target.join("notes.txt").is_file(), "a non-installation must survive");
        let outcome = read_outcome(&operation, &nonce, "not-an-install").unwrap();
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetNotInstall);

        cleanup_directory(&operation);
        let _ = fs::remove_dir_all(&root);
    }

    /// The verified preparation binds the raw archive hash and the selected
    /// source inventory, revalidates both before capturing the snapshot, and
    /// refuses an archive or source that changed after the backup.
    #[cfg(windows)]
    #[test]
    fn verified_prepare_binds_the_archive_and_selected_source_bytes() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        let data = root.join("SidekickAI-data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"backup bytes").unwrap();
        let archive = root.join("backup.zip");
        fs::write(&archive, b"synthetic verified archive bytes").unwrap();

        let proof = BackupProof {
            path: archive.to_string_lossy().into_owned(),
            root: data.to_string_lossy().into_owned(),
            entry_hashes: BTreeMap::from([("settings.db".to_string(), sha256_file(&data.join("settings.db")).unwrap())]),
            archive_sha256: sha256_file(&archive).unwrap(),
            tree_sha256: export_tree_digest(&data).unwrap(),
        };
        let targets = vec![WorkerTarget {
            path: install.to_string_lossy().into_owned(),
            scope: InstallScope::PerUser,
            fingerprint: FileFingerprint::from_path(&install).unwrap(),
            registered_roots: Vec::new(),
        }];
        let data_roots = vec![data.to_string_lossy().into_owned()];
        let prepare = || {
            prepare_worker_from_verified(
                &std::env::current_exe().unwrap(),
                "verified-prepare",
                "verified-prepare-request",
                &DataStrategy::Export,
                &targets,
                &data_roots,
                Some(&proof.path),
                &proof,
            )
        };

        let (directory, request_path, _nonce) = prepare().unwrap();
        let request: WorkerRequest = serde_json::from_slice(&fs::read(&request_path).unwrap()).unwrap();
        assert_eq!(request.backup_sha256.as_deref(), Some(proof.archive_sha256.as_str()));
        assert_eq!(request.data_roots[0].verified_source_hashes, proof.entry_hashes);
        assert_eq!(request.data_roots[0].verified_tree_sha256.as_deref(), Some(proof.tree_sha256.as_str()));
        assert_eq!(request.target_identities.len(), 1);
        cleanup_directory(&directory);

        // A swapped archive is refused before any snapshot is captured.
        fs::write(&archive, b"a different archive").unwrap();
        assert_eq!(prepare().unwrap_err().code, UninstallErrorCode::BackupIncomplete);

        // A selected source that changed after the backup is refused too.
        fs::write(&archive, b"synthetic verified archive bytes").unwrap();
        fs::write(data.join("settings.db"), b"changed after backup").unwrap();
        assert_eq!(prepare().unwrap_err().code, UninstallErrorCode::TargetChanged);

        // Regression: a file added to a selected directory after the export is
        // not in `entry_hashes`, so only the complete exporter-time tree digest
        // can refuse it. Nothing is prepared for deletion.
        fs::write(data.join("settings.db"), b"backup bytes").unwrap();
        fs::create_dir_all(data.join("notes-assets")).unwrap();
        fs::write(data.join("notes-assets").join("late.txt"), b"late arrival").unwrap();
        assert_eq!(prepare().unwrap_err().code, UninstallErrorCode::TargetChanged);
        assert!(data.join("notes-assets").join("late.txt").is_file(), "the added file must survive");
        assert!(install.join("SidekickAI.exe").is_file(), "the installation must survive");

        let _ = fs::remove_dir_all(&root);
    }

    /// The worker revalidates the verified source inventory: a data root whose
    /// snapshot was captured *after* the backup (so its tree identity matches the
    /// live tree) is still refused when a selected source no longer matches the
    /// bytes the backup carried, and is also refused when the complete
    /// exporter-time tree digest no longer matches.
    #[cfg(windows)]
    #[test]
    fn worker_revalidates_the_verified_backup_binding() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        let data = root.join("SidekickAI-data");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("uninstall.exe"), b"uninstaller").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"v1").unwrap();
        let backup_hash = sha256_file(&data.join("settings.db")).unwrap();
        let archive = root.join("backup.zip");
        fs::write(&archive, b"verified archive").unwrap();
        let archive_sha = sha256_file(&archive).unwrap();
        let install_fingerprint = FileFingerprint::from_path(&install).unwrap();

        let run = |operation_id: &str, data_root: WorkerDataRoot| {
            let operation = create_operation_dir(operation_id).unwrap();
            let worker = operation.join("worker.exe");
            fs::copy(std::env::current_exe().unwrap(), &worker).unwrap();
            let mut request = fixture_request(
                operation_id,
                DataStrategy::Export,
                vec![WorkerTarget {
                    path: install.to_string_lossy().into_owned(),
                    scope: InstallScope::PerUser,
                    fingerprint: install_fingerprint.clone(),
                    registered_roots: Vec::new(),
                }],
                vec![data_root],
                Some(archive.to_string_lossy().into_owned()),
            );
            request.backup_sha256 = Some(archive_sha.clone());
            let request_path = write_fixture_request(&operation, &request);
            let nonce = request.nonce.clone();
            let succeeded = execute_worker_with(&request_path, &worker).unwrap();
            let outcome = read_outcome(&operation, &nonce, operation_id).unwrap();
            cleanup_directory(&operation);
            (succeeded, outcome)
        };

        // The snapshot is captured from the live tree, but the backup carried the
        // older bytes: the identity check passes and the source-hash binding is
        // what refuses the deletion.
        fs::write(data.join("settings.db"), b"v2 (post-backup)").unwrap();
        let changed_root = fixture_verified_data_root(&data, &[("settings.db".to_string(), backup_hash.clone())]);
        let (succeeded, outcome) = run("verified-binding-changed", changed_root);
        assert!(!succeeded, "a changed selected source must refuse the deletion");
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(data.join("settings.db").is_file(), "the data root must survive");
        assert!(install.join("SidekickAI.exe").is_file(), "the installation must survive");

        // Regression: a file added after the export snapshot is absent from the
        // selected-source inventory and from the directory identity captured
        // later, so only the exact exporter-time complete-tree digest can refuse
        // it. The worker must refuse before deleting anything.
        let good_hash = sha256_file(&data.join("settings.db")).unwrap();
        let exporter_tree = export_tree_digest(&data).unwrap();
        fs::write(data.join("late-added.txt"), b"late arrival after the export snapshot").unwrap();
        let mut added_root = fixture_verified_data_root(&data, &[("settings.db".to_string(), good_hash.clone())]);
        // The captured directory identity and the source hashes describe the live
        // (post-addition) tree; only the exporter-time digest is stale.
        added_root.verified_tree_sha256 = Some(exporter_tree);
        let (succeeded, outcome) = run("verified-binding-added", added_root);
        assert!(!succeeded, "a file added after the export snapshot must refuse the deletion");
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(data.join("late-added.txt").is_file(), "the added file must survive");
        assert!(install.join("SidekickAI.exe").is_file(), "the installation must survive");
        fs::remove_file(data.join("late-added.txt")).unwrap();

        // With the live bytes matching the backup, the export deletion proceeds.
        let good_root = fixture_verified_data_root(&data, &[("settings.db".to_string(), good_hash)]);
        let (succeeded, outcome) = run("verified-binding-good", good_root);
        assert!(succeeded, "worker reported: {:?}", outcome.error);
        assert!(outcome.error.is_none());
        assert!(!data.exists(), "the verified data root must be removed");
        assert!(!install.exists(), "the installation must be removed");

        let _ = fs::remove_dir_all(&root);
    }

    /// The cross-language tree digest must match the shared golden fixture the
    /// Node exporter test also materializes: same Unicode names, empty directory
    /// and real file bytes, same SHA-256.
    #[test]
    fn export_tree_digest_matches_the_shared_node_golden_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(
            include_str!("../../../../../uninstall-core/tests/fixtures/export-tree-digest.json"),
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!("export-tree-golden-{}", random_nonce().unwrap()));
        fs::create_dir_all(&root).unwrap();
        for directory in fixture["directories"].as_array().unwrap() {
            fs::create_dir_all(root.join(directory.as_str().unwrap())).unwrap();
        }
        for file in fixture["files"].as_array().unwrap() {
            let path = root.join(file["path"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let hex = file["contentHex"].as_str().unwrap();
            let bytes: Vec<u8> = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            fs::write(&path, bytes).unwrap();
        }
        assert_eq!(
            export_tree_digest(&root).unwrap(),
            fixture["digest"].as_str().unwrap(),
            "the Rust digest must equal the shared Node/Rust golden fixture"
        );
        // A single added file must change the digest: that change is the binding
        // that refuses a snapshot captured after the export.
        let before = export_tree_digest(&root).unwrap();
        fs::write(root.join("late.txt"), b"late arrival").unwrap();
        assert_ne!(export_tree_digest(&root).unwrap(), before);
        let _ = fs::remove_dir_all(&root);
    }
