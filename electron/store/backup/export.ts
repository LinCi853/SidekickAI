import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { exportBackup } from '../../../packages/backup-core/export.js'
import { exportTreeDigest, writeStrictArchive, writePartialArchive } from '../../../packages/backup-core/files.js'
import { extractBackupArchive } from '../../../packages/backup-core/format.js'
import { getDeviceId } from '../device-id.js'
import { validateRestoreDirectory } from '../restore-files.js'
import { closeChatStore } from '../chat-store.js'
import { closeWhiteboardDb } from '../whiteboard-db.js'
import { closeNotesDb } from '../notes-db.js'
import { closeBookmarkStore } from '../bookmark-store.js'
import { closeModuleStateDb } from '../module-state-store.js'
import { closeSearchHistoryStore } from '../search-history-store.js'
import { closeBrowserDownloadStore } from '../browser-download-store.js'
import { closeNavHistoryStore } from '../nav-history-store.js'
import { accumulatedLinksStore } from '../accumulated-links-store.js'
import { getDataDir } from './paths.js'
import { collectSelectedExportEntries } from './collect.js'
import { verifyQuiescentSnapshot } from './verify.js'
import type { ExportOptions, ExportStrictOptions } from './types.js'

export async function exportAllData(target: string, options: ExportOptions, encrypt?: { password: string }, strict?: ExportStrictOptions) {
  return exportBackup({
    edition: 'concept', root: getDataDir, version: () => app.getVersion(), deviceId: getDeviceId,
    closeDatabases: async () => {
      const { closeAllModuleDbs } = await import('../../modules/registry.js')
      await closeAllModuleDbs()
      for (const close of [closeChatStore, closeWhiteboardDb, closeNotesDb, closeBookmarkStore, closeModuleStateDb, closeSearchHistoryStore, closeBrowserDownloadStore, closeNavHistoryStore, () => accumulatedLinksStore.close()]) close()
    },
    collect: collectSelectedExportEntries,
    validate: root => {
      const identity = path.join(root, 'edition-identity.json')
      if (fs.existsSync(identity)) {
        const value = JSON.parse(fs.readFileSync(identity, 'utf8'))
        if (value.schema !== 1 || value.edition !== 'sidekickai-opensource') throw new Error('Unrecognized user data ownership.')
      }
    },
    verifyPayload: zip => {
      const directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-backup-check-'))
      try { extractBackupArchive(zip, directory); validateRestoreDirectory(directory) }
      finally { fs.rmSync(directory, { recursive: true, force: true }) }
    },
    treeDigest: exportTreeDigest, verifySources: verifyQuiescentSnapshot,
    writeStrict: writeStrictArchive, writeLive: writePartialArchive,
  }, target, options, encrypt, strict)
}
