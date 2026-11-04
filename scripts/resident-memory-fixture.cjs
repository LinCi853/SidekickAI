const { app, BrowserWindow, webContents, globalShortcut } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
app.setAppPath(root)
app.setLoginItemSettings = () => {}
const callbacks = new Map()
const registrations = new Map()
const register = globalShortcut.register.bind(globalShortcut)
globalShortcut.register = (accelerator, callback) => { const ok = register(accelerator, callback); callbacks.set(accelerator, callback); registrations.set(accelerator, ok); return ok }
// Diagnostic only: distinguish a stale hidden render widget from a failed
// native activation. Restore ordinary throttling as soon as focus is lost.
if (process.env.SIDEKICK_MEMORY_FOREGROUND_DRAWING === '1') {
 app.on('browser-window-created', (_event, win) => {
  const update = () => {
   if (win.isDestroyed() || win.webContents.isDestroyed()) return
   win.webContents.setBackgroundThrottling(!(win.isVisible() && !win.isMinimized() && win.isFocused()))
  }
  for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(event, update)
  update()
 })
}
require(path.join(root, 'out/main/index.cjs'))
const observations = [], interactions = [], paintTrace = []
const reclaimFlow = process.env.SIDEKICK_MEMORY_RECLAIM_FLOW === '1'
const gpuDiagnostics = process.env.SIDEKICK_MEMORY_GPU_DIAGNOSTICS === '1'
let startupDiagnostics
const flow = reclaimFlow ? { phase: 'starting', startedAt: Date.now(), checks: [] } : undefined
const tracedWindows = new WeakSet()
const traceWindow = win => {
 if (process.env.SIDEKICK_MEMORY_TRACE_PAINT !== '1' || tracedWindows.has(win)) return
 tracedWindows.add(win)
 const record = event => paintTrace.push({ at: Date.now(), event, visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), backgroundThrottling: win.webContents.getBackgroundThrottling() })
 for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(event, () => record(event))
 for (const method of ['show', 'hide', 'minimize', 'restore', 'focus', 'setSkipTaskbar']) {
  const original = win[method].bind(win)
  win[method] = (...args) => { record(method + '()'); return original(...args) }
 }
}
let busy = false
let identity
let closingAt
const snapshot = () => {
 const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
 const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview')
 const diagnostics = app.__residentMemoryDiagnostics?.()
 const metrics = app.getAppMetrics()
 const inventory = { windows: windows.length, guests: guests.length, renderers: metrics.filter(metric => metric.type === 'Tab').length,
  browserWindows: windows.filter(w => new URL(w.webContents.getURL() || 'about:blank').searchParams.get('mode') === 'browser').length }
 observations.push({ at: Date.now(), mainMemory: process.memoryUsage(), metrics, inventory, guestIds: guests.map(g => g.id), resident: diagnostics ? { ...diagnostics, samples: diagnostics.samples.slice(-1) } : null })
 fs.writeFileSync(process.env.SIDEKICK_MEMORY_EVIDENCE, JSON.stringify({ observations, interactions, paintTrace, flow, startupDiagnostics, closingAt }))
}
const finish = () => { if (closingAt) return; closingAt = Date.now(); snapshot(); app.quit() }
app.whenReady().then(() => {
 const configure = async () => {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('windowId=main'))
  if (!win) { setTimeout(configure, 500); return }
  traceWindow(win)
  if (process.env.SIDEKICK_MEMORY_HIDE_ONLY === '1') win.minimize = () => {}
  try {
   await win.webContents.executeJavaScript('window.electron.appSettings.update({ lowMemoryMode: ' + (process.env.SIDEKICK_RESIDENT_RECLAIM !== '0') + ' })')
   const guest = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getType() === 'webview' && !w.isLoading() && /^https?:/.test(w.getURL()))
   if (!guest) { setTimeout(configure, 500); return }
   if (process.env.SIDEKICK_MEMORY_TRACE_PAINT === '1') {
    const observe = 'window.__sidekickVisibilityHistory = []; document.addEventListener("visibilitychange", () => window.__sidekickVisibilityHistory.push({ at: Date.now(), state: document.visibilityState }))'
    await Promise.all([win.webContents.executeJavaScript(observe), guest.executeJavaScript(observe)])
   }
   identity = { guestId: guest.id, guestToken: await guest.executeJavaScript('window.__sidekickMemoryToken = crypto.randomUUID()'), shellToken: await win.webContents.executeJavaScript('window.__sidekickMemoryToken = crypto.randomUUID()') }
   if (gpuDiagnostics && !startupDiagnostics) {
    const describe = '({url:location.href,heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,canvases:[...document.querySelectorAll("canvas")].map(c=>({width:c.width,height:c.height})),videos:document.querySelectorAll("video").length,animations:document.getAnimations().filter(a=>a.playState==="running").length})'
    startupDiagnostics = { at: Date.now(), featureStatus: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete'),
     shell: await win.webContents.executeJavaScript(describe), guest: await guest.executeJavaScript(describe), bounds: win.getBounds() }
   }
  }
  catch { setTimeout(configure, 500) }
 }
 void configure()
 setInterval(snapshot, 5000)
 const interact = async () => {
  if (busy) return
  const guest = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getType() === 'webview')
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('windowId=main'))
  const toggle = callbacks.get('Alt+Space')
  if (!guest || !win || !toggle || !identity) return
  busy = true
  const start = Date.now()
  try {
   if (guest.id !== identity.guestId || await guest.executeJavaScript('window.__sidekickMemoryToken') !== identity.guestToken) throw new Error('Webpage was replaced or reloaded')
   if (await win.webContents.executeJavaScript('window.__sidekickMemoryToken') !== identity.shellToken) throw new Error('Application renderer reloaded')
   guest.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: 100, deltaX: 0, canScroll: true })
   await guest.executeJavaScript('document.body.offsetHeight')
   const inputMs = Date.now() - start
   const focusStart = Date.now()
   // The production shortcut focuses a visible background window on its
   // first press. Establish that state before testing the separate hide
   // press; otherwise an unrelated desktop focus change looks like failure.
   if (win.isVisible() && !win.isFocused()) {
    await toggle()
    while (!win.isFocused()) {
     if (Date.now() - focusStart >= 2000) throw new Error('Visible window did not focus before the hide check')
     await new Promise(resolve => setTimeout(resolve, 5))
    }
   }
   const focusPreparationMs = Date.now() - focusStart
   if (win.isVisible()) await toggle()
   const hidden = !win.isVisible()
   await new Promise(resolve => setTimeout(resolve, 1000))
   const wake = Date.now(); await toggle()
   if (process.env.SIDEKICK_MEMORY_PAINT_ACTION || process.env.SIDEKICK_MEMORY_FORCE_RESTORE === '1') {
    await new Promise(resolve => setTimeout(resolve, 100))
    const action = process.env.SIDEKICK_MEMORY_PAINT_ACTION || 'restore-show'
    if (action === 'restore-show') { win.restore(); win.show(); win.focus() }
    if (action === 'restore') win.restore()
    if (action === 'show') { win.show(); win.focus() }
    if (action === 'show-only') win.show()
    if (action === 'focus-only') win.focus()
    if (action === 'unthrottle') win.webContents.setBackgroundThrottling(false)
    if (action === 'invalidate') win.webContents.invalidate()
   }
   // The registered shortcut dispatches an asynchronous foreground capture.
   // Start the frame probe after native show/focus, still inside the same 2 s
   // deadline; a renderer remaining hidden is a failure, not a retry/re-show.
   while (!win.isVisible() || !win.isFocused()) {
    if (Date.now() - wake >= 2000) throw new Error('Window did not become visible and focused within 2 seconds')
    await new Promise(resolve => setTimeout(resolve, 5))
   }
   await win.webContents.executeJavaScript('document.body.offsetHeight')
   await guest.executeJavaScript('document.body.offsetHeight')
   const wakeMs = Date.now() - wake
   let frameTimeout
   const frameScript = 'new Promise(resolve => { const probe = window.__sidekickPaintProbe = { startVisibility: document.visibilityState, visibility: document.visibilityState, steps: 0 }; requestAnimationFrame(() => { probe.steps = 1; requestAnimationFrame(() => { probe.steps = 2; probe.visibility = document.visibilityState; resolve(probe) }) }) })'
   let frames
   try {
    frames = await Promise.race([
     Promise.all([win.webContents.executeJavaScript(frameScript), guest.executeJavaScript(frameScript)]),
     new Promise((_, reject) => { frameTimeout = setTimeout(() => reject(new Error('Visible renderer did not deliver animation frames within 2 seconds')), Math.max(0, 2000 - (Date.now() - wake))) }),
    ])
   } finally { clearTimeout(frameTimeout) }
   const frameRoundtripMs = Date.now() - wake
   if (frames.some(frame => frame.visibility !== 'visible')) throw new Error('Renderer or webpage remained hidden after wake')
   if (await guest.executeJavaScript('window.__sidekickMemoryToken') !== identity.guestToken) throw new Error('Webpage reloaded while waking')
   interactions.push({ at: Date.now(), inputMs, focusPreparationMs, wakeMs, frameRoundtripMs, frames, guestId: guest.id, hidden, visible: win.isVisible(), shortcutCallback: true, shortcutRegistered: registrations.get('Alt+Space'), identity })
  } catch (error) {
   const failure = { at: Date.now(), error: String(error), window: { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds(), backgroundThrottling: win.webContents.getBackgroundThrottling() } }
   const stateScript = '({ visibility: document.visibilityState, focus: document.hasFocus(), ready: document.readyState, width: innerWidth, height: innerHeight, probe: window.__sidekickPaintProbe, visibilityHistory: window.__sidekickVisibilityHistory?.slice(-20), webviews: [...document.querySelectorAll("webview")].map(w => ({ rect: w.getBoundingClientRect().toJSON(), display: getComputedStyle(w).display, visibility: getComputedStyle(w).visibility })) })'
   try { failure.contents = await Promise.all([win.webContents.executeJavaScript(stateScript), guest.executeJavaScript(stateScript)]) } catch {}
   if (process.env.SIDEKICK_MEMORY_CAPTURE_FAILURE === '1') {
    try { fs.writeFileSync(path.join(path.dirname(process.env.SIDEKICK_MEMORY_EVIDENCE), 'paint-failure-' + interactions.length + '.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
   }
   interactions.push(failure)
  }
  finally { busy = false }
  snapshot()
 }
 if (reclaimFlow) {
  // Exercise the real monitor and native idle checks. Diagnostic polling and
  // the overall test deadline are shortened; production hotkey arbitration,
  // idle/cooldown/retirement clocks keep their original values.
  setInterval(async () => {
   if (busy) return
   if (flow.phase === 'starting') {
    if (!identity) return
    flow.phase = 'initial-interaction'
    await interact()
    if (!interactions.length || interactions.at(-1).error) { flow.phase = 'failed'; finish(); return }
    flow.idleStartedAt = Date.now()
    flow.phase = 'waiting-for-reclaim'
   } else if (flow.phase === 'waiting-for-reclaim') {
    const actions = app.__residentMemoryDiagnostics?.().actions ?? []
    const reclaimed = actions.filter(action => action.result && action.at >= flow.idleStartedAt)
    if (!reclaimed.length) return
    flow.reclaims = reclaimed
    flow.checks.push('real idle policy and native working-set reclaim completed')
    flow.phase = 'resume-interaction'
    await interact()
    flow.phase = interactions.at(-1)?.error ? 'failed' : 'complete'
    if (flow.phase === 'complete') flow.checks.push('same shell and webpage resumed and delivered double-rAF after reclaim')
    flow.completedAt = Date.now()
    snapshot()
    setTimeout(finish, 1000)
   }
  }, 250)
 } else {
  setInterval(interact, Number(process.env.SIDEKICK_MEMORY_INTERACTION_MS || 45000))
 }
 setTimeout(finish, Number(process.env.SIDEKICK_MEMORY_DURATION || 300000))
})
