use super::*;
use serde_json::json;
#[path = "../../../../installer-shared/test-fixtures.rs"]
mod edition_fixtures;

fn fixture() -> (super::super::OperationDirectory, OperationRequest) {
    let directory = super::super::OperationDirectory::create("completion-test").unwrap();
    let request: InstallRequest = serde_json::from_value(json!({
        "installDir": "E:/completion-fixture/target", "forAllUsers": false,
        "createDesktopShortcut": false, "launchAfterInstall": false,
        "features": {}, "options": {}, "mode": "repair"
    })).unwrap();
    let envelope = directory.write_envelope(super::super::ACTION_INSTALL, &request).unwrap();
    (directory, envelope)
}

fn command(envelope: &OperationRequest, sequence: u32, action: Action) -> Command {
    let configuration = if matches!(action, Action::FlushConfig) {
        Some(Configuration { features: Map::new(), options: Map::new() })
    } else { None };
    Command { protocol_version: OPERATION_PROTOCOL_VERSION, operation_id: envelope.operation_id.clone(),
        nonce: envelope.nonce.clone(), sequence, action, configuration, show_guide: false }
}

#[test]
fn completion_credentials_and_sequence_are_bound_to_the_installation() {
    let (_directory, envelope) = fixture();
    let valid = command(&envelope, 2, Action::OpenApplication);
    verify_command(&valid, &envelope, 2).unwrap();
    for field in ["protocol", "operation", "nonce", "sequence"] {
        let mut changed = valid.clone();
        match field {
            "protocol" => changed.protocol_version += 1,
            "operation" => changed.operation_id.push_str("-other"),
            "nonce" => changed.nonce.push('0'),
            "sequence" => changed.sequence = 1,
            _ => unreachable!(),
        }
        assert!(verify_command(&changed, &envelope, 2).is_err(), "accepted changed {field}");
    }
    assert!(verify_command(&valid, &envelope, 1).is_err());
    assert!(verify_command(&valid, &envelope, 3).is_err());
}

#[test]
fn completion_actions_cannot_exchange_their_authorized_payloads() {
    let (_directory, envelope) = fixture();
    let mut flush = command(&envelope, 1, Action::FlushConfig);
    verify_command(&flush, &envelope, 1).unwrap();
    flush.show_guide = true;
    assert!(verify_command(&flush, &envelope, 1).is_err());
    flush.show_guide = false;
    flush.configuration = None;
    assert!(verify_command(&flush, &envelope, 1).is_err());
    let mut open = command(&envelope, 1, Action::OpenApplication);
    for show_guide in [false, true] {
        open.show_guide = show_guide;
        verify_command(&open, &envelope, 1).unwrap();
    }
    open.configuration = Some(Configuration { features: Map::new(), options: Map::new() });
    assert!(verify_command(&open, &envelope, 1).is_err());
}

#[test]
fn completion_parser_refuses_unknown_actions_and_expanded_authority() {
    let (_directory, envelope) = fixture();
    let baseline = serde_json::to_value(command(&envelope, 1, Action::FlushConfig)).unwrap();
    for action in ["install", "uninstall", "run-command", "open-application-other"] {
        let mut changed = baseline.clone();
        changed["action"] = json!(action);
        assert!(serde_json::from_value::<Command>(changed).is_err(), "accepted action {action}");
    }
    for field in ["installDir", "executable", "deleteUserData", "cleanupPaths", "cloudAssets", "arguments"] {
        let mut changed = baseline.clone();
        changed[field] = json!("unrelated");
        assert!(serde_json::from_value::<Command>(changed).is_err(), "accepted field {field}");
    }
    let mut changed = baseline;
    changed["configuration"]["installDir"] = json!("E:/unrelated");
    assert!(serde_json::from_value::<Command>(changed).is_err());
}

