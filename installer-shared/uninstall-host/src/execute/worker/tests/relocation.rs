#[cfg(test)]
#[path = "../../../../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
// Relocation and UI-handoff tests.

use super::*;

    #[test]
    fn relocation_bootstrap_outside_the_private_root_is_rejected() {
        let stray = std::env::temp_dir().join("sidekick-relocation-stray.json");
        let _ = fs::write(&stray, b"{}");
        assert!(read_relocation_bootstrap(&stray).is_err());
        let _ = fs::remove_file(&stray);
    }

    #[test]
    fn relocation_bootstrap_rejects_malformed_or_wrong_protocol_files() {
        let directory = create_operation_dir("relocation-invalid").unwrap();
        let path = directory.join("bootstrap.json");
        write_atomic(&path, b"not json").unwrap();
        assert!(read_relocation_bootstrap(&path).is_err());

        let wrong_protocol = serde_json::json!({ "protocolVersion": 2, "nonce": "0".repeat(32), "sourceExe": r"C:\Apps\SidekickAI\uninstall.exe", "sourceSha256": "a".repeat(64) });
        write_atomic(&path, wrong_protocol.to_string().as_bytes()).unwrap();
        assert!(read_relocation_bootstrap(&path).is_err());

        // A nonce that is the right length but not hexadecimal is refused.
        let bad_nonce = serde_json::json!({ "protocolVersion": 1, "nonce": "z".repeat(32), "sourceExe": r"C:\Apps\SidekickAI\uninstall.exe", "sourceSha256": "a".repeat(64) });
        write_atomic(&path, bad_nonce.to_string().as_bytes()).unwrap();
        assert!(read_relocation_bootstrap(&path).is_err());

        // A well-formed bootstrap is still refused because this process is not
        // the relocated copy it describes.
        let valid = serde_json::json!({ "protocolVersion": 1, "nonce": "a".repeat(32), "sourceExe": r"C:\Apps\SidekickAI\uninstall.exe", "sourceSha256": "b".repeat(64) });
        write_atomic(&path, valid.to_string().as_bytes()).unwrap();
        assert!(read_relocation_bootstrap(&path).is_err());
        cleanup_directory(&directory);
    }

    /// Preparation for the relocated UI must produce an identical copy plus a
    /// valid bootstrap; the copy is what keeps the installation directory from
    /// being locked by the running launcher.
    #[test]
    fn ui_relocation_produces_a_verified_copy_and_bootstrap() {
        let (relocated, bootstrap, nonce) = relocate_ui().unwrap();
        assert!(relocated.is_file());
        assert_eq!(sha256_file(&relocated).unwrap(), sha256_file(&std::env::current_exe().unwrap()).unwrap());
        assert_eq!(nonce.len(), 32);
        let parsed: RelocationBootstrap = serde_json::from_slice(&fs::read(&bootstrap).unwrap()).unwrap();
        assert_eq!(parsed.protocol_version, UNINSTALL_PROTOCOL_VERSION);
        assert_eq!(parsed.nonce, nonce);
        assert_eq!(parsed.source_sha256, sha256_file(&relocated).unwrap());
        assert!(Path::new(&parsed.source_exe).is_absolute());
        cleanup_directory(relocated.parent().unwrap());
    }

    /// A launcher still running inside the target locks its own image, so the
    /// deletion must fail honestly instead of reporting a clean removal. This is
    /// exactly why the UI is relocated before an uninstall starts.
    #[test]
    fn a_running_launcher_inside_the_target_blocks_deletion_without_faking_success() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let source = PathBuf::from(&system_root).join("System32").join("ping.exe");
        if !source.is_file() {
            eprintln!("notice: ping.exe unavailable; launcher-lock test skipped");
            return;
        }
        let Some(artifact) = super::standalone_artifact() else {
            return;
        };

        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let install = root.join("SidekickAI");
        fs::create_dir_all(install.join("resources")).unwrap();
        fs::write(install.join("resources").join("app.asar"), app_archive(b"asar")).unwrap();
        fs::write(install.join("SidekickAI.exe"), b"exe").unwrap();
        // The launcher lives inside the installation and is currently running.
        fs::copy(&source, install.join("uninstall.exe")).unwrap();
        let mut launcher = std::process::Command::new(install.join("uninstall.exe"))
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(700));

        let fingerprint = edition_fixtures::installed_fingerprint(&install).unwrap();
        let outcome = run_worker_operation_with(
            &artifact,
            "locked-launcher",
            "locked-launcher-request",
            &DataStrategy::Keep,
            &[WorkerTarget {
                path: install.to_string_lossy().into_owned(),
                scope: InstallScope::PerUser,
                fingerprint,
                registered_roots: Vec::new(),
            }],
            &[],
            None,
            false,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        assert!(outcome.error.is_some(), "a locked launcher must produce a failure, not a silent success");
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::ProcessRunning);
        assert!(outcome.removed_install_paths.is_empty());
        assert!(launcher.try_wait().unwrap().is_none(), "maintenance windows must not be terminated");
        assert!(install.exists(), "the installation cannot vanish while its launcher is running");

        let _ = launcher.kill();
        let _ = launcher.wait();
        std::thread::sleep(Duration::from_millis(400));
        // Once the launcher exits the directory is removable, which is what the
        // relocated UI guarantees.
        fs::remove_dir_all(&install).expect("the installation should be removable after the launcher exits");
        let _ = fs::remove_dir_all(&root);
    }

    /// Abandoned relocation directories are reclaimed, live ones are not. A
    /// relocation only becomes reclaimable after a grace period, so a UI that is
    /// still starting up is never swept.
    #[test]
    fn stale_relocations_are_swept_but_live_ones_are_kept() {
        use std::time::SystemTime;

        let live = create_operation_dir("ui").unwrap();
        let live_bootstrap = RelocationBootstrap {
            protocol_version: UNINSTALL_PROTOCOL_VERSION,
            nonce: "c".repeat(32),
            source_exe: r"C:\Apps\SidekickAI\uninstall.exe".into(),
            source_sha256: "f".repeat(64),
            pid: std::process::id(),
        };
        write_atomic(&live.join("bootstrap.json"), &serde_json::to_vec(&live_bootstrap).unwrap()).unwrap();

        // A freshly written relocation whose owner is dead must survive the grace
        // period: it may be a UI that is about to refresh its own PID.
        let fresh = create_operation_dir("ui").unwrap();
        let dead_pid = spawn_and_reap_process();
        let fresh_bootstrap = RelocationBootstrap {
            protocol_version: UNINSTALL_PROTOCOL_VERSION,
            nonce: "d".repeat(32),
            source_exe: r"C:\Apps\SidekickAI\uninstall.exe".into(),
            source_sha256: "f".repeat(64),
            pid: dead_pid,
        };
        write_atomic(&fresh.join("bootstrap.json"), &serde_json::to_vec(&fresh_bootstrap).unwrap()).unwrap();

        // An abandoned relocation with the same dead owner is reclaimed once it
        // is old enough to be clearly stale.
        let dead = create_operation_dir("ui").unwrap();
        let dead_bootstrap = RelocationBootstrap {
            protocol_version: UNINSTALL_PROTOCOL_VERSION,
            nonce: "e".repeat(32),
            source_exe: r"C:\Apps\SidekickAI\uninstall.exe".into(),
            source_sha256: "f".repeat(64),
            pid: dead_pid,
        };
        let dead_file = dead.join("bootstrap.json");
        write_atomic(&dead_file, &serde_json::to_vec(&dead_bootstrap).unwrap()).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&dead_file)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(2 * 3600))
            .unwrap();

        sweep_stale_relocations().unwrap();

        assert!(live.is_dir(), "a relocation owned by a live process must be kept");
        assert!(fresh.is_dir(), "a fresh relocation must survive the grace period even if its owner is gone");
        assert!(!dead.exists(), "an abandoned relocation must be reclaimed once it is old enough");

        // An unreadable bootstrap is only reclaimed once it is clearly abandoned.
        let unreadable = create_operation_dir("ui").unwrap();
        write_atomic(&unreadable.join("bootstrap.json"), b"not json").unwrap();
        sweep_stale_relocations().unwrap();
        assert!(unreadable.is_dir(), "a fresh directory with an unreadable bootstrap must be left alone");

        cleanup_directory(&live);
        cleanup_directory(&fresh);
        cleanup_directory(&unreadable);
    }

    /// Unknown liveness must never be mistaken for a dead owner. PID 4 is the
    /// system process; whether it can be opened or not, it is not removable.
    #[test]
    fn liveness_is_never_inferred_from_an_unopenable_process() {
        assert!(process_is_alive(4), "an unopenable system process must be treated as alive");
    }

    #[test]
    fn relocation_pointing_back_into_the_temporary_area_is_rejected() {
        let inner = operation_root().join("nested").join("uninstall.exe");
        assert!(resolve_relocation_origin(&inner.to_string_lossy()).is_err());
        // A normal installation directory is a valid origin.
        let outside = std::env::temp_dir().join("sidekick-relocation-origin").join("uninstall.exe");
        let resolved = resolve_relocation_origin(&outside.to_string_lossy()).unwrap();
        assert_eq!(resolved, outside.parent().unwrap());
    }
