// electron/store/whiteboard-asset-store.ts — 白板图片磁盘存储
//
// v0.5.2 R-4：白板图片改为原图磁盘存储，不再压缩。
// 图片保存到 userData/whiteboard-assets/<uuid>.<ext>，WhiteboardCard.content 存 file:// 路径。
// 清理时由 clearAllData 统一处理（目录在 userData 下，递归删除已覆盖）。

import { app, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const ASSETS_DIR_NAME = 'whiteboard-assets'

function getAssetsDir(): string {
  const dir = path.join(app.getPath('userData'), ASSETS_DIR_NAME)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 将 dataURL 图片保存到磁盘，返回 file:// 路径 */
export function saveImageAsset(dataUrl: string): string {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片 dataURL')
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const buf = Buffer.from(match[2], 'base64')
  const filename = `${randomUUID()}.${ext}`
  const filepath = path.join(getAssetsDir(), filename)
  fs.writeFileSync(filepath, buf)
  return `file://${filepath.replace(/\\/g, '/')}`
}

/** 注册白板图片磁盘存储 IPC */
export function registerWhiteboardAssetIPC(): void {
  ipcMain.handle(IPC_CHANNELS.WHITEBOARD_SAVE_IMAGE, (_e, dataUrl: string) => {
    return saveImageAsset(dataUrl)
  })
}
