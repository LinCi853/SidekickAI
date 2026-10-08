import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AssetAttachment } from '../shared/ai-assets.types.js'

const extensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-7z-compressed': '.7z',
  'application/x-rar-compressed': '.rar',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/html': '.html',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
}

export function attachmentFileName(item: Pick<AssetAttachment, 'name' | 'mimeType'>, limit = 120): string {
  if (limit < 16) throw new Error('Attachment path is too long')
  let name = path.win32.basename(item.name).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/, '') || 'asset'
  if (/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(name)) name = `_${name}`
  const originalExtension = path.extname(name)
  const mimeType = item.mimeType?.split(';')[0].trim().toLowerCase()
  const extension = originalExtension.length <= 32 && originalExtension
    ? originalExtension : Object.hasOwn(extensions, mimeType) ? extensions[mimeType] : '.bin'
  if (extension.length + 5 > limit) throw new Error('Attachment path is too long')
  const stem = originalExtension && originalExtension.length <= 32 ? name.slice(0, -originalExtension.length) : name
  return `${stem.slice(0, limit - extension.length).replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, '') || 'asset'}${extension}`
}

export async function createAttachmentCopy(temporaryRoot: string, original: string,
  item: Pick<AssetAttachment, 'name' | 'mimeType' | 'sha256' | 'size'>): Promise<string> {
  const directory = await mkdtemp(path.join(temporaryRoot, 'sidekickai-asset-'))
  try {
    const file = path.join(directory, attachmentFileName(item, Math.min(120, 240 - directory.length - 1)))
    await copyFile(original, file)
    if (item.size !== undefined && (await stat(file)).size !== item.size) throw new Error('Attachment copy size check failed')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (hash.digest('hex') !== item.sha256) throw new Error('Attachment copy digest check failed')
    return file
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
