// electron/store/whiteboard-asset-store.ts — 白板图片磁盘存储 + 自定义协议
//
// v0.5.2 R-4：白板图片改为原图磁盘存储，不再压缩。
// 图片保存到 userData/whiteboard-assets/<uuid>.<ext>，WhiteboardCard.content 存自定义协议路径。
// 清理时由 clearAllData 统一处理（目录在 userData 下，递归删除已覆盖）。
//
// v0.0.2 修复：file:// 在 dev 模式（origin=http://localhost:xxxx）被 webSecurity CORS 阻止，
// 改用 whiteboard-asset:// 自定义协议（registerSchemesAsPrivileged + protocol.handle），
// dev/prod 行为一致，且路径不含绝对路径（利于跨设备迁移）。

import { app, ipcMain, protocol } from 'electron'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const ASSETS_DIR_NAME = 'whiteboard-assets'

/** 自定义协议名，替代 file:// 避免 dev 模式 CORS 阻止 */
export const WHITEBOARD_ASSET_SCHEME = 'whiteboard-asset'

function getAssetsDir(): string {
  const dir = path.join(app.getPath('userData'), ASSETS_DIR_NAME)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 将 dataURL 图片保存到磁盘，返回 whiteboard-asset:// 路径 */
export function saveImageAsset(dataUrl: string): string {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片 dataURL')
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const buf = Buffer.from(match[2], 'base64')
  const filename = `${randomUUID()}.${ext}`
  const filepath = path.join(getAssetsDir(), filename)
  fs.writeFileSync(filepath, buf)
  // 用 host=asset + path=/filename 格式，避免 filename 被当作 host（standard 协议 URL 解析行为）
  return `${WHITEBOARD_ASSET_SCHEME}://asset/${filename}`
}

/**
 * 注册白板图片自定义协议处理器。
 * 必须在 app.whenReady() 后调用（protocol.handle 要求）。
 * registerSchemesAsPrivileged 已在 main.ts 顶层调用。
 */
export function registerWhiteboardAssetProtocol(): void {
  console.log('[whiteboard-asset] 注册自定义协议:', WHITEBOARD_ASSET_SCHEME)
  protocol.handle(WHITEBOARD_ASSET_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      // whiteboard-asset://asset/<filename>
      const filename = url.pathname.replace(/^\//, '')
      console.log('[whiteboard-asset] 请求文件:', filename, 'url:', request.url)
      if (!filename) return new Response('Not found', { status: 404 })
      const filepath = path.join(getAssetsDir(), filename)
      if (!fs.existsSync(filepath)) {
        console.error('[whiteboard-asset] 文件不存在:', filepath)
        return new Response('Not found', { status: 404 })
      }
      const buf = fs.readFileSync(filepath)
      const ext = path.extname(filepath).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      console.log('[whiteboard-asset] 返回:', filename, buf.length, 'bytes, mime=' + mime)
      return new Response(buf, { headers: { 'Content-Type': mime } })
    } catch (err) {
      console.error('[whiteboard-asset] 协议处理失败:', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}

/** 注册白板图片磁盘存储 IPC + 自定义协议 */
export function registerWhiteboardAssetIPC(): void {
  registerWhiteboardAssetProtocol()
  ipcMain.handle(IPC_CHANNELS.WHITEBOARD_SAVE_IMAGE, (_e, dataUrl: string) => {
    try {
      return saveImageAsset(dataUrl)
    } catch (err) {
      console.error('[whiteboard-asset] 图片保存失败:', err)
      throw err
    }
  })
}
