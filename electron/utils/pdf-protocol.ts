import { app, protocol, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assertOrdinaryPath, createPrivateDirectory, isWithin } from '../../packages/backup-core/io.js'
import { openNativeFile, readNativeFile, type NativeFile } from '../security/native-file.js'

export const PDF_SCHEME = 'sidekick-pdf'
const MAX_PREVIEW_BYTES = 100 * 1024 * 1024
interface Preview { file: NativeFile; owner: WebContents; pdf: boolean; timer: NodeJS.Timeout }
const previews = new Map<string, Preview>()
const observed = new WeakSet<WebContents>()
let previewRoot: string | undefined

function directory(): string {
  if (!previewRoot) {
    const created = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-previews-'))
    createPrivateDirectory(created)
    previewRoot = fs.realpathSync.native(created)
  }
  assertOrdinaryPath(previewRoot, true)
  return previewRoot
}

function discard(token: string): boolean {
  const item = previews.get(token)
  if (!item) return false
  previews.delete(token)
  clearTimeout(item.timer)
  fs.closeSync(item.file.descriptor)
  try {
    assertOrdinaryPath(item.file.path)
    const info = fs.statSync(item.file.path, { bigint: true })
    if (info.dev === item.file.identity.dev && info.ino === item.file.identity.ino) fs.unlinkSync(item.file.path)
  } catch { }
  return true
}

/** Local previews are snapshots created by the main process, never caller-selected paths. */
export function createLocalPreview(bytes: Buffer, name: string, owner: WebContents): { token: string; url: string; kind: 'pdf' | 'file' } {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PREVIEW_BYTES) throw new Error('预览文件超过允许的大小。')
  const extension = path.extname(name).toLowerCase()
  const pdf = extension === '.pdf'
  const token = randomUUID()
  const filePath = path.join(directory(), token + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin'))
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 })
  const file = openNativeFile(filePath)
  const timer = setTimeout(() => discard(token), 60 * 60 * 1000)
  timer.unref()
  previews.set(token, { file, owner, pdf, timer })
  if (!observed.has(owner)) {
    observed.add(owner)
    owner.once('destroyed', () => {
      for (const [id, item] of previews) if (item.owner === owner) discard(id)
    })
  }
  if (previews.size > 128) discard(previews.keys().next().value!)
  return { token, url: pdf ? `sidekickai://print-preview?${new URLSearchParams({ file: token, title: name, sourceUrl: '' })}` : pathToFileURL(filePath).href, kind: pdf ? 'pdf' : 'file' }
}

export function createPdfPreview(bytes: Buffer, owner: WebContents): string {
  return createLocalPreview(bytes, 'preview.pdf', owner).token
}

export function readPdfPreview(token: unknown, owner?: WebContents): Buffer {
  const item = typeof token === 'string' ? previews.get(token) : undefined
  if (!item || !item.pdf || owner && item.owner !== owner) throw new Error('打印预览已失效，请重新生成。')
  assertOrdinaryPath(item.file.path)
  const real = fs.realpathSync.native(item.file.path)
  if (!isWithin(directory(), real)) throw new Error('打印预览不属于本应用。')
  const current = fs.statSync(real, { bigint: true })
  if (current.dev !== item.file.identity.dev || current.ino !== item.file.identity.ino) throw new Error('打印预览文件已变化。')
  return readNativeFile(item.file, MAX_PREVIEW_BYTES)
}

export function deletePdfPreview(token: unknown, owner: WebContents): boolean {
  if (typeof token !== 'string' || previews.get(token)?.owner !== owner || !previews.get(token)?.pdf) return false
  return discard(token)
}

export function toPdfProtocolUrl(token: string): string {
  return `${PDF_SCHEME}://preview/${encodeURIComponent(token)}`
}

export function registerPdfProtocol(): void {
  protocol.handle(PDF_SCHEME, request => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'preview' || url.username || url.password || url.search || url.hash
        || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
      const token = decodeURIComponent(url.pathname.slice(1))
      const bytes = readPdfPreview(token)
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: {
        'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="preview.pdf"',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}
