import { open } from 'node:fs/promises'
import path from 'node:path'
import type { AssetAttachment, AssetAttachmentPreview } from '../shared/ai-assets.types.js'

export const PREVIEW_MEDIA_LIMIT = 32 * 1024 * 1024
export const PREVIEW_TEXT_LIMIT = 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon'])
const imageExtensions = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon']])
const textTypes = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'])
const textExtensions = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.ini'])

export async function readAttachmentPreview(file: string, item: AssetAttachment): Promise<AssetAttachmentPreview> {
  const declared = item.mimeType.toLowerCase().split(';')[0].trim(), extension = path.extname(item.name).toLowerCase()
  const mimeType = !declared || declared === 'application/octet-stream' ? imageExtensions.get(extension) ?? (extension === '.pdf' ? 'application/pdf' : declared) : declared
  const kind = imageTypes.has(mimeType) ? 'image' : mimeType === 'application/pdf' ? 'pdf'
    : mimeType.startsWith('text/') || textTypes.has(mimeType) || textExtensions.has(extension) ? 'text' : undefined
  if (!kind) return { ok: false, error: '此格式暂不支持预览，请导出原件或在文件夹中查看副本' }
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (kind !== 'text' && size > PREVIEW_MEDIA_LIMIT) return { ok: false, error: '文件超过 32 MB 预览上限，请导出原件或在文件夹中查看副本' }
    const buffer = Buffer.alloc(Math.min(size, kind === 'text' ? PREVIEW_TEXT_LIMIT : PREVIEW_MEDIA_LIMIT))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const bytes = buffer.subarray(0, offset)
    if (kind !== 'text') return { ok: true, kind, bytes, mimeType }
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    const text = new TextDecoder(encoding).decode(bytes)
    if (text.includes('\0')) return { ok: false, error: '文件包含二进制内容，请导出原件或在文件夹中查看副本' }
    return { ok: true, kind: 'text', text, truncated: size > buffer.length }
  } finally { await handle.close() }
}
