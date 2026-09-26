import { app, BrowserWindow, webContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { startEditionSession, markEditionReady } from '../../electron/edition-runtime.js'

const root = process.env.SIDEKICK_EDITION_FIXTURE_ROOT
if (!root || !path.isAbsolute(root) || !process.env.SIDEKICK_TEST_SESSION) throw new Error('An isolated fixture root and namespace are required')
fs.mkdirSync(path.join(root, 'profile'), { recursive: true })
app.setPath('userData', path.join(root, 'profile'))
app.setPath('sessionData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
const send = (value: object) => process.send?.(value)
let attempts = 0
app.on('before-quit', () => { attempts++; send({ event: 'before-quit', attempts }) })
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-prevent-unload', event => {
    queueMicrotask(() => send({ event: 'veto', type: contents.getType(), defaultPrevented: event.defaultPrevented }))
  })
})
app.on('will-quit', () => send({ event: 'will-quit' }))

app.whenReady().then(async () => {
  if (!await startEditionSession('open-source', () => false)) throw new Error('Could not acquire isolated session')
  const window = new BrowserWindow({ width: 480, height: 240, title: 'Isolated edition quit fixture' })
  const target = window.webContents
  await window.loadURL('data:text/html,' + encodeURIComponent('<h3>Isolated window beforeunload fixture</h3>'))
  process.on('message', async (message: { action: string }) => {
    if (message.action === 'allow') {
      await target.executeJavaScript('window.onbeforeunload = null', true)
      send({ event: 'allowed' })
    } else if (message.action === 'cleanup') {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) await contents.executeJavaScript('window.onbeforeunload = null', true).catch(() => {})
      }
      app.quit()
    }
  })
  await target.executeJavaScript('window.onbeforeunload = () => false; true', true)
  markEditionReady()
  send({ event: 'ready', pid: process.pid, target: target.getType() })
}).catch(error => { send({ event: 'error', error: String(error) }); app.quit() })
