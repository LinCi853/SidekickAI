'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const probe = require('./probe-native-ui.cjs')

test('the installation gate is an explicit CLI option and is not sent to the application', () => {
  assert.deepEqual(probe.parseCommandLineArguments(['C:/Setup.exe', 'wizard', '--installer-ready']),
    { exe: 'C:/Setup.exe', title: 'wizard', appArgs: [], requireInstallerReady: true })
})

function scenario(ready, body = 'Welcome installation') {
  let samples = 0
  let terminated = false
  const image = 'C:/isolated-probe/Setup.exe'
  const dependencies = {
    prepareFixture: () => ({ directory: 'C:/isolated-probe', exe: image, sha256: 'a'.repeat(64), webviewDataDir: 'C:/isolated-probe/webview' }),
    removeFixture: () => {},
    operationRoot: () => 'C:/isolated-probe/operations',
    readdir: () => [],
    spawn: () => { terminated = false; return { pid: 1234, on() {}, unref() {} } },
    listProcesses: () => terminated ? [] : [{ processId: 1234, parentProcessId: 1, executablePath: image, creationDate: '1000' }],
    terminate: () => { terminated = true },
    getJson: async () => { samples++; return JSON.stringify([{ type: 'page', url: 'http://tauri.localhost/', title: 'Installer wizard', webSocketDebuggerUrl: 'ws://127.0.0.1:1/page' }]) },
    evaluate: async (_url, expression) => expression.includes('window.installer') ? ready(samples) : expression.includes('body') ? body : 42,
    sleep: async () => {},
  }
  return { image, dependencies, samples: () => samples }
}

test('installation readiness rejects mounted initialization failures and loading pages', async () => {
  for (const body of ['Installation initialization failed: incompatible metadata', 'Loading installation settings']) {
    const fixture = scenario(() => false, body)
    const options = { dependencies: fixture.dependencies, expectedTitle: /wizard/, timeoutSeconds: 2 }
    const report = await probe.probeNativeUi(fixture.image, { ...options, requireInstallerReady: true })
    assert.equal(report.ok, false)
    assert.equal(report.mountedRoot, true)
    assert.equal(report.installerReady, false)
    assert.equal(report.cleanup.leaked, 0)
    assert.equal((await probe.probeNativeUi(fixture.image, options)).ok, true)
  }
})

test('installation readiness waits for initialized welcome controls and a usable primary command', async () => {
  const fixture = scenario(samples => samples >= 3)
  const report = await probe.probeNativeUi(fixture.image, { dependencies: fixture.dependencies,
    expectedTitle: /wizard/, timeoutSeconds: 4, requireInstallerReady: true })
  assert.equal(report.ok, true)
  assert.equal(report.installerReady, true)
  assert.equal(fixture.samples(), 3)
  assert.equal(report.cleanup.leaked, 0)
})