#[test]
fn bounded_private_messages_accept_the_limit_and_reject_one_extra_byte() {
    let (directory, envelope) = fixture();
    let path = directory.request_path().with_file_name("bounded.json");
    let mut bytes = serde_json::to_vec(&command(&envelope, 1, Action::OpenApplication)).unwrap();
    bytes.resize(MESSAGE_LIMIT as usize, b' ');
    std::fs::write(&path, &bytes).unwrap();
    let parsed: Command = read_private(&path).unwrap();
    verify_command(&parsed, &envelope, 1).unwrap();
    bytes.push(b' ');
    std::fs::write(&path, &bytes).unwrap();
    assert!(read_private::<Command>(&path).unwrap_err().contains("过大"));
}

#[test]
fn private_messages_refuse_malformed_shapes_and_credential_mismatch() {
    let (directory, envelope) = fixture();
    let path = directory.request_path().with_file_name("message.json");
    for bytes in [b"null".as_slice(), b"[]", b"{", b"{}"] {
        std::fs::write(&path, bytes).unwrap();
        assert!(read_private::<Command>(&path).is_err());
    }
    let mut replay = command(&envelope, 1, Action::OpenApplication);
    replay.nonce = "other-session".into();
    write_private(&path, &replay).unwrap();
    let parsed: Command = read_private(&path).unwrap();
    assert!(verify_command(&parsed, &envelope, 1).is_err());
}

#[test]
fn retries_use_distinct_directories_and_result_identities() {
    let (directory, envelope) = fixture();
    let first = command_id(&envelope.operation_id, 1);
    let retry = command_id(&envelope.operation_id, 2);
    assert_ne!(first, retry);
    assert_ne!(command_directory(&directory.request_path(), 1).unwrap(), command_directory(&directory.request_path(), 2).unwrap());
    let result = super::super::envelope::OperationResult { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: first.clone(), nonce: envelope.nonce.clone(), ok: true, error: None };
    let raw = serde_json::to_string(&result).unwrap();
    super::super::interpret_child_result(Some(&raw), 0, &first, &envelope.nonce).unwrap();
    assert!(super::super::interpret_child_result(Some(&raw), 0, &retry, &envelope.nonce).is_err());
    let replay = command(&envelope, 1, Action::OpenApplication);
    assert!(verify_command(&replay, &envelope, 2).is_err());
}

#[test]
fn private_message_read_refuses_a_junction_in_its_path() {
    let (directory, envelope) = fixture();
    let target = directory.request_path().with_file_name("junction-target");
    let link = directory.request_path().with_file_name("junction-link");
    std::fs::create_dir(&target).unwrap();
    write_private(&target.join("message.json"), &command(&envelope, 1, Action::OpenApplication)).unwrap();
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let native_name = |path: &Path| path.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\");
    let output = std::process::Command::new(shell)
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:SIDEKICK_COMPLETION_JUNCTION_LINK -Target $env:SIDEKICK_COMPLETION_JUNCTION_TARGET | Out-Null"])
        .env("SIDEKICK_COMPLETION_JUNCTION_LINK", native_name(&link))
        .env("SIDEKICK_COMPLETION_JUNCTION_TARGET", native_name(&target)).output().unwrap();
    assert!(output.status.success(), "private junction creation failed: {}", String::from_utf8_lossy(&output.stderr));
    let rejected = read_private::<Command>(&link.join("message.json")).is_err();
    std::fs::remove_dir(&link).unwrap();
    assert!(rejected, "accepted message reached through a junction");
}

#[test]
fn caller_capture_accepts_the_live_controller_and_rejects_mutated_bindings() {
    let (directory, envelope) = fixture();
    let caller = Caller::inspect(std::process::id()).unwrap();
    let path = directory.request_path().with_file_name("session-binding.json");
    let valid = Binding { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone(),
        pid: std::process::id(), started: caller.started, session: caller.session,
        executable: caller.executable.clone() };
    write_private(&path, &valid).unwrap();
    let captured = Caller::capture(&envelope, &directory.request_path()).unwrap();
    assert!(captured.alive().unwrap());
    assert_eq!(captured.started, caller.started);
    assert_eq!(captured.session, caller.session);
    for field in ["started", "session", "pid", "executable", "protocolVersion", "operationId", "nonce"] {
        let mut changed = serde_json::to_value(&valid).unwrap();
        changed[field] = match field {
            "started" => json!(caller.started + 1),
            "session" => json!(caller.session.wrapping_add(1)),
            "pid" => json!(std::process::id().wrapping_add(1)),
            "executable" => json!(directory.request_path()),
            "protocolVersion" => json!(OPERATION_PROTOCOL_VERSION + 1),
            _ => json!("unrelated-binding"),
        };
        write_private(&path, &changed).unwrap();
        assert!(Caller::capture(&envelope, &directory.request_path()).is_err(), "accepted mutated {field}");
    }
    std::fs::remove_file(&path).unwrap();
    assert!(Caller::capture(&envelope, &directory.request_path()).is_err());
}

