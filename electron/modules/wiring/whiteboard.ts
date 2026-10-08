// Owns whiteboard write handlers and database lifecycle; image reads remain available.

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerWhiteboardIPC, closeWhiteboardDb } from '../../store/whiteboard-db.js'
import { registerWhiteboardAssetIPC } from '../../store/whiteboard-asset-store.js'
import { openAdvancedPanelWindow } from '../../window-factory.js'
import { windowState } from '../../window-state.js'
import { resolveSqlitePath } from '../../store/store-paths.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const scope = new EffectScope('whiteboard', 'whiteboard')

/** 截图到白板：打开进阶面板 → 切到 whiteboard tab → 转发载荷（原 main.ts 内联 handler） */
function handleWhiteboardPushImage(
  payload: { assetUrl: string; sourceUrl?: string; platform?: string },
): { ok: boolean } {
  openAdvancedPanelWindow({ initialTab: 'whiteboard' })
  const win = windowState.advancedPanelWindow
  if (!win || win.isDestroyed()) return { ok: false }
  const sendPush = () => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, { tab: 'whiteboard' })
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE, payload)
      }
    }, 200)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', sendPush)
  } else {
    sendPush()
  }
  return { ok: true }
}

export async function initWhiteboardModule(): Promise<void> {
  await scope.dispose()
  registerWhiteboardIPC(scope)
  registerWhiteboardAssetIPC(scope)
  scope.ipcHandle(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE_REQUEST, (_e, payload) =>
    handleWhiteboardPushImage(payload),
  )
}

export async function teardownWhiteboardModule(): Promise<void> {
  await scope.dispose()
  try {
    closeWhiteboardDb()
  } catch (err) {
    console.warn('[wiring:whiteboard] 关闭数据库失败:', err)
  }
}

export async function clearWhiteboardData(): Promise<void> {
  await teardownWhiteboardModule()
  const dbPath = resolveSqlitePath('whiteboard.db')
  const assetsDir = path.join(app.getPath('userData'), 'whiteboard-assets')
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true })
  console.log('[wiring:whiteboard] 数据已清除')
}
