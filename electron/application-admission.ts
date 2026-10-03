import { app } from 'electron'
import { spawn } from 'node:child_process'
import { acquireEditionSession, editionSessionEndpoint, applicationSessionIntent, type Edition } from './edition-session.js'

export interface ApplicationSessionCallbacks {
  state(): 'ready' | 'busy' | 'starting'
  onActivate(): void | boolean | Promise<void | boolean>
  onQuit(): void | boolean | Promise<void | boolean>
}

let callbacks: ApplicationSessionCallbacks = { state: () => 'starting', onActivate: () => false, onQuit: () => false }
let reservation: Promise<boolean> | undefined
let reservedEdition: Edition | undefined

/** Reserve application ownership before any data lock or persistent store is opened. */
export function reserveApplicationSession(edition: Edition): Promise<boolean> {
  if (reservedEdition && reservedEdition !== edition) return Promise.reject(new Error('Application edition changed during admission'))
  reservedEdition = edition
  reservation ??= (async () => {
    const endpoint = editionSessionEndpoint(process.env.SIDEKICK_TEST_SESSION, edition, '', app.isPackaged ? process.resourcesPath : undefined)
    const result = await acquireEditionSession({
      edition, endpoint, executable: app.getPath('exe'), resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      ...applicationSessionIntent(),
      state: () => callbacks.state(),
      onActivate: () => callbacks.onActivate(),
      onQuit: () => callbacks.onQuit(),
    })
    if (!result.acquired) {
      if (result.outcome === 'redirected' && result.targetExecutable) {
        const child = spawn(result.targetExecutable, [], { detached: true, windowsHide: true, stdio: 'ignore' })
        child.once('error', error => console.error('[ApplicationAdmission] Restart failed', error))
        child.unref()
      } else if (result.outcome === 'unavailable') console.error('[ApplicationAdmission]', result.reason)
      return false
    }
    return true
  })().catch(error => {
    console.error('[ApplicationAdmission] Admission could not complete', error)
    return false
  })
  return reservation
}

export function bindApplicationSession(edition: Edition, value: ApplicationSessionCallbacks): Promise<boolean> {
  callbacks = value
  return reserveApplicationSession(edition)
}

export async function initializeApplication(edition: Edition, load: () => Promise<unknown>, prepare: () => Promise<boolean> = async () => true): Promise<void> {
  const exportIndex = process.argv.indexOf('--export-user-data')
  const exportRequest = exportIndex >= 0 ? process.argv[exportIndex + 1] : undefined
  const exporting = !!exportRequest && !exportRequest.startsWith('--')
  if (!exporting && (!await prepare() || !await reserveApplicationSession(edition))) { app.exit(0); return }
  await load()
}
