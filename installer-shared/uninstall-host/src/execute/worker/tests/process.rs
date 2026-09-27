#[cfg(test)]
#[path = "../../../../../test-fixtures.rs"]
mod edition_fixtures;
#[cfg(test)]
use edition_fixtures::app_archive;
// Process-boundary, stop, and wait tests.

use super::*;

#[test]
fn deletion_worker_closes_only_the_confirmed_running_installation() {
    use std::os::windows::process::CommandExt;
    let Some(probe) = standalone_artifact() else { return; };
    let root = std::env::temp_dir().join(random_nonce().unwrap());
    let selected = root.join("selected");
    let other = root.join("other");
    let ping = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/ping.exe");
    for directory in [&selected, &other] {
        fs::create_dir_all(directory.join("resources")).unwrap();
        fs::copy(&ping, directory.join("SidekickAI.exe")).unwrap();
        fs::write(directory.join("resources/app.asar"), app_archive(b"fixture")).unwrap();
        fs::write(directory.join("uninstall.exe"), b"fixture").unwrap();
    }
    let spawn = |directory: &Path| std::process::Command::new(directory.join("SidekickAI.exe"))
        .args(["-n", "60", "127.0.0.1"]).creation_flags(0x08000000)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let mut selected_child = spawn(&selected);
    let mut other_child = spawn(&other);
    let result = run_worker_operation_with(&probe, "running-target", "running-request", &DataStrategy::Keep,
        &[WorkerTarget { path: selected.to_string_lossy().into_owned(), scope: InstallScope::PerUser,
            fingerprint: FileFingerprint::from_path(&selected).unwrap(), registered_roots: Vec::new() }],
        &[], None, false, Arc::new(AtomicBool::new(false)));
    let selected_exited = selected_child.try_wait().unwrap().is_some();
    let other_survived = other_child.try_wait().unwrap().is_none();
    let removed = !selected.exists();
    let _ = selected_child.kill();
    let _ = selected_child.wait();
    let _ = other_child.kill();
    let _ = other_child.wait();
    let _ = fs::remove_dir_all(root);
    let outcome = result.unwrap();
    assert!(outcome.error.is_none(), "worker must close the target before removal: {:?}", outcome.error);
    assert!(selected_exited && removed);
    assert!(other_survived, "an unselected same-name process must survive");
}

    #[cfg(windows)]
    #[test]
    fn exited_worker_can_return_the_active_status_value() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "259"]).creation_flags(0x08000000).spawn().unwrap();
        child.wait().unwrap();
        let process = WorkerProcess::open_for_test(child.id()).unwrap();
        assert_eq!(process.exit_code(), Some(259));
    }

    /// End-to-end controller -> spawned real worker process -> deletion.
    #[test]
    fn controller_spawns_a_real_worker_process_that_deletes_only_the_target() {
        let Some(probe) = standalone_artifact() else {
            return;
        };
        assert!(probe.is_file(), "no standalone uninstaller artifact found; run `node scripts/build-tauri-installer.cjs --uninstaller x64`");
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let confirmed = root.join("SidekickAI");
        let unselected = root.join("SidekickAI-other");
        for directory in [&confirmed, &unselected] {
            fs::create_dir_all(directory.join("resources")).unwrap();
            fs::write(directory.join("SidekickAI.exe"), b"fixture executable").unwrap();
            fs::write(directory.join("resources").join("app.asar"), app_archive(b"fixture asar")).unwrap();
            fs::write(directory.join("uninstall.exe"), b"fixture uninstaller").unwrap();
        }
        fs::write(unselected.join("sentinel.txt"), b"must survive").unwrap();
        assert!(confirmed.starts_with(&root) && unselected.starts_with(&root));

        let fingerprint = FileFingerprint::from_path(&confirmed).unwrap();
        let outcome = run_worker_operation_with(
            &probe,
            "process-boundary",
            "process-request",
            &DataStrategy::Keep,
            &[WorkerTarget {
                path: confirmed.to_string_lossy().into_owned(),
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

        assert!(outcome.error.is_none(), "worker reported: {:?}", outcome.error);
        assert_eq!(outcome.removed_install_paths.len(), 1);
        assert!(!confirmed.exists(), "confirmed installation should be removed by the spawned worker");
        assert_eq!(fs::read(unselected.join("sentinel.txt")).unwrap(), b"must survive");
        assert!(outcome.warnings.iter().any(|warning| warning == "USER_DATA_PRESERVED"));
        // The private operation directory must be released after a successful run.
        assert!(!operation_root().read_dir().unwrap().any(|entry| {
            entry.map(|e| e.file_name().to_string_lossy().starts_with("process-boundary-")).unwrap_or(false)
        }));

        let _ = fs::remove_dir_all(&root);
    }

    /// A controller-supplied request cannot authorize an unconfirmed path: the
    /// worker rejects a target that is not the directory it validated.
    #[test]
    fn spawned_worker_rejects_a_target_that_changed_before_execution() {
        let Some(probe) = standalone_artifact() else {
            return;
        };
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let confirmed = root.join("SidekickAI");
        fs::create_dir_all(confirmed.join("resources")).unwrap();
        fs::write(confirmed.join("SidekickAI.exe"), b"original").unwrap();
        fs::write(confirmed.join("resources").join("app.asar"), app_archive(b"original")).unwrap();
        fs::write(confirmed.join("uninstall.exe"), b"original").unwrap();
        let fingerprint = FileFingerprint::from_path(&confirmed).unwrap();
        fs::write(confirmed.join("SidekickAI.exe"), b"tampered after scan").unwrap();

        let outcome = run_worker_operation_with(
            &probe,
            "process-changed",
            "process-changed-request",
            &DataStrategy::Keep,
            &[WorkerTarget {
                path: confirmed.to_string_lossy().into_owned(),
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

        // The worker still produces a verified result file; it reports failure.
        assert_eq!(outcome.error.as_ref().unwrap().code, UninstallErrorCode::TargetChanged);
        assert!(outcome.removed_install_paths.is_empty());
        assert!(confirmed.join("SidekickAI.exe").is_file(), "changed target must survive");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn worker_command_line_quotes_paths_with_spaces() {
        let line = worker_command_line(Path::new(r"C:\Users\Some User\AppData\Local\Temp\SidekickAI-Uninstall\op-1\request.json"));
        assert!(line.starts_with("--worker \""));
        assert!(line.ends_with("request.json\""));
        assert_eq!(line.matches('"').count(), 2, "the path must be one quoted argument");
    }

    /// Only processes bound to the confirmed target path may be stopped; a
    /// same-named process from another installation must survive.
    #[test]
    fn process_stop_is_bound_to_the_confirmed_path_only() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let source = PathBuf::from(&system_root).join("System32").join("ping.exe");
        if !source.is_file() {
            eprintln!("notice: ping.exe unavailable; process binding test skipped");
            return;
        }
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let bound = root.join("SidekickAI");
        let other = root.join("SidekickAI-other");
        for directory in [&bound, &other] {
            fs::create_dir_all(directory).unwrap();
            fs::copy(&source, directory.join("SidekickAI.exe")).unwrap();
        }
        assert!(bound.starts_with(&root) && other.starts_with(&root));

        let mut bound_child = std::process::Command::new(bound.join("SidekickAI.exe"))
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let mut other_child = std::process::Command::new(other.join("SidekickAI.exe"))
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(700));

        let target = sidekickai_uninstall_core::normalize_target_path(&bound).unwrap();
        let killed = stop_target_processes(&[target], "process-test").unwrap();

        assert!(killed.contains(&bound_child.id()), "bound process should be stopped");
        assert!(!killed.contains(&other_child.id()), "another installation must not be killed");
        assert!(bound_child.try_wait().unwrap().is_some(), "bound process should have exited");
        assert!(other_child.try_wait().unwrap().is_none(), "unselected installation must keep running");

        let _ = other_child.kill();
        let _ = other_child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows paths are case-insensitive, so the descendant match must be too.
    #[test]
    fn process_stop_matches_the_target_path_case_insensitively() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let source = PathBuf::from(&system_root).join("System32").join("ping.exe");
        if !source.is_file() {
            eprintln!("notice: ping.exe unavailable; case-insensitive binding test skipped");
            return;
        }
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let bound = root.join("SidekickAI-MixedCase");
        fs::create_dir_all(&bound).unwrap();
        fs::copy(&source, bound.join("SidekickAI.exe")).unwrap();

        let mut child = std::process::Command::new(bound.join("SidekickAI.exe"))
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(700));

        // The target is supplied with the opposite casing from the running image.
        let upper = PathBuf::from(bound.to_string_lossy().to_uppercase());
        let target = sidekickai_uninstall_core::normalize_target_path(&upper).unwrap();
        let killed = stop_target_processes(&[target], "case-test").unwrap();
        assert!(killed.contains(&child.id()), "a differently-cased target path must still match");

        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_signaled_process_handle_is_not_a_live_installation_process() {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        let root = std::env::temp_dir().join(random_nonce().unwrap());
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let source = PathBuf::from(system_root).join("System32/ping.exe");
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("SidekickAI.exe");
        fs::copy(&source, &executable).unwrap();
        let mut child = std::process::Command::new(&executable).args(["-n", "1", "127.0.0.1"])
            .creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        child.wait().unwrap();
        let handle = windows::Win32::Foundation::HANDLE(child.as_raw_handle());
        let target = sidekickai_uninstall_core::normalize_target_path(&root).unwrap();
        assert!(!super::super::process::live_process_matches(handle, &[target]));
        drop(child);
        fs::remove_dir_all(root).unwrap();
    }

    /// A verified result that appears before the worker exits must not be
    /// returned early: the controller waits for the process to actually exit so
    /// cleanup cannot race an open image.
    #[cfg(windows)]
    #[test]
    fn wait_for_outcome_waits_for_the_worker_process_to_exit() {
        use std::process::Stdio;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ping = PathBuf::from(&system_root).join("System32").join("ping.exe");
        if !ping.is_file() {
            eprintln!("notice: ping.exe unavailable; wait-for-exit test skipped");
            return;
        }
        let directory = create_operation_dir("wait-exit").unwrap();
        let nonce = "00112233445566778899aabbccddeeff";
        let mut child = std::process::Command::new(&ping)
            .args(["-n", "3", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let process = WorkerProcess::open_for_test(child.id()).unwrap();
        // Publish a verified result while the process is still running.
        let outcome = WorkerOutcome {
            protocol_version: 1, operation_id: "wait-exit".into(), nonce: nonce.into(),
            removed_install_paths: vec![], removed_data_roots: vec![], partially_removed_paths: vec![],
            warnings: vec![], error: None,
        };
        write_atomic(&directory.join("result.json"), &serde_json::to_vec(&outcome).unwrap()).unwrap();

        let started = Instant::now();
        let returned = wait_for_outcome(
            &directory,
            nonce,
            "wait-exit",
            Arc::new(AtomicBool::new(false)),
            &process,
        )
        .unwrap();
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(700), "wait returned before the worker exited after {elapsed:?}");
        assert!(child.try_wait().unwrap().is_some(), "the worker must have exited before wait returned");
        assert!(returned.error.is_none());

        let _ = child.wait();
        cleanup_directory(&directory);
    }

    /// A worker that dies without a result must name its own PID and the
    /// preserved operation directory.
    #[cfg(windows)]
    #[test]
    fn dead_worker_error_reports_pid_and_operation_directory() {
        let directory = create_operation_dir("dead-worker").unwrap();
        let mut child = std::process::Command::new("cmd").args(["/C", "exit", "3"]).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // `child` is kept alive so the process object (and its PID) still exists.
        let process = WorkerProcess::open_for_test(pid).unwrap();
        let error = wait_for_outcome(
            &directory,
            "00112233445566778899aabbccddeeff",
            "dead-worker",
            Arc::new(AtomicBool::new(false)),
            &process,
        )
        .unwrap_err();
        let details = error.details.expect("the failure must carry details");
        assert_eq!(details.get("workerPid"), Some(&DetailValue::Number(pid as i64)));
        assert!(
            matches!(details.get("operationDirectory"), Some(DetailValue::String(value)) if value.contains("dead-worker")),
            "the operation directory must be reported: {details:?}"
        );
        drop(child);
        cleanup_directory(&directory);
    }

    /// A malformed result must not short-circuit the wait: the process is waited
    /// for and only then is the parse failure returned, so no error path leaves an
    /// active deletion running.
    #[cfg(windows)]
    #[test]
    fn wait_for_outcome_waits_for_exit_before_parsing_an_invalid_result() {
        use std::process::Stdio;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ping = PathBuf::from(&system_root).join("System32").join("ping.exe");
        if !ping.is_file() {
            eprintln!("notice: ping.exe unavailable; invalid-result wait test skipped");
            return;
        }
        let directory = create_operation_dir("wait-invalid").unwrap();
        let mut child = std::process::Command::new(&ping)
            .args(["-n", "3", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let process = WorkerProcess::open_for_test(child.id()).unwrap();
        fs::write(directory.join("result.json"), b"{ this is not a worker result").unwrap();

        let started = Instant::now();
        let error = wait_for_outcome(
            &directory,
            "00112233445566778899aabbccddeeff",
            "wait-invalid",
            Arc::new(AtomicBool::new(false)),
            &process,
        )
        .unwrap_err();
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(700), "an invalid result returned before the worker exited after {elapsed:?}");
        assert!(child.try_wait().unwrap().is_some(), "the worker must have exited before wait returned");
        assert_eq!(error.code, UninstallErrorCode::Internal);

        let _ = child.wait();
        cleanup_directory(&directory);
    }
