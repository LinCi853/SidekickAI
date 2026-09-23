import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotSqliteDatabase } from './sqlite-snapshot.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('online SQLite backup', () => {
  it('captures committed WAL records while the application connection remains writable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-snapshot-'))
    directories.push(directory)
    const source = path.join(directory, 'source.db')
    const target = path.join(directory, 'backup.db')
    const writer = new Database(source)
    try {
      writer.pragma('journal_mode = WAL')
      writer.exec('CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'before\')')
      await snapshotSqliteDatabase(source, target)
      writer.prepare('INSERT INTO records VALUES (?)').run('after')
      const snapshot = new Database(target, { readonly: true })
      try {
        expect(snapshot.prepare('SELECT value FROM records').all()).toEqual([{ value: 'before' }])
        expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(writer.prepare('SELECT count(*) AS count FROM records').get()).toEqual({ count: 2 })
      } finally { snapshot.close() }
    } finally { writer.close() }
  })
})
