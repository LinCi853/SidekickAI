import fs from 'node:fs'
import path from 'node:path'
import { product } from '../product-contract'
import { applicationProcessOperation, applicationProcessOperationSync } from './application-process'

export type ProcessRecord = { ProcessId: number; ParentProcessId?: number; ExecutablePath?: string; CommandLine?: string; Started?: string; Sid?: string; Session?: number }
export type RunningApplication = { pid: number; executable: string; edition: 'concept' | 'community'; version: string; started?: string; sid?: string; session?: number }
export type ApplicationProcessControl = {
  inventory: () => RunningApplication[] | Promise<RunningApplication[]>
  verify: (application: RunningApplication) => boolean | Promise<boolean>
  activate: (application: RunningApplication) => boolean | Promise<boolean>
  close: (application: RunningApplication) => void | Promise<void>
  terminate: (application: RunningApplication) => void | Promise<void>
}

export function packageIdentity(archive: string): { name: string; version: string; editionSessionProtocol?: number } | null {
  let fd: number | undefined
  const runtime = process as NodeJS.Process & { noAsar?: boolean }
  const previousNoAsar = runtime.noAsar
  runtime.noAsar = true
  try {
    fd = fs.openSync(archive, 'r')
    const read = (size: number, offset: number) => {
      const bytes = Buffer.alloc(size)
      if (fs.readSync(fd!, bytes, 0, size, offset) !== size) throw new Error('Truncated application archive')
      return bytes
    }
    const header = read(16, 0)
    const headerSize = header.readUInt32LE(4), jsonSize = header.readUInt32LE(12)
    if (header.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 32 * 1024 * 1024 || jsonSize > headerSize - 8) return null
    const entry = JSON.parse(read(jsonSize, 16).toString()).files?.['package.json']
    if (!entry || entry.link || entry.unpacked || !/^\d+$/.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 1024 * 1024) return null
    const offset = 8 + headerSize + Number(entry.offset)
    if (!Number.isSafeInteger(offset) || offset + entry.size > fs.fstatSync(fd).size) return null
    const value = JSON.parse(read(entry.size, offset).toString())
    return typeof value.name === 'string' && typeof value.version === 'string' ? value : null
  } catch { return null }
  finally { if (fd !== undefined) fs.closeSync(fd); runtime.noAsar = previousNoAsar }
}

export function identifyRunningApplications(records: ProcessRecord[], currentPid: number, readIdentity = packageIdentity, includeCoordinated = false): RunningApplication[] {
  return records.flatMap(record => {
    if (!Number.isSafeInteger(record.ProcessId) || record.ProcessId <= 0 || record.ProcessId === currentPid || !record.ExecutablePath || !path.isAbsolute(record.ExecutablePath)
      || record.CommandLine && /(?:^|\s)--(?:type=|export-user-data(?:\s|$)|sidekick-cookie-worker(?:\s|$))/.test(record.CommandLine)) return []
    if (records.some(parent => parent.ProcessId === record.ParentProcessId && parent.ExecutablePath?.toLowerCase() === record.ExecutablePath!.toLowerCase())) return []
    if (!record.CommandLine && (!record.Started || !record.Sid || !Number.isSafeInteger(record.Session))) return []
    const identity = readIdentity(path.join(path.dirname(record.ExecutablePath), 'resources/app.asar'))
    if (!includeCoordinated && identity?.editionSessionProtocol === 2) return []
    const edition = (['concept', 'community'] as const).find(key => product.editions[key].packageName === identity?.name)
    return edition && identity ? [{ pid: record.ProcessId, executable: record.ExecutablePath, edition, version: identity.version,
      ...(record.Started ? { started: record.Started, sid: record.Sid, session: record.Session } : {}) }] : []
  })
}

/** Product identity and captured process identity identify application owners. */
export function runningApplications(includeCoordinated = false, resourcesPath?: string): RunningApplication[] {
  if (process.platform !== 'win32' || process.env.SIDEKICK_TEST_SESSION) return []
  const parsed = applicationProcessOperationSync<ProcessRecord[]>('inventory', {}, resourcesPath)
  return identifyRunningApplications(Array.isArray(parsed) ? parsed : [parsed], process.pid, packageIdentity, includeCoordinated)
}

export function duplicateVersionNotice(): string | null {
  return null
}

export function applicationProcessControl(resourcesPath?: string): ApplicationProcessControl {
  const verified = new Map<number, RunningApplication>()
  const verify = async (application: RunningApplication) => {
    const previous = verified.get(application.pid)
    const owner = await applicationProcessOperation<{ executable: string; started: string; sid?: string; session: number } | null>(previous ? 'inspect-image' : 'inspect', { pid: application.pid }, resourcesPath)
    if (!owner || path.resolve(owner.executable).toLowerCase() !== path.resolve(application.executable).toLowerCase()) return false
    const identity = packageIdentity(path.join(path.dirname(owner.executable), 'resources/app.asar'))
    if (identity?.name !== product.editions[application.edition].packageName || identity.version !== application.version) return false
    if (previous && (previous.started !== owner.started || previous.session !== owner.session || !equalExecutable(previous.executable, owner.executable))) return false
    const sid = owner.sid ?? previous?.sid
    if (application.started && (application.started !== owner.started || application.sid !== sid || application.session !== owner.session)) return false
    application.started = owner.started; application.sid = sid; application.session = owner.session
    verified.set(application.pid, { ...application })
    return true
  }
  const operate = async (action: 'activate' | 'close' | 'terminate', application: RunningApplication) => {
    if (!await verify(application)) throw new Error('Application process identity changed')
    return applicationProcessOperation<{ activated?: boolean }>(action, application, resourcesPath)
  }
  return { inventory: async () => { const rows = await applicationProcessOperation<ProcessRecord[]>('inventory', {}, resourcesPath); return identifyRunningApplications(rows, process.pid, packageIdentity, true) }, verify,
    activate: async application => !!(await operate('activate', application)).activated,
    close: async application => { await operate('close', application) },
    terminate: async application => {
      if (!await verify(application)) {
        const owner = await applicationProcessOperation<{ started: string } | null>('inspect-image', { pid: application.pid }, resourcesPath)
        if (!owner) return
        throw new Error('Application process identity changed')
      }
      await applicationProcessOperation('terminate', application, resourcesPath)
    } }
}

const equalExecutable = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
