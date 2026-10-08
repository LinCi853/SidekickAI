import { runBackupOperation } from './activity.js'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { exportBackup } from '../../../packages/backup-core/export.js'
import { exportTreeDigest } from '../../../packages/backup-core/files.js'
import { getDeviceId } from '../device-id.js'
import { validateRestoreDirectory } from '../restore-files.js'
import { closeChatStore } from '../chat-store.js'
import { closeAssetCollectionJournal, resumeAssetCollectionJournal } from '../../assets/collection-journal.js'
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
import { runBackupExport } from '../backup-activity.js'

export function exportAllData(target: string, options: ExportOptions, encrypt?: { password: string }, strict?: ExportStrictOptions) {
  return runBackupOperation('export', () => performExport(target, options, encrypt, strict))
}

async function performExport(target: string, options: ExportOptions, encrypt?: { password: string }, strict?: ExportStrictOptions) {
  let resumed = false
  const resumeCollection = () => { if (!resumed && !strict?.strict && !strict?.snapshot) { resumeAssetCollectionJournal(); resumed = true } }
  try {
    return await runBackupExport(() => exportBackup({
      edition: 'concept', root: getDataDir, version: () => app.getVersion(), deviceId: getDeviceId,
      closeDatabases: async () => {
        const { closeAllModuleDbs } = await import('../../modules/registry.js')
        await closeAllModuleDbs()
        for (const close of [closeAssetCollectionJournal, closeChatStore, closeWhiteboardDb, closeNotesDb, closeBookmarkStore, closeModuleStateDb, closeSearchHistoryStore, closeBrowserDownloadStore, closeNavHistoryStore, () => accumulatedLinksStore.close()]) close()
      },
      collect: collectSelectedExportEntries,
      validate: root => {
        const identity = path.join(root, 'edition-identity.json')
        if (fs.existsSync(identity)) {
          const value = JSON.parse(fs.readFileSync(identity, 'utf8'))
          if (value.schema !== 1 || value.edition !== 'sidekickai-opensource') throw new Error('Unrecognized user data ownership.')
        }
      },
      validateSnapshot: root => {
        const directory = fs.mkdtempSync(path.join(path.dirname(root), '.database-check-'))
        const copyDatabases = (source: string, targetDirectory: string) => {
          for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const input = path.join(source, entry.name)
            const output = path.join(targetDirectory, entry.name)
            if (entry.isDirectory()) { fs.mkdirSync(output, { recursive: true }); copyDatabases(input, output) }
            else if (/\.db(?:-wal|-shm|-journal)?$/.test(entry.name) || entry.name === 'profiles.json') fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL)
          }
        }
        try { copyDatabases(root, directory); validateRestoreDirectory(directory) }
        finally { fs.rmSync(directory, { recursive: true, force: true }) }
      },
      treeDigest: exportTreeDigest, verifySources: verifyQuiescentSnapshot,
    }, target, options, encrypt, { ...strict, onSnapshotReady: async () => { resumeCollection(); await strict?.onSnapshotReady?.() } }))
  }
  finally {
    try { resumeCollection() }
    catch (error) { console.warn('[ai-assets] Cannot resume collection after export:', error) }
  }
}
