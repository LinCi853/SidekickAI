const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

async function verify(peer) {
  const root = path.resolve(__dirname, '..')
  peer = path.resolve(peer)
  const evidence = fs.mkdtempSync(path.join(root, 'build/edition-session-'))
  const children = []
  const runtimes = new Map()
  for (const [index, workspace] of [root, peer].entries()) {
    const edition = JSON.parse(fs.readFileSync(path.join(workspace, 'product-edition.json'))).edition
    const bundle = path.join(evidence, `runtime-${index}.cjs`)
    esbuild.buildSync({ entryPoints: [path.join(workspace, 'electron/edition-runtime.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    runtimes.set(edition, { edition, bundle, workspace })
  }
  assert.equal(runtimes.size, 2)
  const bootstrap = path.join(evidence, 'host.cjs')
  fs.writeFileSync(bootstrap, `
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const config = JSON.parse(process.env.EDITION_FIXTURE);
fs.mkdirSync(config.profile, { recursive: true });
app.setName('SidekickAI');
app.setPath('userData', config.profile);
app.setPath('sessionData', config.profile);
dialog.showErrorBox = (title, detail) => console.error(title, detail);
if (!app.requestSingleInstanceLock()) app.exit(0);
else app.whenReady().then(async () => {
  const runtime = require(config.bundle);
  if (!await runtime.startEditionSession(config.edition, () => false)) return;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html,<p>Isolated edition verification</p>');
  await window.webContents.executeJavaScript('window.addEventListener("sidekick:before-handoff",()=>{document.body.dataset.saved="true"})');
  app.on('before-quit', () => fs.writeFileSync(config.saved, 'saved'));
  runtime.markEditionReady();
  fs.writeFileSync(config.profile + '/sentinel.txt', config.edition);
  console.log('ready');
  const timer = setInterval(() => { if (fs.existsSync(config.release)) { clearInterval(timer); app.quit(); } }, 50);
  setTimeout(() => app.exit(2), 45000).unref();
}).catch(error => { console.error(error); app.exit(1); });
`)
  async function wait(check) {
    const deadline = Date.now() + 15000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Isolated runtime verification timed out')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  async function launch(edition, label) {
    const config = { ...runtimes.get(edition), profile: path.join(evidence, label), saved: path.join(evidence, `${label}.saved`), release: path.join(evidence, `${label}.release`) }
    const env = { ...process.env, SIDEKICK_TEST_SESSION: evidence, EDITION_FIXTURE: JSON.stringify(config) }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    const child = spawn(require('electron'), [bootstrap], { cwd: config.workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = { child, ...config, output: '' }
    children.push(result)
    child.stdout.on('data', bytes => { result.output += bytes.toString() })
    child.stderr.on('data', bytes => fs.appendFileSync(path.join(evidence, `${label}.log`), bytes))
    await wait(() => result.output.includes('ready') || child.exitCode !== null)
    return result
  }
  try {
    const concept = await launch('concept', 'concept-first')
    assert.match(concept.output, /ready/)
    const community = await launch('community', 'community-takeover')
    assert.match(community.output, /ready/)
    await wait(() => concept.child.exitCode !== null)
    assert.equal(concept.child.exitCode, 0)
    assert.equal(fs.readFileSync(concept.saved, 'utf8'), 'saved')
    const redirect = await launch('concept', 'concept-redirected')
    assert.equal(redirect.child.exitCode, 0)
    assert.equal(redirect.output.includes('ready'), false)
    assert.equal(community.child.exitCode, null)
    assert.equal(fs.existsSync(path.join(redirect.profile, 'sentinel.txt')), false)
    const duplicate = await launch('community', 'community-redirected')
    assert.equal(duplicate.child.exitCode, 0)
    assert.equal(duplicate.output.includes('ready'), false)
    for (const instance of [concept, community]) assert.equal(fs.readFileSync(path.join(instance.profile, 'sentinel.txt'), 'utf8'), instance.edition)
    fs.writeFileSync(community.release, '')
    await wait(() => community.child.exitCode !== null)
    const report = { ok: true, evidence, checks: ['concept saves and exits before community becomes ready', 'concept launch activates community without opening another window', 'separate community data root cannot create another main instance', 'both edition data sentinels preserved'] }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    for (const { child, release } of children) if (child.exitCode === null) fs.writeFileSync(release, '')
    await wait(() => children.every(({ child }) => child.exitCode !== null)).catch(() => { for (const { child } of children) if (child.exitCode === null) child.kill() })
  }
}

if (!process.argv[2]) throw new Error('Usage: verify-edition-coexistence.cjs <peer-workspace>')
verify(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
