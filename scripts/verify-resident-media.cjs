// Real muted media and the production monitor, without CDP or screen capture.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const evidence = fs.mkdtempSync(path.join(root, 'local/resident-media-'))
  const env = { ...process.env, SIDEKICK_DATA_DIR: path.join(evidence, 'profile'), SIDEKICK_TEST_SESSION: evidence,
    SIDEKICK_MEDIA_EVIDENCE: evidence, SIDEKICK_RESIDENT_RECLAIM: '1' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LIB', 'LIBPATH']) delete env[key]
  const log = fs.openSync(path.join(evidence, 'runtime.log'), 'w')
  const child = spawn(require('electron'), [__filename, '--skip-guide'], { cwd: root, env, stdio: ['ignore', log, log] })
  const timer = setTimeout(() => { child.kill(); console.error('Muted media verification timed out'); process.exitCode = 1 }, 150000)
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', code => {
    clearTimeout(timer); fs.closeSync(log)
    process.exitCode = code === 0 ? process.exitCode || 0 : 1
    const report = path.join(evidence, 'report.json')
    if (fs.existsSync(report)) {
      const result = JSON.parse(fs.readFileSync(report, 'utf8'))
      console.log(JSON.stringify({ evidence, status: result.status, checks: result.checks, error: result.error, events: result.events }, null, 2))
    } else console.error('No media report: ' + evidence)
  })
} else {
  const { app, BrowserWindow, webContents } = require('electron')
  const http = require('node:http')
  const assert = require('node:assert/strict')
  const evidence = process.env.SIDEKICK_MEDIA_EVIDENCE
  const report = { evidence, status: 'RUNNING', events: [], observations: [], checks: [] }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  let phase = 'starting', timer, server
  function snapshot() {
    const resident = app.__residentMemoryDiagnostics?.()
    report.observations.push({ at: Date.now(), phase, resident: resident ? { ...resident, samples: resident.samples.slice(-1) } : null })
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  }
  async function until(predicate, message, milliseconds = 30000) {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(100) }
    throw new Error(message)
  }
  app.setAppPath(root)
  app.setLoginItemSettings = () => {}
  require(path.join(root, 'out/main/index.cjs'))
  app.whenReady().then(async () => {
    timer = setInterval(snapshot, 1000)
    try {
      const win = await until(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('windowId=main')), 'Main window missing')
      await until(async () => { try { return await win.webContents.executeJavaScript('Boolean(window.electron && document.body?.innerText.length > 50)') } catch { return false } }, 'Renderer bridge missing')
      await win.webContents.executeJavaScript('window.electron.appSettings.update({ lowMemoryMode: true })')
      const guest = await until(() => webContents.getAllWebContents().find(c => !c.isDestroyed() && c.getType() === 'webview' && c.hostWebContents === win.webContents), 'Main webpage missing')
      for (const name of ['media-started-playing', 'media-paused']) guest.on(name, () => report.events.push({ at: Date.now(), name }))
      server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Muted video protection</title><video muted playsinline></video><video muted playsinline></video><textarea>retained media draft</textarea>')
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      await guest.loadURL('http://127.0.0.1:' + server.address().port + '/')
      const token = await guest.executeJavaScript(`(async () => {
        window.mediaToken = crypto.randomUUID(); window.mediaStreams = [];
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        let frame = 0; const draw = () => { const ctx = canvas.getContext('2d'); ctx.fillStyle = ++frame % 2 ? '#123456' : '#abcdef'; ctx.fillRect(0,0,64,64) };
        draw(); window.mediaTimer = setInterval(draw, 1000);
        for (const video of document.querySelectorAll('video')) { const stream = canvas.captureStream(1); window.mediaStreams.push(stream); video.srcObject = stream; video.muted = true; await video.play() }
        return window.mediaToken;
      })()`)
      const mediaState = () => app.__residentMemoryDiagnostics().samples.at(-1)?.protection.contents.find(c => c.id === guest.id)
      await until(() => (mediaState()?.playingMedia ?? 0) > 0, 'Muted playback was not protected')
      assert.equal(guest.isCurrentlyAudible(), false)
      assert.equal(guest.isBeingCaptured(), false, 'Capture protection would invalidate the muted media test')
      phase = 'two-playing'; const started = Date.now(); snapshot(); await pause(30000)
      await guest.executeJavaScript('document.querySelectorAll("video")[0].pause()')
      phase = 'one-playing'; snapshot(); await pause(20000)
      assert((mediaState()?.playingMedia ?? 0) > 0, 'Pausing one player released the other player protection')
      assert.equal(await guest.executeJavaScript('[...document.querySelectorAll("video")].filter(video => !video.paused).length'), 1)
      const diagnostics = app.__residentMemoryDiagnostics()
      assert.equal(diagnostics.actions.filter(a => a.at >= started && a.result).length, 0, 'Reclaimed while muted media was playing')
      report.checks.push('muted playback protects all working sets, including when only one of two players pauses')
      await guest.executeJavaScript('document.querySelectorAll("video")[1].pause(); clearInterval(window.mediaTimer); window.mediaStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()))')
      phase = 'paused'; const pausedAt = Date.now(); snapshot()
      await until(() => mediaState()?.playingMedia === 0, 'Playback protection did not clear after all players paused')
      await until(() => app.__residentMemoryDiagnostics().actions.some(a => a.at >= pausedAt && a.result), 'Idle reclaim did not resume after playback paused', 45000)
      assert.equal(await guest.executeJavaScript('window.mediaToken'), token, 'Page was reloaded')
      assert.equal(await guest.executeJavaScript('document.querySelector("textarea").value'), 'retained media draft')
      report.checks.push('idle reclaim resumes after all media stops without reloading or losing the draft')
      report.status = 'PASS'
    } catch (error) { report.status = 'FAIL'; report.error = error.stack }
    finally {
      clearInterval(timer); phase = 'finished'; snapshot()
      server?.closeAllConnections(); server?.close()
      app.exit(report.status === 'PASS' ? 0 : 1)
    }
  }).catch(error => { report.status = 'FAIL'; report.error = error.stack; snapshot(); app.exit(1) })
}
