use super::*;
use std::io::{BufRead, BufReader};

#[test]
#[ignore = "Requires final packaged applications in an isolated acceptance directory"]
fn final_packaged_completion_opens_the_exact_application() {
    let root = PathBuf::from(std::env::var("SIDEKICK_APPLICATION_TEST_ROOT").expect("private acceptance root required")).canonicalize().unwrap();
    let build = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build").canonicalize().unwrap();
    assert!(root.starts_with(&build) && root != build);
    let namespace = std::env::var("SIDEKICK_APPLICATION_TEST_NAMESPACE").expect("native namespace required");
    assert!(!namespace.is_empty());
    assert_eq!(std::env::var("SIDEKICK_TEST_SESSION").unwrap(), namespace);
    for variable in ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        let directory = PathBuf::from(std::env::var_os(variable).expect("private system path required")).canonicalize().unwrap();
        assert!(directory.starts_with(&root) && directory != root);
    }
    if let Some(directory) = std::env::var_os("SIDEKICK_DATA_DIR") {
        assert!(PathBuf::from(directory).canonicalize().unwrap().starts_with(&root));
    }
    let target = PathBuf::from(std::env::var("SIDEKICK_APPLICATION_ACCEPTANCE_TARGET").expect("final target required"));
    assert!(target.is_absolute());
    assert!(target.canonicalize().unwrap().starts_with(&root));
    assert!(root.join("acceptance-fixture.json").is_file());
    let (_, previous) = inventory().unwrap();
    let previous_pids: Vec<u32> = previous.iter().map(|owner| owner.pid).collect();
    let bootstrap = root.join("target-bootstrap");
    std::fs::create_dir(&bootstrap).unwrap();
    let output = std::fs::File::create_new(root.join("target-process.log")).unwrap();
    let errors = output.try_clone().unwrap();
    launch_with(&target, "--skip-guide", |executable, argument, request_id| {
        reservation::current_request(executable, request_id)?;
        let child = Command::new(executable).args([argument, "--inspect-brk=0", "--remote-debugging-port=0"])
            .arg(format!("--user-data-dir={}", bootstrap.display()))
            .env("SIDEKICK_APPLICATION_INTENT", "installation").env("SIDEKICK_APPLICATION_REQUEST_ID", request_id)
            .stdout(Stdio::from(output)).stderr(Stdio::from(errors)).spawn().map_err(|error| error.to_string())?;
        std::fs::write(root.join("target-started.json"), json!({ "pid": child.id(), "executable": executable }).to_string())
            .map_err(|error| error.to_string())
    }).unwrap();
    assert!(previous.iter().all(Application::exited));
    let (pipe, owners) = inventory().unwrap();
    assert_eq!(owners.len(), 1);
    assert!(paths_equal(&owners[0].executable, &target));
    let peer = request(&pipe, json!({ "protocol": 1, "edition": product::edition_id(), "action": "status" })).unwrap();
    verify_started_owner(&peer, &target).unwrap();
    assert_eq!(peer["pid"], owners[0].pid);
    assert_eq!(peer["status"], "running");
    std::fs::write(root.join("completion-open.json"), json!({ "pid": owners[0].pid, "edition": owners[0].edition,
        "version": owners[0].version, "executable": target, "previousPids": previous_pids, "previousExited": true,
        "singleOwner": true, "windowReady": true, "isolation": "main-entry-inspector" }).to_string()).unwrap();
}

