import { app, protocol } from 'electron'
import { initializeApplication } from './application-admission.js'
import { product, edition } from '../packages/product-contract'
import { cookieHelperRequestPath, initializeCookieHelper, runCookieSnapshotHelper } from '../packages/backup-core/sessions.js'
import { initializeApplicationLog } from './diagnostics/application-log.js'

app.setName(product.name)
if (process.platform === 'win32') app.setAppUserModelId(edition.appId)
app.commandLine.appendSwitch('disable-crashpad')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-features', 'RestrictGamepadAccess')
if (process.platform === 'linux') app.commandLine.appendSwitch('force-device-scale-factor', '1')
protocol.registerSchemesAsPrivileged([
  { scheme: 'whiteboard-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'notes-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'sidekick-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

initializeApplicationLog()
if (cookieHelperRequestPath) {
  initializeCookieHelper()
  void app.whenReady().then(async () => app.exit(await runCookieSnapshotHelper())).catch(error => { console.error('[backup] Cookie helper failed', error); app.exit(1) })
} else {
  void initializeApplication('concept', () => import('./application-main.js')).catch(error => { console.error('[main] Application initialization failed', error); app.exit(1) })
}
