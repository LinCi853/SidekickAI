import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { snapshotSqliteDatabase } from './sqlite-snapshot.js'
import { validateRestoreDirectory } from './restore-files.js'
import { safeExtractAll } from '../utils/safe-zip.js'
import { encryptFile, decryptFile } from '../utils/file-crypto.js'

/** Archive every persistent file in the verified root before authorizing its removal. */
export async function exportForUninstall(root: string, output: string, password?: string): Promise<void> {
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'edition-identity.json'), 'utf8'))
  if (identity.schema !== 1 || identity.edition !== 'sidekickai-opensource') throw new Error('Unrecognized user data ownership')
  if (fs.existsSync(output)) throw new Error('Backup destination already exists')
  const temporary = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-uninstall-export-'))
  const zip = new AdmZip()
  try {
    async function collect(directory: string): Promise<void> {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        const relative = path.relative(root, file).split(path.sep).join('/')
        if (entry.isSymbolicLink()) throw new Error('User data contains a filesystem link: ' + relative)
        if (entry.isDirectory()) { await collect(file); continue }
        if (/\.db-(wal|shm)$/.test(entry.name) && fs.existsSync(file.slice(0, -4))) continue
        if (entry.name.endsWith('.db')) {
          const snapshot = path.join(temporary, 'snapshots', relative)
          fs.mkdirSync(path.dirname(snapshot), { recursive: true })
          await snapshotSqliteDatabase(file, snapshot)
          zip.addFile(relative, fs.readFileSync(snapshot))
        } else zip.addFile(relative, fs.readFileSync(file))
      }
    }
    await collect(root)
    if (!zip.getEntry('manifest.json')) {
      zip.addFile('manifest.json', Buffer.from(JSON.stringify({ appVersion: app.getVersion(), edition: 'sidekickai-opensource', exportedAt: new Date().toISOString(), fullUserData: true })))
    }
    const archive = path.join(temporary, 'verified.zip')
    zip.writeZip(archive)
    const restored = path.join(temporary, 'restored')
    fs.mkdirSync(restored)
    const reopened = new AdmZip(archive)
    if (safeExtractAll(reopened, restored, { tag: '[UninstallExport]' }) !== reopened.getEntries().filter(entry => !entry.isDirectory).length) throw new Error('Backup extraction was incomplete')
    validateRestoreDirectory(restored)
    for (const entry of reopened.getEntries()) {
      if (!entry.isDirectory && !fs.readFileSync(path.join(restored, entry.entryName)).equals(entry.getData())) throw new Error('Backup content verification failed')
    }
    let verified = archive
    if (password) {
      verified = path.join(temporary, 'verified.sabackup')
      encryptFile(archive, verified, password, 'sidekickai-opensource-uninstall')
      const decrypted = path.join(temporary, 'decrypted.zip')
      if (!decryptFile(verified, decrypted, password) || !fs.readFileSync(decrypted).equals(fs.readFileSync(archive))) throw new Error('Encrypted backup verification failed')
    }
    fs.copyFileSync(verified, output, fs.constants.COPYFILE_EXCL)
    if (!fs.readFileSync(output).equals(fs.readFileSync(verified))) throw new Error('Backup verification failed')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