struct Probe(std::process::Child);
impl Drop for Probe { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

fn owner(edition: &str, version: &str, behavior: &str) -> (Probe, String, Application) {
    let pipe = format!("sidekick-launch-test-{}", sidekickai_uninstall_core::random_id("pipe").unwrap());
    let script = r#"
const net = require('node:net');
const { PROBE_PIPE: pipe, PROBE_EDITION: edition, PROBE_VERSION: version, PROBE_BEHAVIOR: behavior } = process.env;
let refused = false;
const server = net.createServer(socket => {
  let received = '';
  socket.on('data', chunk => {
    received += chunk; if (!received.includes('\n')) return;
    const input = JSON.parse(received.split('\n')[0]);
    let status = behavior === 'busy' || refused ? 'busy' : 'running';
    const shutdown = input.action === 'shutdown';
    if (shutdown) {
      status = input.edition === edition && input.version === version && input.executable.toLowerCase() === process.execPath.toLowerCase() ? 'yielding' : 'denied';
      if (behavior === 'save-refused') refused = true;
    }
    socket.end(JSON.stringify({protocol:1,edition,version,executable:behavior === 'wrong-path' ? 'E:/unrelated/SidekickAI.exe' : process.execPath,pid:behavior === 'wrong-pid' ? process.pid + 1 : process.pid,status,retryableHandoff:refused}) + '\n', () => {
      if (shutdown && status === 'yielding' && behavior === 'ready') setTimeout(() => process.exit(0), 120);
    });
  });
});
server.listen(['', '', '.', 'pipe', pipe].join(String.fromCharCode(92)), () => console.log(JSON.stringify({pid:process.pid,executable:process.execPath})));
"#;
    let mut probe = Probe(Command::new("node").args(["-e", script]).env("PROBE_PIPE", &pipe)
        .env("PROBE_EDITION", edition).env("PROBE_VERSION", version).env("PROBE_BEHAVIOR", behavior)
        .creation_flags(0x08000000).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap());
    let mut ready = String::new();
    BufReader::new(probe.0.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let data: Value = serde_json::from_str(&ready).unwrap();
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, probe.0.id()) }.unwrap();
    let app = Application { handle, pid: probe.0.id(), executable: data["executable"].as_str().unwrap().into(), edition: edition.into(), version: version.into() };
    (probe, pipe, app)
}

#[test]
fn installation_completion_closes_either_edition_at_older_or_newer_versions() {
    for edition in ["concept", "community"] {
        for version in ["0.1.0-beta.4", "0.1.0-beta.5", "9.0.0"] {
            let (_probe, pipe, app) = owner(edition, version, "ready");
            let peer = request(&pipe, json!({ "protocol": 1, "edition": edition, "action": "status" })).unwrap();
            assert_eq!(peer["pid"].as_u64(), Some(app.pid as u64));
            wait_for_exit(&pipe, std::slice::from_ref(&app), Duration::from_secs(12)).unwrap();
            assert!(app.exited());
        }
    }
}

#[test]
fn installation_completion_terminates_verified_busy_or_unsaved_owners() {
    for behavior in ["busy", "save-refused"] {
        let (_probe, pipe, app) = owner("community", "0.1.0-beta.4", behavior);
        wait_for_exit(&pipe, std::slice::from_ref(&app), Duration::from_millis(500)).unwrap();
        assert!(app.exited());
    }
}

#[test]
fn forged_pipe_owners_are_never_terminated() {
    for behavior in ["wrong-path", "wrong-pid"] {
        let (_probe, pipe, app) = owner("community", "0.1.0-beta.4", behavior);
        assert!(wait_for_exit(&pipe, std::slice::from_ref(&app), Duration::from_secs(8)).is_err());
        assert!(!app.exited());
    }
}

#[test]
fn no_running_owner_needs_no_shutdown() {
    assert!(wait_for_exit("unused", &[], Duration::ZERO).is_ok());
    assert!(!inspection_requires_elevation(&[]));
}

#[test]
fn a_closed_controller_cancels_shutdown_before_touching_the_owner() {
    let (_probe, pipe, application) = owner("community", "1", "busy");
    let error = wait_for_exit_guarded(&pipe, std::slice::from_ref(&application), Duration::ZERO, &|| Ok(false)).unwrap_err();
    assert!(error.contains("已取消"));
    assert!(!application.exited());
    let peer = request(&pipe, json!({ "protocol": 1, "action": "status" })).unwrap();
    assert_eq!(peer["status"], "busy");
}

#[test]
fn native_inventory_and_authenticated_status_preserve_the_owner_identity() {
    let snapshot_started = Instant::now();
    let data = native::inventory().unwrap();
    assert!(!data.home.is_empty());
    let inventory_us = snapshot_started.elapsed().as_micros();
    let (_probe, pipe, app) = owner("community", "1", "ready");
    let request_started = Instant::now();
    let peer = request(&pipe, json!({ "protocol": 1, "action": "status" })).unwrap();
    assert_eq!(peer["pid"].as_u64(), Some(app.pid as u64));
    assert_eq!(native::peer(&pipe).unwrap(), app.pid);
    println!("Native inspection timings: inventory_us={inventory_us}, status_us={}", request_started.elapsed().as_micros());
}

