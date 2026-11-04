// Production detach entry and retained webpages, without CDP/screencast capture.
const { app, BrowserWindow, ipcMain, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
const loadingPeerEnabled = process.env.SIDEKICK_MEMORY_LOADING_PEER === '1'
app.setAppPath(root)
app.setLoginItemSettings = () => {}
require(path.join(root, 'out/main/index.cjs'))

const observations = [], interactions = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let phase = 'constructing', readyAt, identities = [], timer, server, failure, closingAt, inputTimer, activeInput, interacting = false
let loadingPeer, pendingResources = [], peerNavigation
const browserWindows = () => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && new URL(win.webContents.getURL() || 'about:blank').searchParams.get('mode') === 'browser')
const guestFor = win => webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getType() === 'webview' && wc.hostWebContents === win.webContents)
function snapshot() {
 const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()), browsers = browserWindows()
 const guests = webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc.getType() === 'webview')
 const resident = app.__residentMemoryDiagnostics?.()
 observations.push({ at: Date.now(), metrics: app.getAppMetrics(), resident: resident ? { ...resident, samples: resident.samples.slice(-1) } : null,
  inventory: { windows: windows.length, browserWindows: browsers.length, guests: guests.length, browserGuests: browsers.filter(win => guestFor(win)).length, readyBrowserWindows: browsers.filter(win => { const guest = guestFor(win); return guest && !guest.isLoading() && /^https?:/.test(guest.getURL()) }).length },
  phase, windowBounds: browsers.map(win => ({ id: win.id, bounds: win.getBounds(), maximized: win.isMaximized() })) })
 if (loadingPeer && !closingAt) {
  const guest = webContents.fromId(loadingPeer.guestId)
  loadingPeer.samples++
  if (guest && !guest.isDestroyed() && guest.isLoading()) loadingPeer.loadingSamples++
 }
 fs.writeFileSync(process.env.SIDEKICK_MEMORY_EVIDENCE, JSON.stringify({ observations, interactions, readyAt, identities, failure, closingAt, activeInput, loadingPeer }))
}
async function until(predicate, description, milliseconds = 30000) {
 const deadline = Date.now() + milliseconds
 while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(100) }
 throw new Error('Timed out: ' + description)
}
async function frames(win, guest, identity) {
 const script = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ visibility: document.visibilityState, token: window.__residentBrowserToken }))))'
 let timeout
 try {
  const result = await Promise.race([Promise.all([win.webContents.executeJavaScript(script), guest.executeJavaScript(script)]),
   new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser did not deliver visible frames within 2 seconds')), 2000) })])
  if (result.some(value => value.visibility !== 'visible') || result[0].token !== identity.shellToken || result[1].token !== identity.guestToken) throw new Error('Browser visibility or session identity changed')
  return result
 } finally { clearTimeout(timeout) }
}
async function interact() {
 interacting = true
 for (const identity of identities) {
  const win = BrowserWindow.fromId(identity.windowId), guest = webContents.fromId(identity.guestId)
  const started = Date.now()
  try {
   if (!win || win.isDestroyed() || !guest || guest.isDestroyed() || guest.hostWebContents !== win.webContents) throw new Error('Browser or webpage disappeared')
   win.show(); win.focus()
   await frames(win, guest, identity)
   const frameRoundtripMs = Date.now() - started
   await guest.executeJavaScript('window.scrollTo(0, 0)')
   await frames(win, guest, identity)
   const button = await guest.executeJavaScript('(() => { const rect = document.querySelector("button").getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()')
   // Update Chromium's hover/hit-test target before injecting a button/wheel.
   // Real pointer input has this move; forwarding a wheel alone can deliver a
   // DOM event without establishing the compositor's scroll target.
   guest.sendInputEvent({ type: 'mouseMove', ...button })
   await frames(win, guest, identity)
   guest.sendInputEvent({ type: 'mouseDown', ...button, button: 'left', clickCount: 1 })
   guest.sendInputEvent({ type: 'mouseUp', ...button, button: 'left', clickCount: 1 })
   await frames(win, guest, identity)
   // Electron's wheel sign differs from DOM wheel conventions. Start away
   // from either edge and require real displacement, in either direction.
   const scrollBefore = await guest.executeJavaScript('window.scrollTo(0, 400); scrollY')
   await frames(win, guest, identity)
   guest.sendInputEvent({ type: 'mouseMove', x: 100, y: 100 })
   await frames(win, guest, identity)
   const inputStarted = Date.now()
   guest.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: 100, deltaX: 0, wheelTicksY: 1, hasPreciseScrollingDeltas: true, canScroll: true })
   const result = await frames(win, guest, identity)
   const state = await guest.executeJavaScript('new Promise(resolve => { const deadline = performance.now() + 1000; const inspect = () => { const state = { draft: document.querySelector("textarea").value, clicks: window.clicks, wheels: window.wheels, deltaY: window.lastDeltaY, scrollY, scrollHeight: document.scrollingElement.scrollHeight, clientHeight: document.scrollingElement.clientHeight }; if ((state.wheels > 0 && state.scrollY !== ' + scrollBefore + ') || performance.now() >= deadline) resolve(state); else requestAnimationFrame(inspect) }; inspect() })')
   if (state.draft !== identity.draft) throw new Error('Webpage draft was lost')
   if (state.clicks !== identity.clicks + 1) throw new Error('Native click was not delivered or page state was lost: ' + JSON.stringify({ expected: identity.clicks + 1, state }))
   if (state.wheels !== identity.clicks + 1 || state.scrollY === scrollBefore) throw new Error('Native wheel did not scroll the page: ' + JSON.stringify({ scrollBefore, state }))
   identity.clicks = state.clicks
   interactions.push({ at: Date.now(), windowId: win.id, guestId: guest.id, visible: win.isVisible(), frames: result, clicks: state.clicks, wheels: state.wheels, scrollBefore, scrollY: state.scrollY, deltaY: state.deltaY, frameRoundtripMs, wheelToScrollMs: Date.now() - inputStarted, interactionMs: Date.now() - started, phase })
  } catch (error) {
   interactions.push({ at: Date.now(), windowId: identity.windowId, error: String(error), visible: win && !win.isDestroyed() && win.isVisible(), phase })
  }
 }
 snapshot()
 interacting = false
}
async function close(code) {
 if (closingAt) return
 closingAt = Date.now()
 clearInterval(timer)
 clearInterval(inputTimer)
 snapshot()
 for (const response of pendingResources) response.end('')
 pendingResources = []
 if (peerNavigation) {
  try {
  await peerNavigation
  const guest = webContents.fromId(loadingPeer.guestId)
  // loadURL resolves at did-finish-load, before did-stop-loading clears
  // isLoading. Wait for that real state transition instead of racing it.
  await until(() => guest && !guest.isDestroyed() && !guest.isLoading(), 'loading peer completed after releasing its response', 5000)
  loadingPeer.finalState = { guestId: guest.id, url: guest.getURL(), loading: guest.isLoading() }
  loadingPeer.completed = guest.getURL() === loadingPeer.url
  if (!loadingPeer.completed) { failure = 'Loading peer did not finish in the same webContents'; code = 1 }
  const main = BrowserWindow.fromId(loadingPeer.windowId), sibling = webContents.fromId(loadingPeer.quietSibling.guestId)
  main.show(); main.focus()
  loadingPeer.quietSibling.frames = await frames(main, sibling, loadingPeer.quietSibling)
  loadingPeer.quietSibling.retained = await sibling.executeJavaScript('document.querySelector("textarea").value') === loadingPeer.quietSibling.draft
  if (!loadingPeer.quietSibling.retained) { failure = 'Quiet sibling draft was lost'; code = 1 }
  } catch (error) { failure = String(error); code = 1 }
  snapshot()
 }
 if (server) await new Promise(resolve => server.close(resolve))
 process.exitCode = code
 app.quit()
}
app.whenReady().then(async () => {
 timer = setInterval(snapshot, 5000)
 try {
  const main = await until(() => BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.webContents.getURL().includes('windowId=main')), 'main window')
  await until(async () => { try { return await main.webContents.executeJavaScript('Boolean(window.electron && document.body.innerText.length > 50)') } catch { return false } }, 'renderer bridge')
  await main.webContents.executeJavaScript('window.electron.appSettings.update({ lowMemoryMode: ' + (process.env.SIDEKICK_RESIDENT_RECLAIM !== '0') + ' })')
  server = http.createServer((request, response) => {
   if (request.url === '/pending-image') {
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.flushHeaders()
    pendingResources.push(response)
    return
   }
   response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
   response.end('<!doctype html><title>Resident browser fixture</title><style>body{min-height:2400px}</style><textarea>retained draft</textarea><button onclick="this.textContent=String(++window.clicks)">Count</button><script>window.clicks=0;window.wheels=0;document.addEventListener("wheel",event=>{window.wheels++;window.lastDeltaY=event.deltaY},{passive:true})</script>' + (request.url === '/loading-peer' ? '<img src="/pending-image">' : ''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port + '/'
  const mainGuest = await until(() => guestFor(main), 'main webpage')
  await mainGuest.loadURL(url)
  const enabled = await main.webContents.executeJavaScript('window.electron.modules.setEnabled("browser", true)')
  if (!enabled.ok) throw new Error(enabled.error)
  for (let index = 0; index < 10; index++) {
   const profile = await main.webContents.executeJavaScript('window.electron.profile.create(' + JSON.stringify({ name: 'Resident fixture ' + index, isAIPlatform: true, aiPlatformUrl: url, browserHomePage: url }) + ')')
   // The renderer owns live tabs. Writing a new tab only to windowState.save
   // races its debounced save of the old list. Reuse the production handshake
   // used by profile shortcuts, then wait for that real tab to be persisted.
   const tabId = await until(() => new Promise(resolve => {
    const channel = 'tab:ensureAndDetach:result'
    const complete = value => { clearTimeout(timeout); ipcMain.off(channel, receive); resolve(value) }
    const receive = (event, payload) => { if (event.sender === main.webContents && payload.profileId === profile.id) complete(payload.tabId) }
    const timeout = setTimeout(() => complete(null), 3000)
    ipcMain.on(channel, receive)
    main.webContents.send('tab:ensureAndDetach', profile.id)
   }), 'renderer-created tab ' + (index + 1))
   await until(() => main.webContents.executeJavaScript('window.electron.windowState.get("main").then(state => state?.tabs.some(tab => tab.id === ' + JSON.stringify(tabId) + '))'), 'persisted tab ' + (index + 1))
   await main.webContents.executeJavaScript('window.electron.windowControl.detachTab(' + JSON.stringify(tabId) + ')')
   await until(() => browserWindows().filter(win => { const guest = guestFor(win); return guest && !guest.isLoading() && guest.getURL() === url }).length === index + 1, 'browser ' + (index + 1))
  }
  for (const win of browserWindows()) {
   const guest = guestFor(win)
   identities.push({ windowId: win.id, guestId: guest.id, clicks: 0,
    shellToken: await win.webContents.executeJavaScript('window.__residentBrowserToken = crypto.randomUUID()'),
    guestToken: await guest.executeJavaScript('window.__residentBrowserToken = crypto.randomUUID()'),
    draft: await guest.executeJavaScript('document.querySelector("textarea").value = ' + JSON.stringify('retained draft ' + win.id)) })
  }
  if (loadingPeerEnabled) {
   const profile = await main.webContents.executeJavaScript('window.electron.profile.create(' + JSON.stringify({ name: 'Quiet sibling of loading page', isAIPlatform: true, aiPlatformUrl: url, browserHomePage: url }) + ')')
   await until(() => new Promise(resolve => {
    const channel = 'tab:ensureAndDetach:result'
    const complete = value => { clearTimeout(timeout); ipcMain.off(channel, receive); resolve(value) }
    const receive = (event, payload) => { if (event.sender === main.webContents && payload.profileId === profile.id) complete(payload.tabId) }
    const timeout = setTimeout(() => complete(null), 3000)
    ipcMain.on(channel, receive)
    main.webContents.send('tab:ensureAndDetach', profile.id)
   }), 'quiet sibling tab in the main window')
   const sibling = await until(() => webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getType() === 'webview' && wc.hostWebContents === main.webContents && wc !== mainGuest && !wc.isLoading() && wc.getURL() === url), 'quiet sibling webpage')
   const quietSibling = { guestId: sibling.id, pid: sibling.getOSProcessId(),
    shellToken: await main.webContents.executeJavaScript('window.__residentBrowserToken = crypto.randomUUID()'),
    guestToken: await sibling.executeJavaScript('window.__residentBrowserToken = crypto.randomUUID()'),
    draft: await sibling.executeJavaScript('document.querySelector("textarea").value = "quiet sibling draft"') }
   if (quietSibling.pid === mainGuest.getOSProcessId() || quietSibling.pid === main.webContents.getOSProcessId()) throw new Error('Quiet sibling does not have an independent renderer')
   loadingPeer = { windowId: main.id, shellPid: main.webContents.getOSProcessId(), guestId: mainGuest.id, guestPid: mainGuest.getOSProcessId(), url: url + 'loading-peer', samples: 0, loadingSamples: 0, quietSibling }
   peerNavigation = mainGuest.loadURL(loadingPeer.url).catch(error => { failure = String(error) })
   await until(() => pendingResources.length > 0 && mainGuest.isLoading(), 'a real pending image in the main webpage')
   browserWindows()[0].focus()
  }
  readyAt = Date.now(); phase = 'production-default-maximized'; snapshot()
  if (process.env.SIDEKICK_MEMORY_ACTIVE_INPUT === '1') {
   const win = browserWindows()[0], guest = guestFor(win)
   activeInput = { windowId: win.id, guestId: guest.id, shellPid: win.webContents.getOSProcessId(), guestPid: guest.getOSProcessId(), pulses: 0, focusedPulses: 0, acknowledgements: 0 }
   guest.on('input-event', (_event, event) => { if (event.type === 'mouseMove') { activeInput.acknowledgements++; activeInput.lastAckAt = Date.now() } })
   // Native event injection, never a physical-pointer claim. Keep one window
   // active between full interaction rounds so global idle cannot elapse.
   inputTimer = setInterval(() => {
    if (interacting || closingAt) return
    try {
     if (!win.isVisible()) win.show()
     if (!win.isFocused()) win.focus()
     if (win.isFocused()) activeInput.focusedPulses++
     activeInput.pulses++; activeInput.lastPulseAt = Date.now()
     guest.sendInputEvent({ type: 'mouseMove', x: 30 + activeInput.pulses % 2, y: 100 })
    } catch (error) { failure = String(error); void close(1) }
   }, 1000)
  }
  const seconds = Number(process.env.SIDEKICK_MEMORY_DURATION || 300000)
  const interactionMs = Number(process.env.SIDEKICK_MEMORY_INTERACTION_MS || 45000)
  const resizeMs = Number(process.env.SIDEKICK_MEMORY_RESIZE_MS || 60000)
  let nextInteraction = readyAt + interactionMs, resized = false
  while (Date.now() - readyAt < seconds) {
   await pause(Math.min(1000, Math.max(0, seconds - (Date.now() - readyAt))))
   if (Date.now() >= nextInteraction) {
    await interact()
    if (interactions.some(result => result.error)) throw new Error('Browser interaction checks failed; see telemetry')
    nextInteraction = Date.now() + interactionMs
   }
   if (!resized && Date.now() - readyAt >= resizeMs) {
    for (const win of browserWindows()) { win.unmaximize(); win.setBounds({ width: 900, height: 650 }) }
    resized = true; phase = 'uniform-window-size'; snapshot()
   }
  }
  await close(interactions.some(result => result.error) ? 1 : 0)
 } catch (error) { failure = String(error); console.error(error); await close(1) }
})
