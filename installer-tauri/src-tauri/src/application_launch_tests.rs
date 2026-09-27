use super::*;
use std::io::{BufRead, BufReader};

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
    socket.end(JSON.stringify({protocol:1,edition,version,executable:behavior === 'wrong-path' ? 'E:/unrelated/SidekickAI.exe' : process.execPath,pid:process.pid,status}) + '\n', () => {
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
            wait_for_exit(&pipe, std::slice::from_ref(&app), Duration::from_secs(12)).unwrap();
            assert!(app.exited());
        }
    }
}

#[test]
fn installation_completion_preserves_busy_or_unsaved_owners() {
    for behavior in ["busy", "save-refused", "wrong-path"] {
        let (_probe, pipe, app) = owner("community", "0.1.0-beta.4", behavior);
        assert!(wait_for_exit(&pipe, std::slice::from_ref(&app), Duration::from_secs(8)).is_err());
        assert!(!app.exited());
    }
}

#[test]
fn no_running_owner_needs_no_shutdown() {
    assert!(wait_for_exit("unused", &[], Duration::ZERO).is_ok());
}
