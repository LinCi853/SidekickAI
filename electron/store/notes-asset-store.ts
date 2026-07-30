// electron/store/notes-asset-store.ts — 笔记图片磁盘存储 + 自定义协议
//
// 笔记中粘贴/拖拽的图片保存到 userData/notes-assets/<uuid>.<ext>，
// markdown 中存 notes-asset:// 协议路径，跨设备迁移时路径不含绝对路径。
// 参照 whiteboard-asset-store.ts 实现，独立目录与协议，互不干扰。

import { app, protocol, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/types.js'

const ASSETS_DIR_NAME = 'notes-assets'

/** 自定义协议名，与 whiteboard-asset:// 分离 */
export const NOTES_ASSET_SCHEME = 'notes-asset'

function getAssetsDir(): string {
  const dir = path.join(app.getPath('userData'), ASSETS_DIR_NAME)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 将 dataURL 图片保存到磁盘，返回 notes-asset:// 路径 */
export function saveNotesImageAsset(dataUrl: string): string {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片 dataURL')
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const buf = Buffer.from(match[2], 'base64')
  const filename = `${randomUUID()}.${ext}`
  const filepath = path.join(getAssetsDir(), filename)
  fs.writeFileSync(filepath, buf)
  return `${NOTES_ASSET_SCHEME}://asset/${filename}`
}

/**
 * 注册笔记图片自定义协议处理器。
 * 必须在 app.whenReady() 后调用（protocol.handle 要求）。
 * registerSchemesAsPrivileged 已在 main.ts 顶层调用。
 */
export function registerNotesAssetProtocol(): void {
  console.log('[notes-asset] 注册自定义协议:', NOTES_ASSET_SCHEME)
  protocol.handle(NOTES_ASSET_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const filename = url.pathname.replace(/^\//, '')
      if (!filename) return new Response('Not found', { status: 404 })
      const filepath = path.join(getAssetsDir(), filename)
      if (!fs.existsSync(filepath)) {
        console.error('[notes-asset] 文件不存在:', filepath)
        return new Response('Not found', { status: 404 })
      }
      const buf = fs.readFileSync(filepath)
      const ext = path.extname(filepath).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      return new Response(buf, { headers: { 'Content-Type': mime } })
    } catch (err) {
      console.error('[notes-asset] 协议处理失败:', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}

/** 注册笔记图片磁盘存储 IPC + 自定义协议 */
export function registerNotesAssetIPC(): void {
  registerNotesAssetProtocol()

  ipcMain.handle(
    IPC_CHANNELS.NOTES_SAVE_IMAGE,
    async (_e, dataUrl: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
      try {
        const url = saveNotesImageAsset(dataUrl)
        return { ok: true, url }
      } catch (err) {
        console.error('[notes-asset] 保存图片失败:', err)
        return { ok: false, error: String(err) }
      }
    },
  )
}
