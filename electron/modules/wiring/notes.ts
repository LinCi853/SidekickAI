// electron/modules/wiring/notes.ts — 笔记模块接线（init / teardown / clearData）
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerNotesIPC, closeNotesDb } from '../../store/notes-db.js'
import { registerNotesAssetIPC } from '../../store/notes-asset-store.js'
import { registerNotesExtraIpc } from '../../ipc/notes-ipc.js'
import { resolveSqlitePath } from '../../store/store-paths.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

/** 模块级 EffectScope */
const scope = new EffectScope('notes', 'notes')

const NOTES_CHANNELS = [
  IPC_CHANNELS.NOTES_LIST,
  IPC_CHANNELS.NOTES_SEARCH,
  IPC_CHANNELS.NOTES_SAVE,
  IPC_CHANNELS.NOTES_SAVE_SYNC,
  IPC_CHANNELS.NOTES_DELETE,
  IPC_CHANNELS.NOTES_GET_ACTIVE,
  IPC_CHANNELS.NOTES_SET_ACTIVE,
  IPC_CHANNELS.NOTES_SET_PINNED,
  IPC_CHANNELS.NOTES_SET_TAGS,
  IPC_CHANNELS.NOTES_LIST_TAGS,
  IPC_CHANNELS.NOTES_SEND_TO_AI,
  IPC_CHANNELS.NOTES_SAVE_AS_PROMPT,
  IPC_CHANNELS.NOTES_SAVE_IMAGE,
]

export function initNotesModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 传递 scope 给 registerNotesIPC，使其使用 EffectScope 管理 IPC handler
    registerNotesIPC(scope)
    // 注意：registerNotesAssetIPC 内部已含协议注册，勿重复调用 registerNotesAssetProtocol
    registerNotesAssetIPC()
    // 传递 scope 给 registerNotesExtraIpc，使其使用 EffectScope 管理 IPC handler
    registerNotesExtraIpc(scope)
  })
}

export function teardownNotesModule(): void {
  void scope.dispose()
  try {
    closeNotesDb()
  } catch (err) {
    console.warn('[wiring:notes] 关闭数据库失败:', err)
  }
}

export function clearNotesData(): void {
  teardownNotesModule()
  const dbPath = resolveSqlitePath('notes.db')
  const assetsDir = path.join(app.getPath('userData'), 'notes-assets')
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true })
  console.log('[wiring:notes] 数据已清除')
}
