import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { LoginTrace, WindowTrace } from '../shared/chat.types.js'
import type { AppStart, ClickLog } from './usage-trace-store.js'
import { localLogDate, logDateRange, type LogExportOptions, type LogExportResult } from '../shared/log-export.js'
import { redactDiagnostic } from '../diagnostics/runtime-log.js'

export interface ActivityLogRecords {
  loginRecords: Array<Pick<LoginTrace, 'id' | 'profileId' | 'platform' | 'loginUrl' | 'loginTime'>>
  windowRecords: Array<Pick<WindowTrace, 'id' | 'windowId' | 'action' | 'timestamp'>>
  startupRecords: AppStart[]
  clickRecords: Array<Omit<ClickLog, 'detail'>>
}
export interface LogSource { id: string; directory: string; file?: string; operationDirectories?: boolean; dated?: boolean }
interface SourceResult { source: string; path: string; status: string; files: number; error?: string }
interface FileResult { source: string; path: string; bytes: number; modifiedAt: string; sha256: string; dateBasis: string }
const pending = new Map<string, Promise<LogExportResult>>()

export function openActivityLogFolder(dataDirectory: string, readRecords: () => ActivityLogRecords,
  openPath: (directory: string) => Promise<string>, options: LogExportOptions = {}, sources: LogSource[] = []): Promise<LogExportResult> {
  try { logDateRange(options) } catch (error) { return Promise.reject(error) }
  const key = JSON.stringify([path.resolve(dataDirectory), options.startDate || '', options.endDate || ''])
  const known = pending.get(key)
  if (known) return known
  const operation = exportAndOpen(dataDirectory, readRecords, openPath, options, sources)
  pending.set(key, operation)
  void operation.then(() => pending.delete(key), () => pending.delete(key))
  return operation
}

async function exportAndOpen(dataDirectory: string, readRecords: () => ActivityLogRecords,
  openPath: (directory: string) => Promise<string>, options: LogExportOptions, sources: LogSource[]): Promise<LogExportResult> {
  const range = logDateRange(options)
  const within = (timestamp: number) => timestamp >= range.start && timestamp < range.end
  const now = new Date(), stamp = `${localLogDate(now)}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}-${randomUUID()}`
  const parent = path.join(dataDirectory, 'logs', 'exports', localLogDate(now))
  await fs.mkdir(parent, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(parent, '.pending-'))
  const directory = path.join(parent, stamp)
  let published = false
  const results: SourceResult[] = [], files: FileResult[] = []
  try {
    const all = readRecords()
    const records = {
      loginRecords: all.loginRecords.filter(row => within(row.loginTime)).map(row => ({ ...row, loginUrl: row.loginUrl ? redactDiagnostic(row.loginUrl) : row.loginUrl })),
      windowRecords: all.windowRecords.filter(row => within(row.timestamp)),
      startupRecords: all.startupRecords.filter(row => within(row.startTime)),
      clickRecords: all.clickRecords.filter(row => within(row.timestamp)),
    }
    await fs.writeFile(path.join(temporary, 'activity-records.json'), `${JSON.stringify({ exportedAt: now.toISOString(), options,
      counts: Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length])), ...records }, null, 2)}\n`, { flag: 'wx' })
    for (const source of sources) {
      const result: SourceResult = { source: source.id, path: source.directory, status: 'available', files: 0 }
      results.push(result)
      try {
        const root = await fs.lstat(source.directory)
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Log source is not a regular directory')
        const candidates: string[] = []
        if (source.file) candidates.push(source.file)
        else for (const entry of await fs.readdir(source.directory, { withFileTypes: true })) {
          if (source.operationDirectories && entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(entry.name, 'install.log'))
          else if (!source.operationDirectories && entry.isFile() && /\.(?:log|jsonl|txt)$/i.test(entry.name)) candidates.push(entry.name)
        }
        for (const relative of candidates.sort()) {
          const origin = path.join(source.directory, relative)
          try {
            const stat = await fs.lstat(origin)
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Log is not a regular file')
            const dated = source.dated && /^\d{4}-\d{2}-\d{2}/.exec(path.basename(relative))?.[0]
            const date = dated ? logDateRange({ startDate: dated }).start : stat.mtimeMs
            if (!within(date)) continue
            const destination = path.join(temporary, source.id, relative)
            await fs.mkdir(path.dirname(destination), { recursive: true })
            const handle = await fs.open(origin, 'r')
            let output: Awaited<ReturnType<typeof fs.open>> | undefined
            try {
              const actual = await handle.stat()
              if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error('Log changed before reading')
              output = await fs.open(destination, 'wx')
              const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
              let position = 0
              while (position < stat.size) {
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position)
                if (!bytesRead) throw new Error('Log changed during export')
                const part = buffer.subarray(0, bytesRead)
                await output.writeFile(part); hash.update(part); position += bytesRead
              }
              files.push({ source: source.id, path: path.relative(temporary, destination).replace(/\\/g, '/'), bytes: position,
                modifiedAt: stat.mtime.toISOString(), sha256: hash.digest('hex'), dateBasis: dated ? 'local-runtime-date' : 'file-modified-date' })
              result.files++
            } finally { await handle.close(); await output?.close() }
          } catch (error) {
            results.push({ source: source.id, path: origin, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', files: 0, error: String(error) })
            await fs.unlink(path.join(temporary, source.id, relative)).catch(() => {})
          }
        }
      } catch (error) {
        result.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
        result.error = String(error)
      }
    }
    const warnings = results.filter(source => source.status === 'unreadable').length
    await fs.writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify({ exportedAt: now.toISOString(), options,
      dateSelection: 'Activity events use local dates. Maintenance files use modification dates and retain the entire file.',
      historicalRuntime: 'Only previously persisted logs are available. Missing historical runtime output cannot be recovered.',
      maintenanceScope: 'The shared maintenance log directory may contain operations for either product edition. Existing files are copied without edition attribution.',
      databaseExcluded: ['session credentials', 'conversation content', 'click details'],
      runtimeRedaction: 'Credential keys and URL queries are redacted. Remote web page and code preview consoles are excluded. Existing maintenance logs are copied unchanged.',
      sources: results, files, warnings }, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temporary, directory)
    published = true
    const error = await openPath(directory)
    if (error) throw new Error(`Unable to open exported logs: ${error}`)
    return { directory, files: files.length + 2, warnings }
  } finally {
    if (!published && path.dirname(temporary) === parent && path.basename(temporary).startsWith('.pending-'))
      await fs.rm(temporary, { recursive: true, force: true })
  }
}
