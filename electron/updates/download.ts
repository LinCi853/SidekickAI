import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { distributionOrigin } from './catalog.js'
import { DISTRIBUTION_PATH } from './contract.js'
import type { UpdateAsset } from './types.js'

export function updateFile(root: string, name: string): string {
  if (!/^(?:sequences\.json|release-[a-f0-9]{64}\.json|asset-[a-f0-9]{64}\.(?:exe|zip|part|json)|record-[a-f0-9-]+\.tmp)$/.test(name)) throw new Error('Invalid update file name.')
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw new Error('Invalid update directory.')
  mkdirSync(root, { recursive: true })
  const file = path.join(root, name)
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('Invalid update file.')
  return file
}
function atomicJson(root: string, file: string, value: unknown): void {
  const temporary = updateFile(root, `record-${randomUUID()}.tmp`)
  try { writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', encoding: 'utf8' }); renameSync(temporary, file) }
  finally { if (existsSync(temporary)) rmSync(temporary) }
}
export function createSequences(root: string) {
  const readAll = (): Record<string, number> => {
    const file = updateFile(root, 'sequences.json')
    if (!existsSync(file)) return {}
    if (lstatSync(file).size > 64 * 1024) throw new Error('Invalid channel sequence file size.')
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128
      || Object.entries(value).some(([key, sequence]) => !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(sequence) || sequence < 1)) throw new Error('Invalid channel sequence record.')
    return value
  }
  return {
    read: (key: string): number => readAll()[key] ?? 0,
    write(key: string, sequence: number): void {
      const all = readAll()
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(sequence) || sequence < Math.max(1, all[key] ?? 0)) throw new Error('The channel sequence cannot move backwards.')
      all[key] = sequence
      atomicJson(root, updateFile(root, 'sequences.json'), all)
    },
  }
}
export async function verifyAsset(file: string, asset: UpdateAsset): Promise<void> {
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || (await stat(file)).size !== asset.sizeBytes) throw new Error('下载文件大小无效。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== asset.sha256) throw new Error('下载文件摘要无效。')
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(Math.min(asset.sizeBytes, 65536))
    await handle.read(header, 0, header.length, 0)
    if (asset.role === 'portable') {
      if (header.length < 4 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('下载文件不是完整绿色 ZIP。')
    } else {
      const offset = header.length >= 64 ? header.readUInt32LE(0x3c) : header.length
      if (header.toString('ascii', 0, 2) !== 'MZ' || offset + 6 > header.length || header.toString('ascii', offset, offset + 4) !== 'PE\0\0'
        || header.readUInt16LE(offset + 4) !== (asset.executableArchitecture === 'arm64' ? 0xaa64 : 0x8664)) throw new Error('下载的安装器架构不一致。')
    }
  } finally { await handle.close() }
}
export async function downloadAsset(input: {
  root: string; origin: string; asset: UpdateAsset; manifestSha256: string; signal: AbortSignal; progress(bytes: number): void; fetcher?: typeof fetch
}): Promise<string> {
  const { root, asset } = input
  const origin = distributionOrigin(input.origin)
  const destination = updateFile(root, `asset-${asset.sha256}.${asset.role === 'portable' ? 'zip' : 'exe'}`)
  if (existsSync(destination)) {
    try { await verifyAsset(destination, asset); input.progress(asset.sizeBytes); return destination }
    catch { await unlink(destination) }
  }
  const temporary = updateFile(root, `asset-${asset.sha256}.part`)
  const metadata = updateFile(root, `asset-${asset.sha256}.json`)
  const etag = `"${asset.sha256}"`
  let compatible = false
  try {
    if (existsSync(metadata) && lstatSync(metadata).size <= 4096) {
      const record = JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>
      compatible = record.version === 1 && record.sha256 === asset.sha256 && record.sizeBytes === asset.sizeBytes && record.manifestSha256 === input.manifestSha256 && record.etag === etag
    }
  } catch { compatible = false }
  if (!compatible) { if (existsSync(temporary)) await unlink(temporary); if (existsSync(metadata)) await unlink(metadata) }
  let offset = existsSync(temporary) ? (await stat(temporary)).size : 0
  if (offset >= asset.sizeBytes) {
    try { await verifyAsset(temporary, asset); await rename(temporary, destination); if (existsSync(metadata)) await unlink(metadata); input.progress(asset.sizeBytes); return destination }
    catch { await unlink(temporary); offset = 0 }
  }
  const headers: Record<string, string> = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' }
  if (offset) { headers.Range = `bytes=${offset}-`; headers['If-Range'] = etag }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let discard = false
  try {
    const response = await (input.fetcher ?? fetch)(new URL(`${DISTRIBUTION_PATH}/assets/${asset.assetId}`, origin), {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60_000)]), redirect: 'error', headers,
    })
    if (![200, 206].includes(response.status)) { await response.body?.cancel(); throw new Error(`下载失败（HTTP ${response.status}），可重试。`) }
    let length = asset.sizeBytes
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      if (!offset || !range || Number(range[1]) !== offset || Number(range[2]) !== asset.sizeBytes - 1 || Number(range[3]) !== asset.sizeBytes) {
        discard = true; await response.body?.cancel(); throw new Error('下载续传区间无效。')
      }
      length -= offset
    } else offset = 0
    const contentLength = response.headers.get('content-length')
    const encoding = response.headers.get('content-encoding')
    if (response.headers.get('etag') !== etag || contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) !== length || encoding && encoding !== 'identity') {
      discard = true; await response.body?.cancel(); throw new Error('下载响应身份或大小无效。')
    }
    if (!response.body) throw new Error('下载文件为空。')
    atomicJson(root, metadata, { version: 1, sha256: asset.sha256, sizeBytes: asset.sizeBytes, manifestSha256: input.manifestSha256, etag })
    handle = await open(temporary, offset ? 'a' : 'w')
    const reader = response.body.getReader()
    let bytes = offset
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > asset.sizeBytes) { discard = true; throw new Error('下载超过声明大小。') }
        await handle.writeFile(chunk.value)
        input.progress(bytes)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    await handle.sync(); await handle.close(); handle = undefined
    if (bytes !== asset.sizeBytes) throw new Error('下载中断，可继续下载。')
    try { await verifyAsset(temporary, asset) } catch (error) { discard = true; throw error }
    await rename(temporary, destination)
    await unlink(metadata)
    return destination
  } finally {
    if (handle) { await handle.sync().catch(() => {}); await handle.close().catch(() => {}) }
    if (discard) { if (existsSync(temporary)) await unlink(temporary); if (existsSync(metadata)) await unlink(metadata) }
  }
}
