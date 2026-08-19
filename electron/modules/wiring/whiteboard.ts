// electron/modules/wiring/whiteboard.ts — 画板/白板模块接线（init / teardown / clearData）
//
// init：注册白板 IPC + 图片资产协议/IPC + 截图推送到白板 handler（从 main.ts 迁入）。
// teardown：卸载全部通道 + 关闭数据库（11.5 关闭残留清单）。
// clearData：删除 whiteboard.db 与 whiteboard-assets/（不可逆）。
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerWhiteboardIPC, closeWhiteboardDb } from '../../store/whiteboard-db.js'
import { registerWhiteboardAssetIPC } from '../../store/whiteboard-asset-store.js'
import { migrateWhiteboardNotes } from '../../store/migrate-whiteboard-notes.js'
import { openAdvancedPanelWindow } from '../../window-factory.js'
import { windowState } from '../../window-state.js'
import { resolveSqlitePath } from '../../store/store-paths.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

/** 模块级 EffectScope */
const scope = new EffectScope('whiteboard', 'whiteboard')

const WHITEBOARD_CHANNELS = [
  IPC_CHANNELS.WHITEBOARD_LIST,
  IPC_CHANNELS.WHITEBOARD_CREATE,
  IPC_CHANNELS.WHITEBOARD_RENAME,
  IPC_CHANNELS.WHITEBOARD_DELETE,
  IPC_CHANNELS.WHITEBOARD_REORDER,
  IPC_CHANNELS.WHITEBOARD_GET_ACTIVE,
  IPC_CHANNELS.WHITEBOARD_SET_ACTIVE,
  IPC_CHANNELS.WHITEBOARD_GET_SNAPSHOT,
  IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT,
  IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT_SYNC,
  IPC_CHANNELS.WHITEBOARD_SAVE_IMAGE,
  IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE_REQUEST,
]

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

export function initWhiteboardModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 一次性数据迁移（幂等）：electron-store JSON → SQLite
    migrateWhiteboardNotes()
    // 传递 scope 给 registerWhiteboardIPC，使其使用 EffectScope 管理 IPC handler
    registerWhiteboardIPC(scope)
    // 注意：registerWhiteboardAssetIPC 内部已含协议注册，勿重复调用 registerWhiteboardAssetProtocol
    registerWhiteboardAssetIPC()
    scope.ipcHandle(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE_REQUEST, (_e, payload) =>
      handleWhiteboardPushImage(payload),
    )
  })
}

export function teardownWhiteboardModule(): void {
  void scope.dispose()
  try {
    closeWhiteboardDb()
  } catch (err) {
    console.warn('[wiring:whiteboard] 关闭数据库失败:', err)
  }
}

export function clearWhiteboardData(): void {
  teardownWhiteboardModule()
  const dbPath = resolveSqlitePath('whiteboard.db')
  const assetsDir = path.join(app.getPath('userData'), 'whiteboard-assets')
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true })
  console.log('[wiring:whiteboard] 数据已清除')
}
