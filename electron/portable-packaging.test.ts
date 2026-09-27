import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { finished } from 'node:stream/promises'
import AdmZip from 'adm-zip'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const packer = require('../scripts/pack-portable.cjs')
const product = require('../packages/product-contract/manifest.json')
const workspace = require('../package.json')
const u = require('../scripts/uninstaller-build-utils.cjs')
let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-portable-package-')) })
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

function write(relative: string, bytes: Buffer | string) {
  const file = path.join(directory, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
}

function syntheticPe(arch: 'x64' | 'arm64') {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  bytes.writeUInt16LE(1, 70)
  bytes.writeUInt16LE(112, 84)
  bytes.writeUInt16LE(0x20b, 88)
  bytes.writeUInt32LE(512, 148)
  return bytes
}

async function application(arch: 'x64' | 'arm64', unsafeEntry?: string, metadata: { version?: string } = { version: workspace.version }) {
  const source = path.join(directory, arch)
  for (const name of packer.REQUIRED_RUNTIME_FILES) write(`${arch}/${name}`, 'runtime fixture')
  write(`${arch}/SidekickAI.exe`, syntheticPe(arch))
  write(`${arch}/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-${arch}.node`, syntheticPe(arch))
  write(`${arch}/resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-${arch}/uiohook-napi.node`, syntheticPe(arch))
  const archiveRoot = `${arch}-archive`
  write(`${archiveRoot}/package.json`, JSON.stringify({ name: product.editions.concept.packageName, version: metadata.version }))
  write(`${archiveRoot}/node_modules/node-gyp-build/node-gyp-build.js`, fs.readFileSync(require.resolve('node-gyp-build/node-gyp-build.js')))
  if (unsafeEntry) write(`${archiveRoot}/${unsafeEntry}`, 'private fixture')
  await finished(await asar.createPackage(path.join(directory, archiveRoot), path.join(source, 'resources/app.asar')))
  return source
}

function zip(extra: string[] = [], omitted?: string) {
  const archive = new AdmZip()
  for (const name of [...packer.REQUIRED_ENTRIES, ...extra].filter(name => name !== omitted)) archive.addFile(name, Buffer.from('fixture'))
  const target = path.join(directory, 'portable.zip')
  archive.writeZip(target)
  return target
}

describe('portable archive boundaries', () => {
  it('verifies the dual architecture archive and its CRCs', () => {
    const target = zip()
    expect(packer.verifyZip(target, 0).sha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects a truncated central directory', () => {
    const target = zip()
    fs.truncateSync(target, fs.statSync(target).size - 8)
    expect(() => packer.listZipEntries(target)).toThrow()
  })
  it('reads a ZIP64 central directory without falling back to a size check', () => {
    const target = zip()
    const original = fs.readFileSync(target)
    const end = original.subarray(-22)
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(end.readUInt16LE(8)), 24)
    record.writeBigUInt64LE(BigInt(end.readUInt16LE(10)), 32)
    record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40)
    record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50)
    locator.writeBigUInt64LE(BigInt(original.length - 22), 8)
    locator.writeUInt32LE(1, 16)
    const ending = Buffer.from(end)
    ending.writeUInt16LE(0xffff, 8)
    ending.writeUInt16LE(0xffff, 10)
    ending.writeUInt32LE(0xffffffff, 12)
    ending.writeUInt32LE(0xffffffff, 16)
    fs.writeFileSync(target, Buffer.concat([original.subarray(0, -22), record, locator, ending]))
    expect(packer.listZipEntries(target).sort()).toEqual([...packer.REQUIRED_ENTRIES].sort())
    expect(packer.verifyZip(target, 0).entries).toBe(packer.REQUIRED_ENTRIES.length)
  })
  it('rejects a missing ARM64 application', () => {
    const target = zip([], 'SidekickAI/win-arm64-unpacked/SidekickAI.exe')
    expect(() => packer.verifyZip(target, 0)).toThrow('missing')
  })
  it.each(['data/settings.db', 'win-unpacked/install-receipt.json', 'win-unpacked/uninstall.exe', 'win-arm64-unpacked/.env.local', 'devkit/readme.txt'])('rejects %s from the archive', name => {
    const target = zip([`SidekickAI/${name}`])
    expect(() => packer.verifyZip(target, 0)).toThrow()
  })
  it('rejects corruption even with an intact central directory', () => {
    const target = zip()
    const bytes = fs.readFileSync(target)
    const offset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)
    bytes[offset] ^= 0xff
    fs.writeFileSync(target, bytes)
    expect(() => packer.verifyZip(target, 0)).toThrow('archive failed')
  })
  it('rejects case-insensitive duplicate paths', () => {
    const target = zip(['SidekickAI/PORTABLE-LAYOUT.json'])
    expect(() => packer.verifyZip(target, 0)).toThrow('Duplicate')
  })
  it.each(['../settings.json', '/settings.json', 'C:/settings.json', 'runtime/./app.exe'])('rejects unsafe input path %s', name => {
    expect(() => packer.validatePortablePath(name)).toThrow()
  })
  it('refuses a single architecture distribution', () => {
    expect(() => packer.packPortable({ output: directory, applications: directory, architectures: ['x64'] })).toThrow('requires x64 and arm64')
  })
})