#[test]
fn maintenance_and_renderer_processes_never_request_owner_control() {
    for command in ["app --type=renderer", "app --worker", "app --elevated", "app --uninstall", "app --export-user-data", "app --sidekick-cookie-worker"] {
        let record = ProcessRecord { process_id: u32::MAX, parent_process_id: 0, executable_path: None, command_line: Some(command.into()), created: None };
        assert!(!inspection_requires_elevation(std::slice::from_ref(&record)));
    }
}

#[test]
fn unresponsive_pipe_reads_are_bounded_and_cancelled() {
    let pipe = format!("sidekick-launch-timeout-{}", sidekickai_uninstall_core::random_id("pipe").unwrap());
    let script = r#"const net=require('node:net'); const server=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',()=>{});});server.listen(['','','.','pipe',process.env.PROBE_PIPE].join(String.fromCharCode(92)),()=>console.log('ready'));"#;
    let mut probe = Probe(Command::new("node").args(["-e", script]).env("PROBE_PIPE", &pipe)
        .creation_flags(0x08000000).stdout(Stdio::piped()).spawn().unwrap());
    let mut ready = String::new();
    BufReader::new(probe.0.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let started = Instant::now();
    let error = request(&pipe, json!({ "protocol": 1, "action": "status" })).unwrap_err();
    assert!(error.to_string().contains("超时"));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(probe.0.try_wait().unwrap().is_none());
}

#[test]
fn process_snapshots_require_the_same_creation_time_at_cim_precision() {
    assert!(process_snapshot_matches(134353785094070019, Some(134353785094070010)));
    for created in [None, Some(0), Some(134353785094070000), Some(134353785094070020)] {
        assert!(!process_snapshot_matches(134353785094070019, created));
    }
}

fn descendant_record(application: &Application, parent: u32, command: Option<&str>) -> ProcessRecord {
    ProcessRecord { process_id: application.pid, parent_process_id: parent, executable_path: Some(application.executable.to_string_lossy().into_owned()),
        command_line: command.map(String::from), created: Some(process_started(application.handle).unwrap() / 10 * 10) }
}

#[test]
fn stale_child_snapshots_never_capture_an_identical_image_or_account() {
    let (_root_probe, _root_pipe, root) = owner("community", "1", "ready");
    let (_child_probe, _child_pipe, child) = owner("community", "1", "ready");
    let mut record = descendant_record(&child, root.pid, None);
    record.created = record.created.map(|created| created - 10);
    assert!(capture_owned_descendant(&root, &record, process_started(root.handle).unwrap()).is_none());
    record.created = None;
    assert!(capture_owned_descendant(&root, &record, process_started(root.handle).unwrap()).is_none());
    assert!(!child.exited());
}

#[test]
fn executor_branches_prune_identical_image_grandchildren() {
    let (_root_probe, _root_pipe, root) = owner("community", "1", "ready");
    let (_child_probe, _child_pipe, child) = owner("community", "1", "ready");
    let (_grandchild_probe, _grandchild_pipe, grandchild) = owner("community", "1", "ready");
    let records = [descendant_record(&grandchild, child.pid, None), descendant_record(&child, root.pid, Some("node --worker"))];
    assert!(capture_owned_descendants(&root, &records).unwrap().is_empty());
    assert!(!child.exited());
    assert!(!grandchild.exited());
}

#[test]
fn verified_descendants_are_captured_independent_of_snapshot_order() {
    let (_root_probe, _root_pipe, root) = owner("community", "1", "ready");
    let (_child_probe, _child_pipe, child) = owner("community", "1", "ready");
    let (_grandchild_probe, _grandchild_pipe, grandchild) = owner("community", "1", "ready");
    let records = [descendant_record(&grandchild, child.pid, None), descendant_record(&child, root.pid, None)];
    let captured = capture_owned_descendants(&root, &records).unwrap();
    assert_eq!(captured.iter().map(|process| process.pid).collect::<Vec<_>>(), vec![child.pid, grandchild.pid]);
}
