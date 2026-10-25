import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import * as yazl from 'yazl'
import {
  archiveExpandedBytes,
  BackupExpansionLimitError,
  readStreamingArchive,
  UnsupportedCompressionError,
} from './stream-archive.js'
import { encryptFileStream, SABK_MAX_PLAINTEXT_BYTES } from './file-crypto.js'
import { readImportBackup, type ImportAdapter } from './import.js'
import { runBackupCli } from './cli.js'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-archive-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Resolves to the rejection value so a test can assert on the error object itself. */
function capture(operation: Promise<unknown>): Promise<Error | undefined> {
  return operation.then(
    () => undefined,
    (error: unknown) => error as Error,
  )
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Builds a ZIP whose central directory is written by hand, because the defect is about archives
 * produced by *other* tools: AdmZip and yazl only ever emit STORED or DEFLATE.
 */
function rawZip(
  entries: Array<{ name: string; method: number; data: Buffer; declaredSize?: number }>,
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const declaredSize = entry.declaredSize ?? entry.data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, entry.data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function yazlArchive(
  file: string,
  entries: Array<[string, Buffer]>,
  compress: boolean,
): Promise<void> {
  const archive = new yazl.ZipFile()
  const published = pipeline(archive.outputStream, fs.createWriteStream(file))
  for (const [name, bytes] of entries)
    archive.addBuffer(bytes, name, {
      compress,
      mode: 0o100600,
      mtime: new Date('2024-01-01T00:00:00Z'),
    })
  archive.end()
  await published
}

const adapter: ImportAdapter = {
  edition: 'community',
  defaults: { profile: { id: 'fixture' }, presets: [] },
  validateFull: () => {},
}

function manifestFor(name: string, bytes: Buffer): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'sidekickai-backup',
      formatVersion: 1,
      deviceId: 'fixture',
      appVersion: 'fixture',
      exportedAt: '',
      edition: 'community',
      dataSchemaVersion: 1,
      entries: { [name]: createHash('sha256').update(bytes).digest('hex') },
      options: { basicData: true, cookies: false, indexedDB: false, cache: false },
    }),
  )
}

describe('stream archive compression methods', () => {
  it('rejects an entry whose compression method is not STORED or DEFLATE with a distinct error', async () => {
    const file = path.join(root, 'repacked.zip')
    // Compression method 12 (bzip2) is what a re-packing tool can emit; the payload bytes are never read.
    fs.writeFileSync(
      file,
      rawZip([{ name: 'settings.db', method: 12, data: Buffer.from('not-bzip2') }]),
    )
    const error = await capture(archiveExpandedBytes(file))
    expect(error).toBeInstanceOf(UnsupportedCompressionError)
    expect(error?.message).toContain('不支持的压缩方式')
    expect(error?.message).toContain('settings.db')
    // The distinction that matters: a re-packed but valid backup must not look like a password failure.
    expect(error?.message).not.toContain('密码错误或文件损坏')
  })

  it('rejects an unsupported compression method before any entry data is decoded', async () => {
    const file = path.join(root, 'lzma.zip')
    // Method 14 (LZMA) with bytes that are not an LZMA stream: the archive must fail while indexing.
    fs.writeFileSync(
      file,
      rawZip([
        { name: 'Partitions/account/Network/Cookies', method: 14, data: Buffer.from('garbage') },
      ]),
    )
    const stage = path.join(root, 'stage')
    fs.mkdirSync(stage)
    const error = await capture(readStreamingArchive(file, { extractTo: stage }))
    expect(error).toBeInstanceOf(UnsupportedCompressionError)
    expect(fs.readdirSync(stage)).toEqual([])
  })

  it('still indexes ordinary STORED and DEFLATE archives', async () => {
    const payload = Buffer.from('sqlite fixture bytes')
    const manifest = manifestFor('settings.db', payload)
    for (const [name, compress] of [
      ['stored.zip', false],
      ['deflated.zip', true],
    ] as const) {
      const file = path.join(root, name)
      await yazlArchive(
        file,
        [
          ['settings.db', payload],
          ['manifest.json', manifest],
        ],
        compress,
      )
      expect(await archiveExpandedBytes(file)).toBe(payload.length + manifest.length)
      const read = await readStreamingArchive(file, {})
      expect(read.entries['settings.db']).toBe(createHash('sha256').update(payload).digest('hex'))
    }
  })
})