#[test]
#[ignore = "Private child role invoked only by the controller lifetime fixture"]
fn completion_private_controller_child() {
    let root = PathBuf::from(std::env::var_os("SIDEKICK_COMPLETION_CONTROLLER_ROOT").expect("private fixture root required"));
    let marker = std::env::var("SIDEKICK_COMPLETION_CONTROLLER_MARKER").expect("private fixture marker required");
    assert_eq!(std::fs::read_to_string(root.join("controller-marker")).unwrap(), marker);
    std::fs::write(root.join("controller-ready"), &marker).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if std::fs::read_to_string(root.join("controller-release")).ok().as_deref() == Some(marker.as_str()) { return; }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn bound_worker_observes_private_controller_normal_exit() {
    let (directory, mut envelope) = fixture();
    let root = directory.request_path().parent().unwrap().to_path_buf();
    let marker = directory.nonce().to_string();
    std::fs::write(root.join("controller-marker"), &marker).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_controller_child", "--nocapture"])
        .env("SIDEKICK_COMPLETION_CONTROLLER_ROOT", &root)
        .env("SIDEKICK_COMPLETION_CONTROLLER_MARKER", &marker)
        .spawn().unwrap();
    struct ReleaseChild(PathBuf, String);
    impl Drop for ReleaseChild {
        fn drop(&mut self) { let _ = std::fs::write(self.0.join("controller-release"), &self.1); }
    }
    let _release = ReleaseChild(root.clone(), marker.clone());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("controller-ready").is_file() {
        assert!(child.try_wait().unwrap().is_none(), "private controller exited before its readiness marker");
        assert!(Instant::now() < deadline, "private controller readiness timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
    envelope.controller_pid = child.id();
    let inspected = Caller::inspect(child.id()).unwrap();
    let binding = Binding { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone(),
        pid: child.id(), started: inspected.started, session: inspected.session,
        executable: inspected.executable.clone() };
    write_private(&root.join("session-binding.json"), &binding).unwrap();
    let worker = Worker::bind(&envelope, &directory.request_path()).unwrap();
    assert!(worker.caller.alive().unwrap());
    std::fs::write(root.join("controller-release"), &marker).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "private controller did not exit normally");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(!worker.caller.alive().unwrap());
    assert!(Caller::capture(&envelope, &directory.request_path()).is_err());
}

#[test]
fn pinned_private_directory_keeps_its_original_path_until_drop() {
    let (operation, envelope) = fixture();
    let directory = command_directory(&operation.request_path(), 1).unwrap();
    let moved = directory.with_file_name("moved-completion");
    std::fs::create_dir(&directory).unwrap();
    super::super::directory::harden_private_directory(&directory).unwrap();
    let message = command(&envelope, 1, Action::OpenApplication);
    write_private(&directory.join("request.json"), &message).unwrap();
    let pinned = PinnedDirectory::open(&directory).unwrap();
    assert!(std::fs::rename(&directory, &moved).is_err(), "renamed a pinned private directory");
    assert!(std::fs::remove_file(directory.join("request.json")).is_err(), "removed the immutable request anchor");
    assert!(std::fs::OpenOptions::new().write(true).open(directory.join("request.json")).is_err(), "opened the pinned request for writing");
    let retained: Command = read_private(&directory.join("request.json")).unwrap();
    verify_command(&retained, &envelope, 1).unwrap();
    let result = super::super::envelope::OperationResult { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: command_id(&envelope.operation_id, 1), nonce: envelope.nonce.clone(), ok: true, error: None };
    write_private(&directory.join("result.json"), &result).unwrap();
    let committed: super::super::envelope::OperationResult = read_private(&directory.join("result.json")).unwrap();
    assert!(committed.ok);
    assert_eq!(committed.operation_id, result.operation_id);
    assert!(!moved.exists());
    drop(pinned);
    std::fs::rename(&directory, &moved).unwrap();
    assert!(!directory.exists());
    let retained: Command = read_private(&moved.join("request.json")).unwrap();
    verify_command(&retained, &envelope, 1).unwrap();
}

#[test]
fn release_requires_the_original_operation_credentials() {
    let (directory, envelope) = fixture();
    let root = directory.request_path().parent().unwrap().to_path_buf();
    assert!(!is_released(&root, &envelope).unwrap());
    let release = Release { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone() };
    let path = root.join("release.json");
    write_private(&path, &release).unwrap();
    assert!(is_released(&root, &envelope).unwrap());
    for field in ["protocolVersion", "operationId", "nonce", "unexpected"] {
        let mut invalid = serde_json::to_value(&release).unwrap();
        invalid[field] = if field == "protocolVersion" { json!(OPERATION_PROTOCOL_VERSION + 1) } else { json!("unrelated") };
        write_private(&path, &invalid).unwrap();
        assert!(is_released(&root, &envelope).is_err(), "accepted invalid release {field}");
    }
    std::fs::write(&path, vec![b' '; MESSAGE_LIMIT as usize + 1]).unwrap();
    assert!(is_released(&root, &envelope).is_err());
    std::fs::remove_file(&path).unwrap();
    assert!(!is_released(&root, &envelope).unwrap());
}

#[test]
#[ignore = "Private persistent worker role invoked only by the roundtrip fixture"]
fn completion_private_serve_child() {
    let request_path = PathBuf::from(std::env::var_os("SIDEKICK_COMPLETION_SERVE_REQUEST").expect("private request required"));
    let marker = std::env::var("SIDEKICK_COMPLETION_SERVE_MARKER").expect("private marker required");
    let envelope = super::super::envelope::load_request(&request_path).unwrap();
    assert_eq!(envelope.nonce, marker);
    super::super::envelope::verify_request(&envelope, &std::env::current_exe().unwrap()).unwrap();
    let worker = Worker::bind(&envelope, &request_path).unwrap();
    worker.serve(&envelope, &request_path).unwrap();
    std::fs::write(request_path.with_file_name("serve-ended"), marker).unwrap();
}

#[test]
fn persistent_worker_roundtrip_consumes_sequences_and_exits_on_release() {
    persistent_worker_roundtrip(crate::manifest::InstallMode::Repair);
}

#[test]
fn persistent_worker_saves_changed_config_with_the_original_installation_identity() {
    persistent_worker_roundtrip(crate::manifest::InstallMode::Install);
}

fn persistent_worker_roundtrip(mode: crate::manifest::InstallMode) {
    let operation = super::super::OperationDirectory::create("serve-roundtrip").unwrap();
    let root = operation.request_path().parent().unwrap().to_path_buf();
    let target = root.join("installed");
    std::fs::create_dir_all(target.join("resources")).unwrap();
    let version = crate::setup_metadata::current().unwrap().product_version.clone();
    let edition = sidekickai_uninstall_core::product::edition();
    std::fs::write(target.join("SidekickAI.exe"), b"private non-executable fixture").unwrap();
    std::fs::write(target.join("resources/app.asar"), edition_fixtures::archive_for_version(&edition.package_name, Some(&version), b"completion-roundtrip")).unwrap();
    let receipt = sidekickai_uninstall_core::product::InstallReceipt {
        schema_version: 1, edition: sidekickai_uninstall_core::product::edition_id().into(),
        package_name: edition.package_name.clone(), version, arch: "x64".into(),
        install_location: target.to_string_lossy().into_owned(), installation_id: operation.operation_id().into(),
        registry_root: "HKCU".into(), registry_key: edition.registry_key.clone(),
    };
    write_private(&target.join(sidekickai_uninstall_core::product::INSTALL_RECEIPT), &receipt).unwrap();
    let request: InstallRequest = serde_json::from_value(json!({
        "installDir": target, "forAllUsers": false, "createDesktopShortcut": false,
        "launchAfterInstall": false, "features": {}, "options": {}, "mode": mode,
        "installationId": operation.operation_id()
    })).unwrap();
    let resource = json!({ "resourceType": "rule", "status": "ready", "marker": "private-roundtrip" });
    if mode == crate::manifest::InstallMode::Install {
        write_private(&target.join("install-config.json"), &json!({ "schemaVersion": 2,
            "installationId": operation.operation_id(), "modules": {}, "options": {}, "resources": [resource.clone()] })).unwrap();
    }
    let envelope = operation.write_envelope(super::super::ACTION_INSTALL, &request).unwrap();
    let controller = Caller::inspect(std::process::id()).unwrap();
    let binding = Binding { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone(), pid: std::process::id(),
        started: controller.started, session: controller.session, executable: controller.executable.clone() };
    write_private(&root.join("session-binding.json"), &binding).unwrap();
    let release = Release { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone() };
    struct WorkerRelease(PathBuf, Release, Option<elevate::AuthorizedProcess>);
    impl Drop for WorkerRelease {
        fn drop(&mut self) {
            let _ = write_private(&self.0.join("release.json"), &self.1);
            if let Some(process) = &self.2 {
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline && matches!(process.exit_code(), Ok(None)) { std::thread::sleep(Duration::from_millis(25)); }
            }
        }
    }
    let mut _release = WorkerRelease(root.clone(), release, None);
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_serve_child", "--nocapture"])
        .env("SIDEKICK_COMPLETION_SERVE_REQUEST", operation.request_path())
        .env("SIDEKICK_COMPLETION_SERVE_MARKER", operation.nonce()).spawn().unwrap();
    _release.2 = Some(elevate::AuthorizedProcess::from_test_child(&child).unwrap());
    let wait_file = |path: &Path, child: &mut std::process::Child| {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !path.is_file() {
            assert!(child.try_wait().unwrap().is_none(), "persistent private worker exited before {}", path.display());
            assert!(Instant::now() < deadline, "persistent worker response timed out: {}", path.display());
            std::thread::sleep(Duration::from_millis(25));
        }
    };
    wait_file(&root.join("session-ready.json"), &mut child);
    let ready: Release = read_private(&root.join("session-ready.json")).unwrap();
    assert_eq!(ready.operation_id, envelope.operation_id);
    assert_eq!(ready.nonce, envelope.nonce);
    for sequence in 1..=3 {
        let directory = command_directory(&operation.request_path(), sequence).unwrap();
        std::fs::create_dir(&directory).unwrap();
        super::super::directory::harden_private_directory(&directory).unwrap();
        let mut next = command(&envelope, sequence, Action::FlushConfig);
        next.configuration.as_mut().unwrap().options.insert("autoLaunch".into(), json!(sequence == 1));
        if sequence == 2 { next.sequence = 1; }
        write_private(&directory.join("request.json"), &next).unwrap();
        wait_file(&directory.join("result.json"), &mut child);
        let result: super::super::envelope::OperationResult = read_private(&directory.join("result.json")).unwrap();
        let raw = serde_json::to_string(&result).unwrap();
        let outcome = super::super::interpret_child_result(Some(&raw), 0, &command_id(&envelope.operation_id, sequence), &envelope.nonce);
        assert_eq!(outcome.is_ok(), sequence != 2, "unexpected completion result: {outcome:?}");
        assert!(child.try_wait().unwrap().is_none(), "worker exited instead of preserving the installation session");
        if mode == crate::manifest::InstallMode::Install {
            let saved: Value = read_private(&target.join("install-config.json")).unwrap();
            assert_eq!(saved["options"]["autoLaunch"], json!(sequence != 3));
            assert_eq!(saved["installationId"], operation.operation_id());
            assert!(saved["resources"].as_array().unwrap().contains(&resource));
        }
    }
    if mode == crate::manifest::InstallMode::Repair {
        assert!(!target.join("install-config.json").exists(), "repair no-op unexpectedly wrote configuration");
    }
    let release = Release { protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(), nonce: envelope.nonce.clone() };
    write_private(&root.join("release.json"), &release).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "persistent worker did not acknowledge release");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(std::fs::read_to_string(root.join("serve-ended")).unwrap(), envelope.nonce);
}

#[test]
#[ignore = "Private delayed protocol worker invoked only by the concurrent release fixture"]
fn completion_private_delayed_child() {
    let request_path = PathBuf::from(std::env::var_os("SIDEKICK_COMPLETION_SERVE_REQUEST").expect("private request required"));
    let marker = std::env::var("SIDEKICK_COMPLETION_SERVE_MARKER").expect("private marker required");
    let envelope = super::super::envelope::load_request(&request_path).unwrap();
    assert_eq!(envelope.nonce, marker);
    let root = request_path.parent().unwrap();
    let directory = command_directory(&request_path, 1).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.join("request.json").is_file() {
        if is_released(root, &envelope).unwrap() { return; }
        assert!(Instant::now() < deadline, "private command was not published");
        std::thread::sleep(Duration::from_millis(25));
    }
    let command: Command = read_private(&directory.join("request.json")).unwrap();
    verify_command(&command, &envelope, 1).unwrap();
    std::fs::write(root.join("command-in-flight"), &marker).unwrap();
    while !is_released(root, &envelope).unwrap() {
        assert!(Instant::now() < deadline, "active command was not released");
        std::thread::sleep(Duration::from_millis(25));
    }
    let mut scoped = envelope.clone();
    scoped.operation_id = command_id(&envelope.operation_id, 1);
    assert_eq!(super::super::run::finish_operation(&directory.join("request.json"), &scoped, Err("private command released".into())), 1);
}

#[test]
#[ignore = "Isolated parent role keeps CURRENT separate from parallel tests"]
fn completion_private_active_release_parent() {
    assert_eq!(std::env::var("SIDEKICK_COMPLETION_ACTIVE_ROLE").as_deref(), Ok("private-parent"));
    let (directory, envelope) = fixture();
    let operation = Arc::new(directory.into_prepared());
    let root = operation.request_path.parent().unwrap().to_path_buf();
    let executable = root.join("unused-target.exe");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_delayed_child", "--nocapture"])
        .env("SIDEKICK_COMPLETION_SERVE_REQUEST", &operation.request_path)
        .env("SIDEKICK_COMPLETION_SERVE_MARKER", &envelope.nonce).spawn().unwrap();
    let process = Arc::new(elevate::AuthorizedProcess::from_test_child(&child).unwrap());
    {
        let mut state = CURRENT.lock().unwrap();
        assert!(state.session.is_none() && state.operation.is_none() && state.expected.is_none());
        state.operation = Some(operation.clone());
        state.expected = Some(executable.clone());
        state.session = Some(Session { operation: operation.clone(), process, executable: executable.clone(),
            sequence: 0, opened: Instant::now(), status_offset: 0, failed: false });
    }
    struct ReleaseActive;
    impl Drop for ReleaseActive { fn drop(&mut self) { release(); } }
    let _release = ReleaseActive;
    let command = std::thread::spawn(move || with_session(&executable, |session| session.execute(Action::FlushConfig,
        Some(Configuration { features: Map::new(), options: Map::new() }), false, &|_| {})));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("command-in-flight").is_file() {
        assert!(Instant::now() < deadline, "active command never reached private worker");
        assert!(child.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(25));
    }
    let released = Instant::now();
    release();
    assert!(released.elapsed() < Duration::from_secs(2), "release blocked behind an in-flight command");
    assert!(is_released(&root, &envelope).unwrap());
    assert!(command.join().unwrap().unwrap().is_err());
    let state = CURRENT.lock().unwrap();
    assert!(state.session.is_none() && state.operation.is_none());
    assert!(state.expected.is_some(), "released authorization must remain unavailable to fallback elevation");
    drop(state);
    assert!(with_session(&root.join("unused-target.exe"), |_| panic!("released session executed another command")).unwrap().is_err());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "private worker failed to exit after release");
        std::thread::sleep(Duration::from_millis(25));
    }
    reset();
}

