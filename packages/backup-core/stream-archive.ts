import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, normalizeEdition, parseBackupManifest, safeBackupPath, validateSnapshots } from './format.js'
import { assertOrdinaryPath, checkAbort, checkDiskSpace, flushFile, MAX_BACKUP_BYTES, MAX_BACKUP_ENTRIES, MAX_MANIFEST_BYTES, STREAM_BUFFER_BYTES } from './io.js'
import type { BackupManifest } from './types.js'

export interface ArchiveEntry { archivePath: string; sourcePath: string; size: number; sha256: string }
export interface ArchiveProgress { signal?: AbortSignal; cancelled?: () => boolean; onBytes?: (bytes: number, total: number) => void }
interface IndexedArchive { zip: yauzl.ZipFile; entries: yauzl.Entry[]; total: number }

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  crcTable[index] = value >>> 0
}
function crcUpdate(crc: number, data: Buffer): number {
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8
  return crc >>> 0
}

function validateNames(entries: Array<{ name: string; directory: boolean; size: number; mode?: number }>): number {
  if (entries.length > MAX_BACKUP_ENTRIES) throw new Error(`Backup contains more than ${MAX_BACKUP_ENTRIES} entries.`)
  const seen = new Set<string>()
  const files = new Set<string>()
  let total = 0
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '')
    const key = name.toLowerCase()
    const type = (entry.mode ?? 0) & 0xf000
    total += entry.size
    if (!safeBackupPath(name) || Buffer.byteLength(entry.name, 'utf8') > 65535 || seen.has(key)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(total) || total > MAX_BACKUP_BYTES
      || type && type !== (entry.directory ? 0x4000 : 0x8000)) throw new Error(`Invalid backup entry: ${entry.name}`)
    seen.add(key)
    if (!entry.directory) files.add(key)
  }
  for (const name of seen) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) if (files.has(parts.slice(0, index).join('/'))) throw new Error(`Conflicting backup entry: ${name}`)
  }
  return total
}

export function validateArchiveSelection(entries: ArchiveEntry[]): number {
  return validateNames(entries.map(entry => ({ name: entry.archivePath, directory: false, size: entry.size })))
}

export async function writeStreamingArchive(file: string, entries: ArchiveEntry[], manifest: BackupManifest, options: ArchiveProgress = {}): Promise<void> {
  checkAbort(options.signal, options.cancelled)
  const total = validateArchiveSelection(entries)
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('Backup manifest exceeds its documented size limit.')
  parseBackupManifest(manifest)
  const archive = new yazl.ZipFile()
  const output = archive.outputStream as Readable
  let written = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { checkAbort(options.signal, options.cancelled); written += chunk.length; options.onBytes?.(written, total); callback(null, chunk) }
    catch (error) { callback(error as Error) }
  } })
  archive.on('error', error => output.destroy(error))
  const task = pipeline(output, meter, fs.createWriteStream(file, { flags: 'w', mode: 0o600, highWaterMark: STREAM_BUFFER_BYTES }), { signal: options.signal })
  try {
    archive.addBuffer(manifestBytes, 'manifest.json', { mode: 0o100600, mtime: new Date(manifest.exportedAt), forceZip64Format: true })
    for (const entry of entries) {
      assertOrdinaryPath(entry.sourcePath)
      archive.addFile(entry.sourcePath, entry.archivePath, { mode: 0o100600, mtime: new Date(manifest.exportedAt), forceZip64Format: true })
    }
    archive.end({ forceZip64Format: true, comment: '' })
    await task
    flushFile(file)
  } catch (error) { output.destroy(); await task.catch(() => {}); fs.rmSync(file, { force: true }); throw error }
}

async function indexArchive(file: string, options: ArchiveProgress): Promise<IndexedArchive> {
  assertOrdinaryPath(file)
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)))
  const entries: yauzl.Entry[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          checkAbort(options.signal, options.cancelled)
          if (entries.length >= MAX_BACKUP_ENTRIES || !entry.canDecodeFileData()) throw new Error(`Unsupported backup entry: ${entry.fileName}`)
          entries.push(entry)
          zip.readEntry()
        } catch (error) { reject(error) }
      })
      zip.readEntry()
    })
    const total = validateNames(entries.map(entry => ({ name: entry.fileName, directory: entry.fileName.endsWith('/'), size: entry.uncompressedSize, mode: entry.externalFileAttributes >>> 16 })))
    return { zip, entries, total }
  } catch (error) { zip.close(); throw error }
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)))
}

async function readEntryBytes(zip: yauzl.ZipFile, entry: yauzl.Entry, options: ArchiveProgress): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error(`Backup metadata exceeds its documented size limit: ${entry.fileName}`)
  const chunks: Buffer[] = []
  let total = 0
  let crc = 0xffffffff
  for await (const value of await entryStream(zip, entry)) {
    checkAbort(options.signal, options.cancelled)
    const chunk = value as Buffer
    total += chunk.length
    if (total > MAX_MANIFEST_BYTES || total > entry.uncompressedSize) throw new Error('Backup metadata length is invalid.')
    crc = crcUpdate(crc, chunk)
    chunks.push(chunk)
  }
  if (total !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error(`Backup integrity check failed: ${entry.fileName}`)
  return Buffer.concat(chunks)
}

