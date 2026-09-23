import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export class RestoreRecoveryError extends Error {
  constructor(readonly recoveryDirectory: string, cause: unknown) {
    super(`Restore requires manual recovery from ${recoveryDirectory}`, { cause })
  }
}

export function validateRestoreDirectory(directory: string): void {
  const settings = path.join(directory, 'settings.db')
  if (!fs.existsSync(settings)) {
    const profiles = JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8'))
    if (!Array.isArray(profiles?.profiles)) throw new Error('Invalid legacy profile data')
  }
  function inspect(root: string): void {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Backup contains a filesystem link')
      if (entry.isDirectory()) inspect(file)
      else if (entry.name.endsWith('.db')) {
        const db = new Database(file, { readonly: true, fileMustExist: true })
        try {
          if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(`Invalid database: ${entry.name}`)
          if (file === settings) db.prepare('SELECT key, value FROM app_settings LIMIT 0').all()
        } finally { db.close() }
      }
    }
  }
  inspect(directory)
}

/** Replace included roots and retain their original bytes for rollback. */
export function replaceRestoreEntries(staging: string, destination: string, recovery: string): void {
  const roots = fs.readdirSync(staging)
  const entries = new Set(roots)
  for (const name of roots) {
    if (name.endsWith('.db')) {
      entries.add(`${name}-wal`)
      entries.add(`${name}-shm`)
    }
  }
  for (const name of entries) {
    const target = path.join(destination, name)
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`Restore destination is a filesystem link: ${name}`)
    }
  }
  fs.mkdirSync(recovery)
  fs.mkdirSync(destination, { recursive: true })
  const moved: string[] = []
  const installed: string[] = []
  try {
    for (const name of entries) {
      const target = path.join(destination, name)
      const incoming = path.join(staging, name)
      if (fs.existsSync(target)) {
        fs.renameSync(target, path.join(recovery, name))
        moved.push(name)
      }
      if (fs.existsSync(incoming)) {
        fs.renameSync(incoming, target)
        installed.push(name)
      }
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) fs.renameSync(path.join(destination, name), path.join(staging, name))
      for (const name of moved.reverse()) fs.renameSync(path.join(recovery, name), path.join(destination, name))
    } catch (rollbackError) {
      throw new RestoreRecoveryError(recovery, rollbackError)
    }
    throw new Error(`Restore failed; original data was retained: ${(error as Error).message}`, { cause: error })
  }
}
