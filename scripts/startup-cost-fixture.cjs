// 启动成本拆解夹具：仅用于隔离诊断，不作为产品容量或交互验收。
const { app, BrowserWindow, webContents, globalShortcut, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const mode = process.env.SIDEKICK_STARTUP_COST_MODE
const destination = process.env.SIDEKICK_STARTUP_COST_TELEMETRY
const product = mode.startsWith('product-')
const styleExperiment = process.env.SIDEKICK_STARTUP_COST_STYLE || null
const helpCycle = process.env.SIDEKICK_STARTUP_COST_HELP_CYCLE === '1'
const styles = {
  'legacy-shortcuts': '.shortcuts-overlay:not(.is-open){visibility:visible!important}',
  'closed-panels': '.drawer-panel:not(.active),.drawer-overlay:not(.active),.shortcuts-overlay:not(.is-open){display:none!important}',
  'drawer-only': '.drawer-panel:not(.active),.drawer-overlay:not(.active){display:none!important}',
  'shortcuts-only': '.shortcuts-overlay:not(.is-open){display:none!important}',
  'closed-visibility': '.drawer-panel:not(.active),.drawer-overlay:not(.active),.shortcuts-overlay:not(.is-open){visibility:hidden!important}',
  'no-effects': '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;box-shadow:none!important;text-shadow:none!important}',
  'no-paint': 'body{display:none!important}',
}
const state = { pid: process.pid, mode, startedAt: Date.now(), readyAt: null, closingAt: null, preventedGuests: 0, replacedShells: 0, styleExperiment, stylesApplied: 0, helpCycle, helpCycleCompletedAt: null, errors: [] }
app.setAppPath(root)
app.setPath('userData', process.env.SIDEKICK_DATA_DIR)
app.setPath('sessionData', process.env.SIDEKICK_DATA_DIR)
app.setLoginItemSettings = () => {}
// 不抢占用户快捷键；本夹具不验证快捷键或呼出耗时。
const registrations = new Set()
globalShortcut.register = key => { registrations.add(key); return true }
globalShortcut.isRegistered = key => registrations.has(key)
globalShortcut.unregister = key => registrations.delete(key)
globalShortcut.unregisterAll = () => registrations.clear()
const snapshot = () => {
  const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed())
  const guests = webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getType() === 'webview')
  const data = { ...state, at: Date.now(), metrics: app.getAppMetrics(), mainMemory: process.memoryUsage(),
    windows: windows.map(win => ({ id: win.id, visible: win.isVisible(), url: win.webContents.getURL(), bounds: win.getBounds() })),
    guests: guests.map(contents => ({ id: contents.id, url: contents.getURL(), loading: contents.isLoading() })) }
  fs.writeFileSync(destination + '.tmp', JSON.stringify(data))
  fs.renameSync(destination + '.tmp', destination)
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => { state.errors.push({ type: 'renderer-exit', details }); snapshot() })
  if (mode === 'product-shell') contents.on('will-attach-webview', event => { event.preventDefault(); state.preventedGuests++ })
  if (styleExperiment && contents.getType() === 'window') contents.once('dom-ready', () => {
    void contents.insertCSS(styles[styleExperiment]).then(() => { state.stylesApplied++ }).catch(error => state.errors.push({ type: 'style', error: String(error) }))
  })
})
if (mode === 'product-services') app.on('browser-window-created', (_event, win) => {
  const loadFile = win.loadFile.bind(win)
  const loadURL = win.loadURL.bind(win)
  win.loadFile = (file, options) => {
    if (options?.query?.windowId !== 'main' || options.query.mode) return loadFile(file, options)
    state.replacedShells++
    return loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Product service diagnostic</title><body>Startup services</body>'))
  }
})
app.on('before-quit', () => { state.closingAt ??= Date.now(); snapshot() })
process.on('uncaughtException', error => { state.errors.push({ type: 'uncaught', error: String(error) }); snapshot(); app.exit(1) })
if (product) {
  require(path.join(root, 'out/main/index.cjs'))
} else {
  // 与当前 electron/main.ts 使用相同的 Windows Chromium 开关。
  for (const [name, value] of [['disable-crashpad'], ['disable-gpu-sandbox'], ['force-gpu-mem-available-mb', '256'], ['js-flags', '--expose-gc'], ['disable-features', 'RestrictGamepadAccess']]) app.commandLine.appendSwitch(name, value)
}
app.whenReady().then(async () => {
  if (!product && mode !== 'engine') {
    if (mode === 'window-preload') ipcMain.handle('winControl:isMaximized', () => false)
    const win = new BrowserWindow({ width: 420, height: 820, frame: false, thickFrame: false, roundedCorners: false,
      backgroundMaterial: 'none', hasShadow: true, show: false, resizable: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true,
        webviewTag: true, additionalArguments: ['--enable-features=OverlayScrollbar'],
        ...(mode === 'window-preload' ? { preload: path.join(root, 'out/preload/index.cjs') } : {}) } })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><title>Startup cost</title></head><body>Startup cost diagnostic</body></html>'))
    win.show()
  }
  let cyclingHelp = false
  const timer = setInterval(async () => {
    if (fs.existsSync(destination + '.stop')) { clearInterval(timer); app.quit(); return }
    if (!state.readyAt) {
      const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.isVisible() && (!product || mode === 'product-services' || win.webContents.getURL().includes('windowId=main')))
      const guests = webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getType() === 'webview')
      if ((!styleExperiment || state.stylesApplied > 0) && (mode === 'engine' || (win && !win.webContents.isLoading() &&
        (mode === 'product-page' ? guests.some(contents => !contents.isLoading() && /^https?:/.test(contents.getURL())) : mode !== 'product-shell' || state.preventedGuests > 0)))) {
        if (!helpCycle || state.helpCycleCompletedAt) state.readyAt = Date.now()
        else if (!cyclingHelp) {
          cyclingHelp = true
          void win.webContents.executeJavaScript(`(async () => {
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
            const wait = async predicate => {
              const deadline = Date.now() + 4000
              while (!predicate()) { if (Date.now() > deadline) throw new Error('Help cycle timed out'); await pause(25) }
            }
            const select = name => document.querySelector('[data-name="' + name + '"]')
            document.querySelector('[data-dom-id="aw-main-menu-btn"]').click()
            await wait(() => select('component.drawer-panel.item-shortcuts'))
            select('component.drawer-panel.item-shortcuts').click()
            await wait(() => { const node = select('component.shortcuts-modal.overlay'); return node?.classList.contains('is-open') && getComputedStyle(node).opacity === '1' })
            await pause(500)
            select('component.shortcuts-modal.close-button').click()
            await wait(() => { const node = select('component.shortcuts-modal.overlay'); return !node?.classList.contains('is-open') && getComputedStyle(node).opacity === '0' })
            return { closedVisibility: getComputedStyle(select('component.shortcuts-modal.overlay')).visibility }
          })()`).then(result => { state.helpCycleResult = result; state.helpCycleCompletedAt = Date.now() }).catch(error => { state.errors.push({ type: 'help-cycle', error: String(error) }); snapshot(); app.exit(1) })
        }
      }
    }
    snapshot()
  }, 250)
  app.once('will-quit', () => clearInterval(timer))
  snapshot()
}).catch(error => { state.errors.push({ type: 'startup', error: String(error) }); snapshot(); app.exit(1) })
setTimeout(() => app.exit(1), 60000).unref()
