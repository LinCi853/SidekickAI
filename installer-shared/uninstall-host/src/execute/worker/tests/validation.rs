//! Request validation and identity tests.

use super::*;

    #[test]
    fn worker_requests_are_not_accepted_outside_the_private_root() {
        let stray = std::env::temp_dir().join("sidekick-stray-worker-request.json");
        let worker = std::env::temp_dir().join("sidekick-stray-worker.exe");
        assert!(validate_request_location_for(&stray, &worker).is_err());
    }

    #[test]
    fn worker_requests_are_rejected_when_the_executable_is_not_the_relocated_copy() {
        let directory = create_operation_dir("wrong-exe-test").unwrap();
        let request = directory.join("request.json");
        write_atomic(&request, b"{}").unwrap();
        let worker = directory.join("worker.exe");
        fs::write(&worker, b"worker image").unwrap();
        // A genuine worker path inside the operation directory is accepted...
        assert!(validate_request_location_for(&request, &worker).is_ok());
        // ...but any other executable, including the controller, is not.
        assert!(validate_request_location_for(&request, &std::env::temp_dir().join("controller.exe")).is_err());
        // ...and a missing request or worker file is not a valid location either.
        assert!(validate_request_location_for(&directory.join("other.json"), &worker).is_err());
        assert!(validate_request_location_for(&request, &directory.join("missing.exe")).is_err());
        cleanup_directory(&directory);
    }

    /// The production worker must accept a request that lives under an explicit
    /// non-default operation root (which is what the process tests and the
    /// standalone CLI use); the root is never re-derived or overridden.
    #[test]
    fn request_location_accepts_a_non_default_operation_root() {
        let root = std::env::temp_dir().join(format!("sidekick-custom-root-{}", random_nonce().unwrap()));
        let directory = root.join(format!("custom-op-{}", "a".repeat(REQUEST_NONCE_LEN)));
        fs::create_dir_all(&directory).unwrap();
        let request = directory.join("request.json");
        write_atomic(&request, b"{}").unwrap();
        fs::write(directory.join("worker.exe"), b"worker image").unwrap();
        assert!(validate_request_location_for(&request, &directory.join("worker.exe")).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn worker_request_round_trips_without_a_password() {
        let directory = create_operation_dir("test-operation").unwrap();
        let request = fixture_request(
            "test-operation",
            DataStrategy::Export,
            Vec::new(),
            Vec::new(),
            Some("C:\\backup.zip".into()),
        );
        let bytes = serde_json::to_vec(&request).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(!text.to_lowercase().contains("password"));
        write_atomic(&directory.join("request.json"), &bytes).unwrap();
        let parsed: WorkerRequest = serde_json::from_slice(&fs::read(directory.join("request.json")).unwrap()).unwrap();
        assert_eq!(parsed.operation_id, "test-operation");
        assert_eq!(parsed.backup_path.as_deref(), Some("C:\\backup.zip"));
        assert!(directory.parent().unwrap().file_name().unwrap().to_string_lossy().contains("SidekickAI-Uninstall"));
        cleanup_directory(&directory);
    }

    /// `registered_roots` must survive the request round trip as a list.
    #[test]
    fn worker_target_round_trips_registered_roots() {
        let directory = create_operation_dir("roots-round-trip").unwrap();
        let fingerprint = FileFingerprint {
            exists: true,
            is_directory: true,
            len: 0,
            modified: None,
            core_files: Vec::new(),
        };
        let request = fixture_request(
            "roots-round-trip",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: r"C:\Apps\SidekickAI".into(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: vec!["HKCU".into(), "HKLM".into()],
            }],
            Vec::new(),
            None,
        );
        let bytes = serde_json::to_vec(&request).unwrap();
        write_atomic(&directory.join("request.json"), &bytes).unwrap();
        let parsed: WorkerRequest = serde_json::from_slice(&fs::read(directory.join("request.json")).unwrap()).unwrap();
        assert_eq!(parsed.targets[0].registered_roots, vec!["HKCU".to_string(), "HKLM".to_string()]);
        cleanup_directory(&directory);
    }

    /// Malformed requests are refused before any identity check or deletion.
    #[test]
    fn worker_rejects_malformed_requests() {
        let base = || fixture_request(
            "malformed",
            DataStrategy::Keep,
            vec![WorkerTarget {
                path: r"C:\Apps\SidekickAI".into(),
                scope: InstallScope::PerUser,
                fingerprint: FileFingerprint { exists: true, is_directory: true, len: 0, modified: None, core_files: Vec::new() },
                registered_roots: Vec::new(),
            }],
            Vec::new(),
            None,
        );

        let mut short_nonce = base();
        short_nonce.nonce = "abcd".into();
        assert_eq!(validate_worker_request(&short_nonce).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut no_targets = base();
        no_targets.targets.clear();
        assert_eq!(validate_worker_request(&no_targets).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut keep_with_data = base();
        keep_with_data.data_roots.push(WorkerDataRoot {
            path: r"C:\Data".into(),
            fingerprint: FileFingerprint { exists: true, is_directory: true, len: 0, modified: None, core_files: Vec::new() },
            identity: DataRootIdentity {
                directory: DirectoryIdentity { volume_serial: 0, file_index_high: 0, file_index_low: 0 },
                tree_sha256: "a".repeat(64),
            },
            verified_source_hashes: BTreeMap::new(),
            verified_tree_sha256: None,
        });
        assert_eq!(validate_worker_request(&keep_with_data).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut bad_worker_hash = base();
        bad_worker_hash.worker_sha256 = "not-a-hash".into();
        assert_eq!(validate_worker_request(&bad_worker_hash).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut bad_tree_hash = base();
        bad_tree_hash.data_roots.push(WorkerDataRoot {
            path: r"C:\Data".into(),
            fingerprint: FileFingerprint { exists: true, is_directory: true, len: 0, modified: None, core_files: Vec::new() },
            identity: DataRootIdentity {
                directory: DirectoryIdentity { volume_serial: 0, file_index_high: 0, file_index_low: 0 },
                tree_sha256: "short".into(),
            },
            verified_source_hashes: BTreeMap::new(),
            verified_tree_sha256: None,
        });
        bad_tree_hash.strategy = DataStrategy::Delete;
        assert_eq!(validate_worker_request(&bad_tree_hash).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut export_without_backup = base();
        export_without_backup.strategy = DataStrategy::Export;
        assert_eq!(validate_worker_request(&export_without_backup).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut export_without_archive_hash = base();
        export_without_archive_hash.strategy = DataStrategy::Export;
        export_without_archive_hash.backup_path = Some(r"C:\backup.zip".into());
        assert_eq!(validate_worker_request(&export_without_archive_hash).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        // A target without its controller-captured directory identity is refused.
        let mut missing_target_identity = base();
        missing_target_identity.target_identities.clear();
        assert_eq!(validate_worker_request(&missing_target_identity).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut bad_source_entry = base();
        bad_source_entry.strategy = DataStrategy::Delete;
        bad_source_entry.data_roots.push(WorkerDataRoot {
            path: r"C:\Data".into(),
            fingerprint: FileFingerprint { exists: true, is_directory: true, len: 0, modified: None, core_files: Vec::new() },
            identity: DataRootIdentity {
                directory: DirectoryIdentity { volume_serial: 0, file_index_high: 0, file_index_low: 0 },
                tree_sha256: "a".repeat(64),
            },
            verified_source_hashes: BTreeMap::from([(r"..\outside.db".to_string(), "a".repeat(64))]),
            verified_tree_sha256: None,
        });
        assert_eq!(validate_worker_request(&bad_source_entry).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut bad_operation_id = base();
        bad_operation_id.operation_id = r"op\escape".into();
        assert_eq!(validate_worker_request(&bad_operation_id).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        assert!(validate_worker_request(&base()).is_ok());
    }

    #[test]
    fn outcome_must_match_the_operation_identity() {
        let directory = create_operation_dir("identity-test").unwrap();
        let outcome = WorkerOutcome {
            protocol_version: UNINSTALL_PROTOCOL_VERSION, operation_id: "identity-test".into(), nonce: "aa".into(),
            removed_install_paths: vec![], removed_data_roots: vec![], partially_removed_paths: vec![],
            warnings: vec![], error: None,
        };
        write_atomic(&directory.join("result.json"), &serde_json::to_vec(&outcome).unwrap()).unwrap();
        assert!(read_outcome(&directory, "aa", "identity-test").is_ok());
        assert!(read_outcome(&directory, "bb", "identity-test").is_err());
        assert!(read_outcome(&directory, "aa", "other-operation").is_err());
        cleanup_directory(&directory);
    }

    /// The private operation directory must have a protected DACL with exactly
    /// the current user, SYSTEM and Administrators ACEs, so another interactive
    /// account cannot read the request or replace the result.
    #[cfg(windows)]
    #[test]
    fn operation_directory_has_a_protected_private_dacl() {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED,
        };
        let directory = create_operation_dir("acl-test").unwrap();
        let wide: Vec<u16> = directory.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let result = GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            );
            assert_eq!(result.0, 0, "GetNamedSecurityInfoW failed: {}", result.0);
            let mut control = 0u16;
            let mut revision = 0u32;
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision).unwrap();
            assert_ne!(
                control & SE_DACL_PROTECTED.0,
                0,
                "the operation-directory DACL must replace inheritance"
            );
            assert!(!dacl.is_null(), "the operation directory must carry an explicit DACL");
            assert_eq!((*dacl).AceCount, 3, "expected exactly the user, SYSTEM and Administrators ACEs");
            let _ = LocalFree(HLOCAL(descriptor.0));
        }
        cleanup_directory(&directory);
    }

    /// Strong data-root identity: an in-place content overwrite (which does not
    /// change the directory mtime) and a whole-directory replacement are both
    /// detected.
    #[test]
    fn data_root_identity_detects_content_change_and_replacement() {
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let data = root.join("SidekickAI-data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("settings.db"), b"settings").unwrap();
        let identity = DataRootIdentity::capture(&data).unwrap();
        assert!(identity.verify(&data).is_ok());

        // Overwriting an existing file keeps the directory metadata but must
        // change the tree digest.
        fs::write(data.join("settings.db"), b"settings-changed").unwrap();
        assert!(identity.verify(&data).is_err(), "an in-place content change must be detected");

        // Replacing the directory object with byte-identical content must still be
        // detected through the volume/file-id binding.
        #[cfg(windows)]
        {
            fs::remove_dir_all(&data).unwrap();
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("settings.db"), b"settings-changed").unwrap();
            assert!(identity.verify(&data).is_err(), "a replaced directory object must be detected");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// Protected OS/user/temp roots are refused independently of the request,
    /// while an ordinary installation below a protected root stays removable.
    #[cfg(windows)]
    #[test]
    fn protected_scopes_reject_roots_and_their_ancestors() {
        let user = PathBuf::from(r"C:\Users\Alice");
        let temp = user.join("AppData").join("Local").join("Temp");
        let operation = temp.join("SidekickAI-Uninstall-test");
        let roots = vec![user.clone(), temp.clone(), operation.clone()];
        let system = PathBuf::from(r"C:\Windows");
        let reason = |path: &Path| protected_scope_reason_for(path, &roots, Some(&system), &operation);

        assert!(reason(&user).is_some(), "a user profile root must be refused");
        assert!(reason(&temp).is_some(), "a temp root must be refused");
        assert!(reason(&Path::new(r"C:\Users")).is_some(), "an ancestor of a protected root must be refused");
        assert!(reason(&system).is_some(), "the OS directory must be refused");
        assert!(reason(&system.join("System32")).is_some(), "a path inside the OS directory must be refused");
        assert!(reason(&operation.join("op-1")).is_some(), "the private operation area must be refused");
        assert!(reason(&user.join("AppData").join("Local").join("Programs").join("SidekickAI")).is_none());
        assert!(reason(&Path::new(r"C:\Program Files\SidekickAI")).is_none());
    }

    /// An export deletion without the controller-verified proof is refused
    /// before any relocation or snapshot capture.
    #[test]
    fn export_preparation_requires_a_verified_proof() {
        let error = prepare_worker_from(
            &std::env::current_exe().unwrap(),
            "no-proof",
            "no-proof-request",
            &DataStrategy::Export,
            &[],
            &[],
            Some(r"C:\backup.zip"),
        )
        .unwrap_err();
        assert_eq!(error.code, UninstallErrorCode::InvalidRequest);

        // A proof on a non-export strategy is refused through the verified entry
        // point; a `Delete` cannot smuggle in backup permission.
        let proof = BackupProof {
            path: r"C:\backup.zip".into(),
            root: r"C:\data".into(),
            entry_hashes: BTreeMap::from([("settings.db".to_string(), "a".repeat(64))]),
            archive_sha256: "b".repeat(64),
            tree_sha256: "c".repeat(64),
        };
        let error = prepare_worker_from_verified(
            &std::env::current_exe().unwrap(),
            "proof-on-delete",
            "proof-on-delete-request",
            &DataStrategy::Delete,
            &[],
            &[],
            None,
            &proof,
        )
        .unwrap_err();
        assert_eq!(error.code, UninstallErrorCode::InvalidRequest);
    }
