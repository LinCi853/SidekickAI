import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { product } from '../product-contract'

type ProcessRecord = { ProcessId: number; ExecutablePath?: string; CommandLine?: string }
export type RunningApplication = { pid: number; executable: string; edition: 'concept' | 'community'; version: string }

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
      || !record.CommandLine || /(?:^|\s)--(?:type=|export-user-data(?:\s|$))/.test(record.CommandLine)) return []
    const identity = readIdentity(path.join(path.dirname(record.ExecutablePath), 'resources/app.asar'))
    if (!includeCoordinated && identity?.editionSessionProtocol === 2) return []
    const edition = (['concept', 'community'] as const).find(key => product.editions[key].packageName === identity?.name)
    return edition && identity ? [{ pid: record.ProcessId, executable: record.ExecutablePath, edition, version: identity.version }] : []
  })
}

/** Historic applications without the shared session protocol require a manual exit. */
export function runningApplications(includeCoordinated = false): RunningApplication[] {
  if (process.platform !== 'win32' || process.env.SIDEKICK_TEST_SESSION) return []
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $sessionId = (Get-Process -Id ${process.pid}).SessionId; Get-CimInstance Win32_Process -Filter "Name='SidekickAI.exe' OR Name='SidekickAI-OpenSource.exe'" | Where-Object { $_.SessionId -eq $sessionId } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
  const parsed = JSON.parse(output.trim() || '[]')
  return identifyRunningApplications(Array.isArray(parsed) ? parsed : [parsed], process.pid, packageIdentity, includeCoordinated)
}

export function duplicateVersionNotice(): string | null {
  const different = runningApplications(true).find(instance => instance.version !== product.version)
  return different ? `另一个版本（${different.version}）正在运行，请先保存并退出后再启动 ${product.version}。` : null
}
