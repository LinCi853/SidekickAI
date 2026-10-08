// Owns note write handlers and database lifecycle; image reads remain available.

import { EffectScope } from '../effect-scope.js'
import { registerNotesIPC, closeNotesDb } from '../../store/notes-db.js'
import { registerNotesAssetIPC } from '../../store/notes-asset-store.js'
import { registerNotesExtraIpc } from '../../ipc/notes-ipc.js'
import { resolveSqlitePath } from '../../store/store-paths.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const scope = new EffectScope('notes', 'notes')

export async function initNotesModule(): Promise<void> {
  await scope.dispose()
  registerNotesIPC(scope)
  registerNotesAssetIPC(scope)
  registerNotesExtraIpc(scope)
}

export async function teardownNotesModule(): Promise<void> {
  await scope.dispose()
  try {
    closeNotesDb()
  } catch (err) {
    console.warn('[wiring:notes] 关闭数据库失败:', err)
  }
}

export async function clearNotesData(): Promise<void> {
  await teardownNotesModule()
  const dbPath = resolveSqlitePath('notes.db')
  const assetsDir = path.join(app.getPath('userData'), 'notes-assets')
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true })
  console.log('[wiring:notes] 数据已清除')
}