describe('stream archive expansion ceiling', () => {
  const perEntry = 4_000_000_000
  const count = 18
  const declared = perEntry * count
  // Each entry stays under the 32-bit ZIP field limit, but the declared total is over the SABK ceiling.
  const bomb = () =>
    Array.from({ length: count }, (_, index) => ({
      name: `Partitions/account/IndexedDB/${index}.ldb`,
      method: 8,
      data: Buffer.from('not-a-deflate-stream'),
      declaredSize: perEntry,
    }))

  it('rejects an archive declaring an uncompressed total above the limit before any entry is decoded', async () => {
    expect(declared).toBeGreaterThan(SABK_MAX_PLAINTEXT_BYTES)
    const file = path.join(root, 'expansion.zip')
    fs.writeFileSync(file, rawZip(bomb()))
    expect(fs.statSync(file).size).toBeLessThan(SABK_MAX_PLAINTEXT_BYTES)
    const stage = path.join(root, 'stage')
    fs.mkdirSync(stage)
    // The payload bytes are not a valid DEFLATE stream, so decoding any entry would fail differently.
    let decoded = 0
    const error = await capture(
      readStreamingArchive(file, {
        extractTo: stage,
        onBytes: () => {
          decoded++
        },
      }),
    )
    expect(error).toBeInstanceOf(BackupExpansionLimitError)
    expect(error?.message).toContain('备份内容超出支持的大小上限')
    expect((error as BackupExpansionLimitError).declaredBytes).toBeGreaterThan(
      SABK_MAX_PLAINTEXT_BYTES,
    )
    expect(error?.message).not.toContain('密码错误或文件损坏')
    expect(decoded).toBe(0)
    expect(fs.readdirSync(stage)).toEqual([])
    expect(await capture(archiveExpandedBytes(file))).toBeInstanceOf(BackupExpansionLimitError)
  })

  it('reports the expansion limit instead of a password failure for an encrypted backup', async () => {
    const artifact = path.join(root, 'expansion.zip')
    fs.writeFileSync(artifact, rawZip(bomb()))
    const encrypted = path.join(root, 'expansion.sabackup')
    await encryptFileStream(artifact, encrypted, 'correct horse battery staple', 'fixture-device')
    const stage = path.join(root, 'stage')
    fs.mkdirSync(stage)
    const error = await capture(
      readImportBackup(adapter, encrypted, stage, 'correct horse battery staple'),
    )
    expect(error).toBeInstanceOf(BackupExpansionLimitError)
    expect(error?.message).toContain('备份内容超出支持的大小上限')
  })

  it('keeps mapping only SABK authentication failures to the password message', async () => {
    const artifact = path.join(root, 'plain.zip')
    fs.writeFileSync(artifact, rawZip([{ name: 'settings.db', method: 8, data: Buffer.from('x') }]))
    const encrypted = path.join(root, 'plain.sabackup')
    await encryptFileStream(artifact, encrypted, 'correct horse battery staple', 'fixture-device')
    const stage = path.join(root, 'stage')
    fs.mkdirSync(stage)
    expect(
      (await capture(readImportBackup(adapter, encrypted, stage, 'wrong password')))?.message,
    ).toBe('密码错误或文件损坏')
  })

  it('surfaces the distinct compression error through the standalone CLI', async () => {
    const file = path.join(root, 'cli.zip')
    fs.writeFileSync(
      file,
      rawZip([{ name: 'settings.db', method: 12, data: Buffer.from('not-bzip2') }]),
    )
    const error = await capture(runBackupCli(['verify', '--file', file]))
    expect(error).toBeInstanceOf(UnsupportedCompressionError)
    expect(error?.message).toContain('不支持的压缩方式')
  })
})