#[test]
fn release_during_active_session_does_not_block_or_restore_authority() {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_active_release_parent", "--nocapture"])
        .env("SIDEKICK_COMPLETION_ACTIVE_ROLE", "private-parent").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "isolated active-release parent timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "Isolated parent role checks unavailable authorization without UAC"]
fn completion_private_unavailable_parent() {
    assert_eq!(std::env::var("SIDEKICK_COMPLETION_UNAVAILABLE_ROLE").as_deref(), Ok("private-parent"));
    let (directory, envelope) = fixture();
    let operation = Arc::new(directory.into_prepared());
    let root = operation.request_path.parent().unwrap().to_path_buf();
    let executable = root.join("unused-target.exe");
    std::fs::write(root.join("controller-marker"), &envelope.nonce).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_controller_child", "--nocapture"])
        .env("SIDEKICK_COMPLETION_CONTROLLER_ROOT", &root)
        .env("SIDEKICK_COMPLETION_CONTROLLER_MARKER", &envelope.nonce).spawn().unwrap();
    struct ReleaseChild(PathBuf, String);
    impl Drop for ReleaseChild {
        fn drop(&mut self) { let _ = std::fs::write(self.0.join("controller-release"), &self.1); }
    }
    let _child_release = ReleaseChild(root.clone(), envelope.nonce.clone());
    let process = Arc::new(elevate::AuthorizedProcess::from_test_child(&child).unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("controller-ready").is_file() {
        assert!(child.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline, "private worker readiness timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
    {
        let mut state = CURRENT.lock().unwrap();
        assert!(state.session.is_none() && state.operation.is_none() && state.expected.is_none());
        state.operation = Some(operation.clone());
        state.expected = Some(executable.clone());
        state.session = Some(Session { operation: operation.clone(), process, executable: executable.clone(),
            sequence: 0, opened: Instant::now(), status_offset: 0, failed: false });
    }
    struct ReleaseSession;
    impl Drop for ReleaseSession { fn drop(&mut self) { reset(); } }
    let _session_release = ReleaseSession;
    assert!(open(&root.join("other-target.exe"), "--skip-guide", &|_| {}).unwrap().unwrap_err().contains("不属于本次"));
    assert!(!command_directory(&operation.request_path, 1).unwrap().exists());
    {
        let mut state = CURRENT.lock().unwrap();
        state.session.as_mut().unwrap().opened = Instant::now() - SESSION_LIMIT;
    }
    assert!(open(&executable, "--skip-guide", &|_| {}).unwrap().unwrap_err().contains("不会自动再次请求授权"));
    assert!(!command_directory(&operation.request_path, 1).unwrap().exists());
    {
        let mut state = CURRENT.lock().unwrap();
        state.session.as_mut().unwrap().opened = Instant::now();
    }
    std::fs::write(root.join("controller-release"), &envelope.nonce).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "private worker did not exit");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(open(&executable, "--skip-guide", &|_| {}).unwrap().unwrap_err().contains("不会自动再次请求授权"));
    assert!(!command_directory(&operation.request_path, 1).unwrap().exists());
    release();
    let unavailable = with_session(&executable, |_| panic!("released session executed another command"));
    assert!(unavailable.unwrap().unwrap_err().contains("不会自动再次请求授权"));
}

#[test]
fn target_mismatch_expiration_and_worker_exit_never_fall_back_to_elevation() {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controller::completion::tests::completion_private_unavailable_parent", "--nocapture"])
        .env("SIDEKICK_COMPLETION_UNAVAILABLE_ROLE", "private-parent").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        assert!(Instant::now() < deadline, "isolated unavailable-authorization parent timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
}
