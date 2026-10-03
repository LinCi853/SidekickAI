import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { applicationProcessOperation } from './application-process'

export type InstallationReservation = { protocol: 1; requestId: string; executable: string; edition: 'concept' | 'community'; version: string;
  pid: number; ownerExecutable: string; ownerStarted: string; sid: string; session: number; expiresAt: number }
export function installationReservationPath(endpoint: string): string {
  const hash = /sidekick-editions-([a-f0-9]{24})/.exec(endpoint)?.[1]
  if (!hash) throw new Error('Invalid application endpoint')
  const root = process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir()
  if (!root) throw new Error('Local application coordination is unavailable')
  return path.join(root, 'SidekickAI-Startup/coordination', hash, 'installation.json')
}
export async function readInstallationReservation(endpoint: string, resourcesPath?: string): Promise<InstallationReservation | null> {
  const file = installationReservationPath(endpoint)
  let value: InstallationReservation
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 4096) return null
    value = JSON.parse(fs.readFileSync(file, 'utf8')) as InstallationReservation
  } catch { return null }
  if (value.protocol !== 1 || !/^[a-f0-9]{64}$/.test(value.requestId) || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !['community', 'concept'].includes(value.edition) || !path.isAbsolute(value.executable) || !path.isAbsolute(value.ownerExecutable)
    || typeof value.version !== 'string' || typeof value.ownerStarted !== 'string' || typeof value.sid !== 'string'
    || !Number.isSafeInteger(value.session) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 180000) return null
  if (process.platform !== 'win32') return null
  const owner = await applicationProcessOperation<{ executable: string; started: string; sid: string; session: number } | null>('inspect', { pid: value.pid }, resourcesPath)
  if (!owner || owner.executable.toLowerCase() !== value.ownerExecutable.toLowerCase() || owner.started !== value.ownerStarted || owner.sid !== value.sid || owner.session !== value.session) return null
  return value
}
export function applicationSessionIntent(): { intent: 'ordinary' | 'installation'; requestId?: string } {
  const requestId = process.env.SIDEKICK_APPLICATION_REQUEST_ID
  return process.env.SIDEKICK_APPLICATION_INTENT === 'installation' && requestId && /^[a-f0-9]{64}$/.test(requestId)
    ? { intent: 'installation', requestId } : { intent: 'ordinary' }
}