function legacyManifest(raw: Record<string, unknown>, inventory: Record<string, string>, identity: Record<string, unknown>): BackupManifest {
  if (!Object.hasOwn(inventory, 'settings.db') && !Object.hasOwn(inventory, 'profiles.json')) throw new Error('Backup is missing application settings.')
  if (raw.appVersion !== undefined && typeof raw.appVersion !== 'string') throw new Error('Invalid historical backup version.')
  const declared = normalizeEdition(raw.edition)
  const owned = normalizeEdition(identity.edition)
  if (raw.edition !== undefined && !declared || declared && owned && declared !== owned) throw new Error('Conflicting historical backup ownership.')
  if (Object.keys(identity).length && (identity.schema !== 1 || !owned)) throw new Error('Invalid historical backup ownership.')
  const names = Object.keys(inventory)
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, legacy: true, edition: declared ?? owned,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : 'legacy', appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'legacy',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', entries: inventory,
    options: { basicData: true, cookies: names.some(name => /(^|\/)(Local Storage\/|(?:Network\/)?Cookies(?:$|-))/.test(name)), indexedDB: names.some(name => /(^|\/)IndexedDB\//.test(name)), cache: names.some(name => /(^|\/)(?:Cache|GPUCache|Code Cache)\//.test(name)) },
    cookieSnapshots: raw.cookieSnapshots as BackupManifest['cookieSnapshots'],
  }
  if (manifest.cookieSnapshots) manifest.options.cookies = true
  validateSnapshots(manifest)
  return manifest
}

/** ZIP64 payloads are authenticated one entry at a time; file contents never accumulate in memory. */
export async function readStreamingArchive(file: string, options: ArchiveProgress & { extractTo?: string; allowLegacy?: boolean } = {}): Promise<BackupManifest> {
  const { zip, entries, total } = await indexArchive(file, options)
  try {
    const manifestEntry = entries.find(entry => entry.fileName === 'manifest.json')
    const raw = manifestEntry ? JSON.parse((await readEntryBytes(zip, manifestEntry, options)).toString('utf8')) : {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid backup manifest.')
    const modern = raw.format !== undefined || raw.formatVersion !== undefined
    if (!modern && !options.allowLegacy) throw new Error('Unsupported backup format. Export a new backup using the current application.')
    let manifest = modern ? parseBackupManifest(raw) : undefined
    const sizes = manifest?.inventory && new Map(manifest.inventory.map(entry => [entry.path, entry.size]))
    const expected = manifest && new Set(Object.keys(manifest.entries))
    const observed: Record<string, string> = Object.create(null)
    if (options.extractTo) {
      assertOrdinaryPath(options.extractTo, true)
      checkDiskSpace([{ path: options.extractTo, bytes: total, purpose: '备份恢复' }])
      for (const entry of entries) if (fs.existsSync(path.join(options.extractTo, entry.fileName))) throw new Error(`Restore destination already contains an entry: ${entry.fileName}`)
    }
    let completed = 0
    for (const entry of entries) {
      checkAbort(options.signal, options.cancelled)
      const directory = entry.fileName.endsWith('/')
      if (directory) { if (options.extractTo) fs.mkdirSync(path.join(options.extractTo, entry.fileName), { recursive: true, mode: 0o700 }); continue }
      if (modern && entry.fileName !== 'manifest.json' && !expected!.has(entry.fileName)) throw new Error(`Unexpected backup entry: ${entry.fileName}`)
      if (sizes && entry.fileName !== 'manifest.json' && sizes.get(entry.fileName) !== entry.uncompressedSize) throw new Error(`Backup inventory size does not match its payload: ${entry.fileName}`)
      const hash = createHash('sha256')
      let size = 0
      let crc = 0xffffffff
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        try {
          checkAbort(options.signal, options.cancelled)
          size += chunk.length
          if (size > entry.uncompressedSize) throw new Error(`Backup entry exceeds its declared size: ${entry.fileName}`)
          hash.update(chunk); crc = crcUpdate(crc, chunk)
          options.onBytes?.(completed + size, total)
          callback(null, chunk)
        } catch (error) { callback(error as Error) }
      } })
      const target = options.extractTo && path.join(options.extractTo, entry.fileName)
      if (target) { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); assertOrdinaryPath(path.dirname(target), true) }
      const sink = target ? fs.createWriteStream(target, { flags: 'wx', mode: 0o600, highWaterMark: STREAM_BUFFER_BYTES }) : new Writable({ write(_chunk, _encoding, callback) { callback() } })
      await pipeline(await entryStream(zip, entry), meter, sink, { signal: options.signal })
      if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error(`Backup integrity check failed: ${entry.fileName}`)
      const digest = hash.digest('hex')
      if (entry.fileName !== 'manifest.json') {
        observed[entry.fileName] = digest
        if (manifest && digest !== manifest.entries[entry.fileName]) throw new Error(`Backup integrity check failed: ${entry.fileName}`)
        expected?.delete(entry.fileName)
      }
      if (target) flushFile(target)
      completed += size
    }
    if (expected?.size) throw new Error(`Backup is missing files: ${[...expected].join(', ')}`)
    if (!manifest) {
      const identityEntry = entries.find(entry => entry.fileName === 'edition-identity.json')
      const identity = identityEntry ? JSON.parse((await readEntryBytes(zip, identityEntry, options)).toString('utf8')) : {}
      manifest = legacyManifest(raw, observed, identity)
    }
    return manifest
  } finally { zip.close() }
}

export async function archiveExpandedBytes(file: string): Promise<number> {
  const { zip, total } = await indexArchive(file, {})
  zip.close()
  return total
}
