import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadAsset } from './download.js'
import { distributionFixture } from './fixtures.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(portable = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sidekick-concept-update-'))
  roots.push(root)
  const asset = structuredClone(distributionFixture().release.assets[portable ? 2 : 0])
  const bytes = Buffer.alloc(1024)
  if (portable) bytes.writeUInt32LE(0x04034b50, 0)
  else { bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80); bytes.writeUInt16LE(0x8664, 0x84) }
  asset.sha256 = createHash('sha256').update(bytes).digest('hex'); asset.assetId = asset.sha256
  const response = (body: Uint8Array = bytes, status = 200, extra: Record<string, string> = {}) => new Response(new Uint8Array(body).buffer, { status,
    headers: { 'content-length': String(status === 206 ? body.length : asset.sizeBytes), etag: `"${asset.sha256}"`, ...extra } })
  return { root, bytes, asset, response, manifestSha256: 'a'.repeat(64), signal: new AbortController().signal, origin: 'https://fixture.invalid', progress: vi.fn() }
}
describe('concept verified package download', () => {
  it('downloads signed-identity installer and portable bytes without mutating application data', async () => {
    for (const portable of [false, true]) {
      const input = fixture(portable)
      const file = await downloadAsset({ ...input, fetcher: vi.fn(async () => input.response()) as typeof fetch })
      expect(readFileSync(file)).toEqual(input.bytes)
      expect(file.endsWith(portable ? '.zip' : '.exe')).toBe(true)
    }
  })
  it('resumes interrupted downloads and restarts on a 200 response', async () => {
    for (const continuation of [true, false]) {
      const input = fixture()
      await expect(downloadAsset({ ...input, fetcher: vi.fn(async () => input.response(input.bytes.subarray(0, 100))) as typeof fetch })).rejects.toThrow()
      const fetcher = vi.fn(async (_url, options) => {
        expect(options?.headers).toMatchObject({ Range: 'bytes=100-', 'If-Range': `"${input.asset.sha256}"` })
        return continuation ? input.response(input.bytes.subarray(100), 206, { 'content-range': 'bytes 100-1023/1024' }) : input.response()
      }) as typeof fetch
      expect(readFileSync(await downloadAsset({ ...input, fetcher }))).toEqual(input.bytes)
    }
  })
  it('discards corrupt bytes, wrong native PE, and wrong continuation responses', async () => {
    for (const kind of ['digest', 'architecture', 'range']) {
      const input = fixture()
      if (kind === 'digest') input.bytes[900] = 1
      if (kind === 'architecture') {
        input.bytes.writeUInt16LE(0xaa64, 0x84)
        input.asset.sha256 = createHash('sha256').update(input.bytes).digest('hex'); input.asset.assetId = input.asset.sha256
      }
      if (kind === 'range') await expect(downloadAsset({ ...input, fetcher: vi.fn(async () => input.response(input.bytes.subarray(0, 100))) as typeof fetch })).rejects.toThrow()
      await expect(downloadAsset({ ...input, fetcher: vi.fn(async () => kind === 'range' ? input.response(input.bytes.subarray(100), 206,
        { 'content-range': 'bytes 99-1023/1024' }) : input.response()) as typeof fetch })).rejects.toThrow()
      expect(existsSync(path.join(input.root, `asset-${input.asset.sha256}.part`))).toBe(false)
    }
  })
})
