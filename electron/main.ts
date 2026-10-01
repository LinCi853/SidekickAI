import { app } from 'electron'
import './runtime-environment.js'
import { cookieHelperRequestPath, runCookieSnapshotHelper } from '../packages/backup-core/sessions.js'

if (cookieHelperRequestPath) {
  void app.whenReady().then(async () => app.exit(await runCookieSnapshotHelper())).catch(error => { console.error('[backup] Cookie helper failed', error); app.exit(1) })
} else {
  void import('./application-main.js').catch(error => { console.error('[main] Application initialization failed', error); app.exit(1) })
}