describe('portable application staging', () => {
  it.each([
    { label: 'missing', version: undefined },
    { label: 'mismatched', version: '0.0.0' }
  ])('rejects a $label workspace version before staging', async ({ version }) => {
    const source = await application('x64', undefined, { version })
    const target = path.join(directory, 'staged')
    const before = u.fingerprint(source, u.listFiles(source, new Set()))
    expect(() => packer.stagePortableApplication(source, target, 'x64')).toThrow('edition/version mismatch')
    expect(fs.existsSync(target)).toBe(false)
    expect(u.fingerprint(source, u.listFiles(source, new Set()))).toEqual(before)
  })
  it.each(['.env.local', '.app-data/settings.json'])('rejects %s hidden inside the application archive', async unsafeEntry => {
    const source = await application('x64', unsafeEntry)
    expect(() => packer.stagePortableApplication(source, path.join(directory, 'staged'), 'x64')).toThrow('non-distributable')
  })
  it.each(['x64', 'arm64'] as const)('copies a complete %s runtime without modifying its source', async arch => {
    const source = await application(arch)
    const before = u.fingerprint(source, u.listFiles(source, new Set()))
    const staged = packer.stagePortableApplication(source, path.join(directory, 'staged', arch), arch)
    expect(staged.native.arch).toBe(arch)
    expect(fs.readFileSync(path.join(staged.directory, 'portable.txt'), 'utf8')).toBe('SidekickAI Dual Architecture Portable Marker\n')
    expect(u.fingerprint(source, u.listFiles(source, new Set()))).toEqual(before)
  })
  it('rejects a development native hook before copying', async () => {
    const source = await application('arm64')
    write('arm64/resources/app.asar.unpacked/node_modules/uiohook-napi/build/Release/hook.node', syntheticPe('x64'))
    expect(() => packer.stagePortableApplication(source, path.join(directory, 'staged'), 'arm64')).toThrow()
  })
  it('rejects an incomplete Electron runtime before staging', async () => {
    const source = await application('x64')
    fs.unlinkSync(path.join(source, 'ffmpeg.dll'))
    const target = path.join(directory, 'staged')
    expect(() => packer.stagePortableApplication(source, target, 'x64')).toThrow()
    expect(fs.existsSync(target)).toBe(false)
  })
  it('refuses to overwrite previous staging or use the application as its output', async () => {
    const source = await application('x64')
    expect(() => packer.stagePortableApplication(source, source, 'x64')).toThrow('outside')
    expect(() => packer.stagePortableApplication(source, path.join(source, 'staged'), 'x64')).toThrow('outside')
    const target = path.join(directory, 'staged')
    fs.mkdirSync(target)
    expect(() => packer.stagePortableApplication(source, target, 'x64')).toThrow('already exists')
  })
})
