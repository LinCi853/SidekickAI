import { app, protocol } from 'electron'
import { initializeApplication } from './application-admission.js'
import { product, edition } from '../packages/product-contract'
import { cookieHelperRequestPath, initializeCookieHelper, runCookieSnapshotHelper } from '../packages/backup-core/sessions.js'
import { initializeApplicationLog } from './diagnostics/application-log.js'
import { backupGuardianRequest, initializeBackupGuardian, runBackupGuardian } from '../packages/backup-core/guardian.js'
import { backupWorkerRequest, initializeBackupWorker, runBackupWorker } from '../packages/backup-core/recovery.js'

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

if (!backupWorkerRequest && !backupGuardianRequest) initializeApplicationLog()
if (backupGuardianRequest) {
  initializeBackupGuardian()
  void app.whenReady().then(async () => app.exit(await runBackupGuardian())).catch(error => { console.error('[backup] Recovery guardian failed', error); app.exit(1) })
} else if (backupWorkerRequest) {
  initializeBackupWorker()
  void app.whenReady().then(async () => app.exit(await runBackupWorker(async () => {
    const { exportAllData } = await import('./store/backup/export.js')
    return { export: exportAllData }
  }))).catch(error => { console.error('[backup] Snapshot worker failed', error); app.exit(1) })
} else if (cookieHelperRequestPath) {
  initializeCookieHelper()
  void app.whenReady().then(async () => app.exit(await runCookieSnapshotHelper())).catch(error => { console.error('[backup] Cookie helper failed', error); app.exit(1) })
} else {
  void initializeApplication('concept', () => import('./application-main.js')).catch(error => { console.error('[main] Application initialization failed', error); app.exit(1) })
}
