import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { replaceRestoreEntries, validateRestoreDirectory, RestoreRecoveryError } from './restore-files.js'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-restore-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('backup validation', () => {
  it('rejects a corrupt database before replacing user data', () => {
    fs.writeFileSync(path.join(directory, 'settings.db'), 'not a database')
    expect(() => validateRestoreDirectory(directory)).toThrow()
  })

  it('rejects an unrelated SQLite file with no application settings table', () => {
    const db = new Database(path.join(directory, 'settings.db'))
    db.exec('CREATE TABLE unrelated (value TEXT)')
    db.close()
    expect(() => validateRestoreDirectory(directory)).toThrow()
  })

  it('validates each included database', () => {
    const settings = new Database(path.join(directory, 'settings.db'))
    settings.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)')
    settings.close()
    fs.writeFileSync(path.join(directory, 'notes.db'), 'corrupt notes')
    expect(() => validateRestoreDirectory(directory)).toThrow()
  })
})

describe('restoring included files', () => {
  function prepare() {
    const staging = path.join(directory, 'staging')
    const destination = path.join(directory, 'data')
    const recovery = path.join(directory, 'recovery')
    fs.mkdirSync(staging)
    fs.mkdirSync(destination)
    fs.writeFileSync(path.join(staging, 'settings.db'), 'incoming')
    fs.writeFileSync(path.join(destination, 'settings.db'), 'original')
    fs.writeFileSync(path.join(destination, 'settings.db-wal'), 'old WAL')
    fs.writeFileSync(path.join(destination, 'unrelated'), 'untouched')
    return { staging, destination, recovery }
  }

  it('replaces included roots, removes obsolete WAL and preserves omitted data', () => {
    const { staging, destination, recovery } = prepare()
    replaceRestoreEntries(staging, destination, recovery)
    expect(fs.readFileSync(path.join(destination, 'settings.db'), 'utf8')).toBe('incoming')
    expect(fs.readFileSync(path.join(recovery, 'settings.db'), 'utf8')).toBe('original')
    expect(fs.existsSync(path.join(destination, 'settings.db-wal'))).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'unrelated'), 'utf8')).toBe('untouched')
  })

  it('restores original bytes if a later included directory is locked', () => {
    const { staging, destination, recovery } = prepare()
    fs.mkdirSync(path.join(staging, 'zz-locked'))
    fs.mkdirSync(path.join(destination, 'zz-locked'))
    fs.writeFileSync(path.join(destination, 'zz-locked', 'sentinel'), 'original session')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (source === path.join(destination, 'zz-locked')) throw new Error('Directory is locked')
      rename(source, target)
    })
    expect(() => replaceRestoreEntries(staging, destination, recovery)).toThrow('original data was retained')
    expect(fs.readFileSync(path.join(destination, 'settings.db'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(destination, 'settings.db-wal'), 'utf8')).toBe('old WAL')
    expect(fs.readFileSync(path.join(destination, 'zz-locked', 'sentinel'), 'utf8')).toBe('original session')
  })

  it('retains recovery bytes and distinguishes an incomplete rollback', () => {
    const { staging, destination, recovery } = prepare()
    fs.mkdirSync(path.join(staging, 'zz-locked'))
    fs.mkdirSync(path.join(destination, 'zz-locked'))
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (source === path.join(destination, 'zz-locked') || source === path.join(recovery, 'settings.db')) {
        throw new Error('Directory is locked')
      }
      rename(source, target)
    })
    expect(() => replaceRestoreEntries(staging, destination, recovery)).toThrow(RestoreRecoveryError)
    expect(fs.readFileSync(path.join(recovery, 'settings.db'), 'utf8')).toBe('original')
  })
})
