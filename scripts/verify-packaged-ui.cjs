'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

const { chromium } = require('playwright-core')
const asar = require('@electron/asar')
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function packagedIdentity(runtime) {
  const archive = path.join(runtime, 'resources/app.asar')
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString())
  assert.equal(metadata.main, 'out/main/index.cjs')
  return { name: metadata.name, version: metadata.version, main: metadata.main, exeSha256: sha256(path.join(runtime, 'SidekickAI.exe')), asarSha256: sha256(archive) }
}

class Inspector extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id); clearTimeout(request.timer)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      } else this.emit(message.method, message.params)
    })
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Inspector closed')) }
      this.pending.clear()
      this.emit('closed')
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timed out')), 15000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }, { once: true })
    })
    return new Inspector(socket)
  }
  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector command timed out: ${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  event(name, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const listener = value => { clearTimeout(timer); resolve(value) }
      const timer = setTimeout(() => { this.removeListener(name, listener); reject(new Error(`Inspector event timed out: ${name}`)) }, timeout)
      this.once(name, listener)
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  close() { this.socket.close() }
}

function bootstrapExpression(configuration) {
  return `(() => {
    const config = ${JSON.stringify(configuration)};
    const electron = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    const app = electron.app;
    if (!app.isPackaged) throw new Error('Acceptance requires a packaged executable');
    const packagedName = app.getName();
    if (packagedName !== config.packageName) throw new Error('Unexpected packaged application identity: ' + packagedName);
    const state = { isolation: 'main-entry-inspector', packagedName, packageVersion: app.getVersion(), isPackaged: app.isPackaged, pid: process.pid, pathsAtEntry: { appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }, loginCalls: [], locks: [], network: [], nativeInputSuppressed: false, uncaught: [], createdWindows: [] };
    globalThis.__sidekickAcceptance = state;
    const save = () => fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
    app.on('browser-window-created', (_event, window) => { state.createdWindows.push(window.id); save(); });
    for (const directory of [config.appData, config.bootstrap, config.temp, config.logs]) fs.mkdirSync(directory, { recursive: true });
    app.setPath('appData', config.appData);
    const defaultInstalledData = path.join(config.appData, packagedName);
    fs.mkdirSync(defaultInstalledData, { recursive: true });
    app.setPath('userData', defaultInstalledData);
    app.setPath('sessionData', defaultInstalledData);
    app.setPath('temp', config.temp);
    app.setAppLogsPath(config.logs);
    state.isolatedInstalledDefault = defaultInstalledData;
    const lock = app.requestSingleInstanceLock.bind(app);
    app.requestSingleInstanceLock = (...args) => { const acquired = lock(...args); state.locks.push({ userData: app.getPath('userData'), acquired }); save(); return acquired; };
    const childProcess = require('node:child_process');
    const nativeSpawn = childProcess.spawn;
    childProcess.spawn = function(command, args, ...rest) {
      if (Array.isArray(args) && args.some(arg => String(arg).includes('hotkey-host.ps1'))) throw new Error('Acceptance suppresses native hotkey registration');
      return nativeSpawn.call(this, command, args, ...rest);
    };
    const nativeExecFile = childProcess.execFile;
    childProcess.execFile = function(command, args, ...rest) {
      const encoded = Array.isArray(args) ? args.indexOf('-EncodedCommand') : -1;
      if (encoded >= 0) {
        const script = Buffer.from(args[encoded + 1], 'base64').toString('utf16le');
        const request = /-Request '([A-Za-z0-9+/=]+)'/.exec(script);
        const operation = request ? JSON.parse(Buffer.from(request[1], 'base64').toString()).operation : null;
        if (/RunAs/i.test(script) || !['probe', 'inspect'].includes(operation)) {
          throw new Error('Acceptance suppresses startup configuration changes');
        }
      }
      return nativeExecFile.call(this, command, args, ...rest);
    };
    process.execArgv = process.execArgv.filter(arg => !arg.startsWith('--inspect'));
    state.loadFailures = []; state.preloadFailures = [];
    app.on('web-contents-created', (_event, contents) => {
      contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => { state.loadFailures.push({code,description,url,isMainFrame}); save(); });
      contents.on('preload-error', (_event, preload, error) => { state.preloadFailures.push({preload,error:String(error)}); save(); });
    });
    app.setLoginItemSettings = options => { state.loginCalls.push(options); save(); };
    const blockedSession = session => session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => { if (state.network.length < 100) state.network.push({ kind: 'chromium', url: request.url }); save(); callback({ cancel: true }); });
    app.on('session-created', blockedSession);
    const net = require('node:net');
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      const socketPath = typeof options === 'string' && !/^\\d+$/.test(options) ? options : options && typeof options === 'object' ? options.path : null;
      if (socketPath) return connect.apply(this, args);
      if (state.network.length < 100) state.network.push({ kind: 'node-tcp', blocked: true });
      save(); throw new Error('Acceptance offline network boundary');
    };
    electron.globalShortcut.register = () => false;
    electron.globalShortcut.unregister = () => {};
    electron.globalShortcut.unregisterAll = () => {};
    electron.globalShortcut.isRegistered = () => false;
    try {
      const load = require('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
      const hook = load('uiohook-napi');
      const disabledInput = () => {};
      hook.uIOhook.start = disabledInput;
      hook.uIOhook.stop = disabledInput;
      if (hook.uIOhook.start !== disabledInput || hook.uIOhook.stop !== disabledInput) throw new Error('Input suppression was not installed');
      state.keyboardBindingLoaded = true;
      state.nativeInputSuppressed = true;
    } catch (error) { state.keyboardBindingError = String(error); save(); throw error; }
    process.on('uncaughtExceptionMonitor', error => { state.uncaught.push(String(error.stack || error)); save(); });
    process.on('exit', () => { state.exitObserved = true; save(); });
    app.on('ready', () => { state.pathsAtReady = { appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }; save(); });
    save();
    return state;
  })()`
}

async function launch(options, report) {
  const { runtime, label, sandbox, namespace } = options
  const identity = packagedIdentity(runtime)
  const logs = path.join(sandbox, label)
  fs.mkdirSync(logs, { recursive: true })
  const bootstrap = path.join(logs, 'bootstrap-profile')
  const appData = options.appData || path.join(sandbox, 'roaming')
  const stateFile = path.join(logs, 'state.json')
  const environment = { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(sandbox, 'local'), TEMP: path.join(sandbox, 'temp'), TMP: path.join(sandbox, 'temp'), SIDEKICK_TEST_SESSION: namespace, ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/forbidden-development-renderer' }
  for (const key of ['SIDEKICK_DATA_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete environment[key]
  if (options.portable) environment.SIDEKICK_DATA_DIR = path.join(sandbox, 'portable-profile')
  for (const directory of [bootstrap, appData, environment.LOCALAPPDATA, environment.TEMP]) fs.mkdirSync(directory, { recursive: true })
  const log = fs.createWriteStream(path.join(logs, 'process.log'))
  const child = spawn(path.join(runtime, 'SidekickAI.exe'), ['--inspect-brk=0', '--remote-debugging-port=0', `--user-data-dir=${bootstrap}`, '--skip-guide'], { cwd: runtime, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  const lines = new EventEmitter()
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    log.write(bytes)
    output += String(bytes)
    for (const line of output.split(/\r?\n/)) lines.emit('line', line)
  })
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { log.end(); resolve({ code, signal }) }))
  const waitLine = pattern => {
    const current = output.match(pattern)
    if (current) return Promise.resolve(current[1])
    return new Promise((resolve, reject) => {
      const listener = line => { const match = line.match(pattern); if (match) { clearTimeout(timer); lines.removeListener('line', listener); resolve(match[1]) } }
      const timer = setTimeout(() => { lines.removeListener('line', listener); reject(new Error(`Missing debugger endpoint: ${label}`)) }, 20000)
      lines.on('line', listener)
      child.once('exit', () => { clearTimeout(timer); lines.removeListener('line', listener); reject(new Error(`Process exited before debugger endpoint: ${label}`)) })
    })
  }
  let inspector, browser
  let isolated = false
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) { inspector?.close(); return }
    if (!isolated) {
      child.kill()
      await exit
      inspector?.close()
      report.cleanup.push({ label, abortedBeforeIsolation: true, pid: child.pid })
      return
    }
    try { await inspector?.evaluate("require('electron').app.quit()") } catch {}
    inspector?.close()
    const ended = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 10000))])
    if (!ended) { child.kill(); await exit; report.cleanup.push({ label, forced: true, pid: child.pid }) }
    try { await browser?.close() } catch {}
  }
  try {
    inspector = await Inspector.connect(await waitLine(/Debugger listening on (ws:\/\/[^\s]+)/))
    await inspector.send('Runtime.enable')
    await inspector.send('Debugger.enable')
    const paused = inspector.event('Debugger.paused')
    await inspector.send('Runtime.runIfWaitingForDebugger')
    const pause = await paused
    const frame = pause.callFrames[0]
    const script = await inspector.send('Debugger.getScriptSource', { scriptId: frame.location.scriptId })
    const actualEntry = asar.extractFile(path.join(runtime, 'resources/app.asar'), path.normalize(identity.main)).toString()
    assert.equal(crypto.createHash('sha256').update(script.scriptSource).digest('hex'), crypto.createHash('sha256').update(actualEntry).digest('hex'), 'Debugger must pause in the unchanged packaged main entry')
    assert(frame.location.lineNumber < 5, 'Main entry isolation was not established before application initialization')
    const injected = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: bootstrapExpression({ productName: 'SidekickAI', packageName: identity.name, appData, bootstrap, temp: environment.TEMP, logs, stateFile,  }), returnByValue: true })
    assert(!injected.exceptionDetails, JSON.stringify(injected.exceptionDetails))
    assert(injected.result?.value?.isolation === 'main-entry-inspector', 'Isolation bootstrap did not finish')
    assert(injected.result.value.keyboardBindingLoaded && injected.result.value.nativeInputSuppressed, 'Native input was not isolated')
    isolated = true
    await inspector.send('Debugger.resume')
    browser = await chromium.connectOverCDP(await waitLine(/DevTools listening on (ws:\/\/[^\s]+)/), { timeout: 20000, slowMo: 80 })
    const context = browser.contexts()[0]
    await context.setOffline(true)
    await context.tracing.start({ screenshots: true, snapshots: true })
    const captureErrors = page => page.on('pageerror', error => report.pageErrors.push({ label, message: error.message }))
    context.on('page', captureErrors)
    context.pages().forEach(captureErrors)
    const page = await findPage(context, page => page.url().includes('windowId=main') || page.url().endsWith('/index.html'))
    await page.waitForFunction(() => !!window.electron && document.body.innerText.trim().length > 10, null, { timeout: 20000 })
    assert(page.url().startsWith('file:'), `Packaged renderer must use a local file: ${page.url()}`)
    const paths = await inspector.evaluate("({ appData: require('electron').app.getPath('appData'), userData: require('electron').app.getPath('userData'), sessionData: require('electron').app.getPath('sessionData'), isPackaged: require('electron').app.isPackaged, version: require('electron').app.getVersion() })")
    assert.equal(path.resolve(paths.userData).toLowerCase(), path.resolve(options.portable ? environment.SIDEKICK_DATA_DIR : path.join(appData, identity.name)).toLowerCase())
    assert.equal(paths.sessionData, paths.userData)
    assert.equal(paths.version, report.expectedVersion)
    const blockedNode = await inspector.evaluate("(() => { try { new (require('node:net').Socket)().connect({ host: '127.0.0.1', port: 9 }); return false; } catch (error) { return error.message === 'Acceptance offline network boundary'; } })()")
    assert.equal(blockedNode, true)
    assert.equal(await page.evaluate(() => fetch('https://example.invalid/sidekick-offline-probe').then(() => false, () => true)), true)
    assert(!fs.existsSync(path.join(runtime, 'data')), 'No architecture-local data directory may be created')
    await page.screenshot({ path: path.join(logs, 'main.png') })
    report.checks.push({ label, identity, paths, localRenderer: page.url(), visible: true, nodeTcpBlocked: true, allNetworkBlocked: true, isolation: 'Instrumented system paths and side effects; unchanged candidate app bytes' })
    return { child, inspector, browser, context, page, stop, logs, stateFile, identity, paths }
  } catch (error) { await stop(); throw error }
}

