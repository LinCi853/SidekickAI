use super::*;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use super::super::process::stop_worker_processes;
use super::super::types::WorkerRequest;

thread_local! { static ENDPOINT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
pub(super) fn endpoint() -> Option<String> { ENDPOINT.with(|value| value.borrow().clone()) }

#[path = "../../../../test-fixtures.rs"]
mod fixtures;

struct Fixture { root: PathBuf, child: Child }
impl Drop for Fixture {
    fn drop(&mut self) {
        ENDPOINT.with(|value| *value.borrow_mut() = None);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture(behavior: &str, arguments: &[&str]) -> Fixture {
    let root = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("uninstall-save").unwrap());
    fs::create_dir_all(root.join("resources")).unwrap();
    let node = Command::new("node").args(["-p", "process.execPath"]).creation_flags(0x08000000).output().unwrap();
    assert!(node.status.success());
    fs::copy(String::from_utf8(node.stdout).unwrap().trim(), root.join("SidekickAI.exe")).unwrap();
    fs::write(root.join("resources/app.asar"), fixtures::archive_for_version(&product::edition().package_name, Some("1.2.3"), b"save fixture")).unwrap();
    let endpoint = format!("sidekick-save-{}", sidekickai_uninstall_core::random_id("pipe").unwrap());
    let script = r#"
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const root = __dirname;
let saving = false, rejected = false, savingRequest;
const server = net.createServer(socket => {
  socket.on('error', () => {});
  let input = '';
  socket.on('data', value => {
    input += value;
    if (!input.includes('\n')) return;
    socket.removeAllListeners('data');
    const request = JSON.parse(input.split('\n')[0]);
    if (request.action === 'shutdown') {
      fs.writeFileSync(path.join(root, 'requested'), 'save');
      const locks = path.join(root, 'lock-probe.json');
      if (fs.existsSync(locks)) {
        const command = "$names = Get-Content -LiteralPath $env:SIDEKICK_TEST_LOCK_NAMES | ConvertFrom-Json; $found = 0; foreach ($name in $names) { try { $mutex = [Threading.Mutex]::OpenExisting($name); $mutex.Dispose(); $found += 1 } catch [Threading.WaitHandleCannotBeOpenedException] {} }; exit $found";
        const probe = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
          { windowsHide: true, timeout: 3000, env: { ...process.env, SIDEKICK_TEST_LOCK_NAMES: locks } });
        fs.writeFileSync(path.join(root, 'lock-probe-result'), String(probe.status));
      }
      if (savingRequest !== request.requestId) rejected = false;
      savingRequest = request.requestId;
      saving = true;
    }
    const behavior = fs.existsSync(path.join(root, 'allow-save')) ? 'save' : process.env.FIXTURE_BEHAVIOR;
    if (saving && ['refuse', 'lost-refusal'].includes(behavior)) { rejected = true; saving = false; }
    const denied = rejected;
    if (request.action === 'shutdown' && ['lost-reply', 'lost-refusal'].includes(behavior)) { socket.destroy(); return; }
    socket.end(JSON.stringify({ protocol: 1, pid: behavior === 'forged' ? process.pid + 1 : process.pid,
      edition: process.env.FIXTURE_EDITION, version: '1.2.3', executable: process.execPath,
      status: denied ? 'busy' : saving ? 'yielding' : 'running', retryableHandoff: denied }) + '\n');
    if (saving && behavior === 'save') setTimeout(() => {
      fs.writeFileSync(path.join(root, 'saved'), 'persisted before exit');
      process.exit(0);
    }, 300);
  });
});
server.listen(['', '', '.', 'pipe', process.env.FIXTURE_PIPE].join(String.fromCharCode(92)), () => console.log('ready'));
"#;
    fs::write(root.join("fixture.cjs"), script).unwrap();
    let mut child = Command::new(root.join("SidekickAI.exe")).arg(root.join("fixture.cjs")).args(arguments)
        .env("FIXTURE_PIPE", &endpoint).env("FIXTURE_BEHAVIOR", behavior).env("FIXTURE_EDITION", product::edition_id())
        .creation_flags(0x08000000).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    ENDPOINT.with(|value| *value.borrow_mut() = Some(endpoint));
    Fixture { root, child }
}
fn stop(fixture: &Fixture) -> Result<Vec<u32>, UninstallError> { stop_with_id(fixture, "save-fixture") }
fn stop_with_id(fixture: &Fixture, operation_id: &str) -> Result<Vec<u32>, UninstallError> {
    let request = WorkerRequest {
        protocol_version: UNINSTALL_PROTOCOL_VERSION, operation_id: operation_id.into(), request_id: "request".into(), nonce: "fixture".into(),
        controller_pid: std::process::id(), caller_user_sid: current_user_sid().unwrap(), worker_sha256: String::new(), strategy: DataStrategy::Keep,
        targets: vec![], target_identities: vec![], data_roots: vec![], backup_path: None, backup_sha256: None, backup_proofs: Vec::new(), resume_task_id: None, preparation: None,
    };
    stop_worker_processes(&request, &[sidekickai_uninstall_core::normalize_target_path(&fixture.root).unwrap()])
}

#[test]
fn worker_waits_for_saved_exit() {
    let mut fixture = fixture("save", &[]);
    stop(&fixture).unwrap();
    assert_eq!(fs::read_to_string(fixture.root.join("saved")).unwrap(), "persisted before exit");
    assert!(fixture.child.try_wait().unwrap().is_some());
}

pub(crate) fn assert_save_without_data_locks(data: &Path) {
    let mut fixture = fixture("save", &[]);
    let identity = sidekickai_uninstall_core::path::normalize_absolute_path(data).unwrap().as_string();
    let identity = sidekickai_uninstall_core::lock::windows_ordinal_upper(&identity).unwrap();
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let names = ["controller","worker"].map(|role|format!("Global\\SidekickAI-{role}-{digest}"));
    fs::write(fixture.root.join("lock-probe.json"),serde_json::to_vec(&names).unwrap()).unwrap();
    stop(&fixture).unwrap();
    assert_eq!(fs::read_to_string(fixture.root.join("lock-probe-result")).unwrap(),"0","the application save handler observed a data lock");
    assert!(fixture.child.try_wait().unwrap().is_some());
    assert!(fixture.root.join("saved").is_file());
}

#[test]
fn worker_preserves_an_application_that_refuses_saving() {
    let mut fixture = fixture("refuse", &[]);
    let error = stop(&fixture).unwrap_err();
    assert!(error.message.contains("保存"), "{}", error.message);
    assert!(fixture.child.try_wait().unwrap().is_none());
    assert!(fixture.root.join("requested").is_file());
    assert!(!fixture.root.join("saved").exists());
}

#[test]
fn worker_rejects_forged_coordination_identity_without_stopping() {
    let mut fixture = fixture("forged", &[]);
    let error = stop(&fixture).unwrap_err();
    assert!(error.message.contains("身份"), "{}", error.message);
    assert!(fixture.child.try_wait().unwrap().is_none());
    assert!(!fixture.root.join("requested").exists());
}

#[test]
fn worker_preserves_backup_and_authorization_helpers() {
    for argument in ["--backup-snapshot-worker", "--backup-recovery-guardian", "--sidekick-process-authorize=fixture"] {
        let mut fixture = fixture("save", &[argument]);
        let error = stop(&fixture).unwrap_err();
        assert!(error.message.contains("工作进程"), "{}", error.message);
        assert!(fixture.child.try_wait().unwrap().is_none());
        assert!(!fixture.root.join("requested").exists());
    }
}

#[test]
fn a_new_uninstall_request_can_retry_a_previous_save_refusal() {
    let mut fixture = fixture("refuse", &[]);
    assert!(stop_with_id(&fixture, "first-save").is_err());
    assert!(fixture.child.try_wait().unwrap().is_none());
    fs::write(fixture.root.join("allow-save"), "ready").unwrap();
    stop_with_id(&fixture, "next-save").unwrap();
    assert!(fixture.root.join("saved").is_file());
    assert!(fixture.child.try_wait().unwrap().is_some());
}

#[test]
fn a_lost_shutdown_reply_does_not_override_a_verified_saving_status() {
    let mut fixture = fixture("lost-reply", &[]);
    let targets = [sidekickai_uninstall_core::normalize_target_path(&fixture.root).unwrap()];
    let applications = capture(&targets, "saving-status").unwrap();
    let error = save_and_wait(&applications, &endpoint().unwrap(), Instant::now() + Duration::from_millis(350), "saving-status", || true).unwrap_err();
    assert!(error.message.contains("保存退出尚未完成"), "{}", error.message);
    assert!(fixture.child.try_wait().unwrap().is_none());
}

#[test]
fn a_lost_shutdown_reply_does_not_hide_a_current_save_refusal() {
    let mut fixture = fixture("lost-refusal", &[]);
    let error = stop(&fixture).unwrap_err();
    assert!(error.message.contains("本次保存"), "{}", error.message);
    assert!(fixture.child.try_wait().unwrap().is_none());
}