async function findPage(context, predicate) {
  for (const page of context.pages()) if (predicate(page)) return page
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { context.removeListener('page', listener); reject(new Error('Expected application page did not open')) }, 20000)
    const inspect = async page => {
      try {
        await page.waitForURL(url => predicate({ url: () => url.toString() }), { waitUntil: 'domcontentloaded', timeout: 20000 })
        clearTimeout(timer); context.removeListener('page', listener); resolve(page)
      } catch {}
    }
    const listener = page => { void inspect(page) }
    context.on('page', listener)
    for (const page of context.pages()) void inspect(page)
  })
}


async function verifyPackagedUi(runtime, output) {
  require('./check-node-version.cjs').assertNodeVersion()
  assert(runtime && output, 'Usage: verify-packaged-ui.cjs <unpacked-directory> <new-evidence-directory>')
  runtime = path.resolve(runtime)
  const sandbox = path.resolve(output), label = 'application'
  assert(!fs.existsSync(sandbox), 'Evidence output already exists')
  const portable = fs.existsSync(path.join(runtime, 'portable.txt'))
  const relative = path.relative(runtime, sandbox)
  assert(relative.startsWith('..') || path.isAbsolute(relative), 'Evidence must be outside the application directory')
  const before = packagedIdentity(runtime)
  fs.mkdirSync(sandbox, { recursive: true })
  const report={expectedVersion:before.version,checks:[],cleanup:[],pageErrors:[],limitations:['Actual x64 packaged application with isolated paths, blocked network, and suppressed OS hotkeys, native hooks and login startup writes.','No real installation, UAC, physical input, games or ARM64 execution.']};
  let instance;
  try {
    instance=await launch({runtime,label,sandbox,namespace:sandbox, portable},report);
    if(instance) {
      const page=instance.page;
      report.main=await page.evaluate(()=>({url:location.href,text:document.body.innerText,preload:!!window.electron,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,name:b.getAttribute('data-name')}))}));
      const consent=page.getByRole('button',{name:'不共享并继续',exact:true});
      if(await consent.isVisible()) await consent.click();
      await page.locator('[data-dom-id="aw-main-bottom-handle"]').click();
      await page.locator('[data-name="main.bottom-bar.settings-button"]').click();
      const settings=await findPage(instance.context,p=>p.url().includes('windowId=settings'));
      await settings.waitForFunction(()=>!!window.electron&&document.body.innerText.length>30);
      report.settings=await settings.evaluate(()=>({url:location.href,text:document.body.innerText,preload:!!window.electron}));
      await settings.screenshot({path:path.join(instance.logs,'settings.png')});
      await page.screenshot({path:path.join(instance.logs,'main.png')});
      report.state=await instance.inspector.evaluate('globalThis.__sidekickAcceptance');
      assert.deepEqual(report.state.loadFailures,[]);
      assert.deepEqual(report.state.preloadFailures,[]);
      assert.deepEqual(report.state.uncaught,[]);
      assert.deepEqual(report.pageErrors,[]);
      await instance.context.tracing.stop({path:path.join(instance.logs,'trace.zip')});
      report.passed=true;
    }
  } catch(error) { report.error=String(error.stack||error); }
  finally {
    if(instance) await instance.stop();
    try { assert.deepEqual(packagedIdentity(runtime), before) } catch(error) { report.error=String(error); report.passed=false }
    if (report.cleanup.some(item => item.forced)) { report.error='Application did not exit normally'; report.passed=false }
    const stateFile = path.join(sandbox, label, 'state.json')
    if (fs.existsSync(stateFile)) report.state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    fs.writeFileSync(path.join(sandbox,'report.json'),JSON.stringify(report,null,2));

  }
  if (!report.passed || report.error) throw new Error(`Packaged UI verification failed: ${report.error}; evidence: ${sandbox}`)
  return { report: path.join(sandbox, 'report.json'), identity: before, passed: true }
}
module.exports = { verifyPackagedUi, bootstrapExpression }
if (require.main === module) verifyPackagedUi(...process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
