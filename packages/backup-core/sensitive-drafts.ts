import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { assertOrdinaryPath, atomicJson, samePath } from './io.js'
import { MAX_DRAFT_BYTES, MAX_DRAFT_ENTRIES, validDraftKey, validateSensitiveDrafts } from './sensitive-drafts-format.js'
import type { SensitiveDraftTransport } from './types.js'

interface DraftRow { key: string; value: string }
export interface SensitiveDraftRestoreResult { restored: number; unavailable: number }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
class DraftEncryptionUnavailable extends Error {
  constructor() { super('Sensitive draft encryption is unavailable.') }
}
function requireDraftEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new DraftEncryptionUnavailable()
}

function rows(database: Database.Database): DraftRow[] {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) return []
  const result = database.prepare("SELECT key,value FROM app_settings WHERE key GLOB 'windowDraft:*' ORDER BY key LIMIT ?").all(MAX_DRAFT_ENTRIES + 1) as DraftRow[]
  if (result.length > MAX_DRAFT_ENTRIES || result.some(row => !validDraftKey(row.key) || typeof row.value !== 'string' || Buffer.byteLength(row.value) > MAX_DRAFT_BYTES * 2)) throw new Error('Stored window drafts exceed the supported backup shape.')
  return result
}

function decode(value: string): unknown {
  requireDraftEncryption()
  const clear = safeStorage.decryptString(Buffer.from(value, 'base64'))
  if (Buffer.byteLength(clear) > MAX_DRAFT_BYTES) throw new Error('Sensitive draft exceeds its supported size.')
  return JSON.parse(clear)
}

/** Read the immutable database copy using the source application's active encryption context. */
export function captureBackupDrafts(root: string): SensitiveDraftTransport {
  if (!app.isReady()) throw new Error('Sensitive draft capture requires a ready encryption context.')
  const file = path.join(root, 'settings.db')
  assertOrdinaryPath(file)
  const database = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const transport: SensitiveDraftTransport = { version: 1, entries: rows(database).map(row => {
      const identity = { key: row.key, sourceSha256: digest(row.value) }
      try { return { ...identity, state: 'portable', value: decode(row.value) } }
      catch { return { ...identity, state: 'unavailable', reason: 'source-key-unavailable' } }
    }) }
    validateSensitiveDrafts(transport)
    return transport
  } finally { database.close() }
}

/** Rebind only matching draft records after Chromium has initialized the actual destination profile. */
export function restoreBackupDrafts(root: string, transport?: SensitiveDraftTransport): SensitiveDraftRestoreResult {
  if (!app.isReady() || !samePath(app.getPath('userData'), root)) throw new Error('Sensitive draft restoration requires the active destination encryption context.')
  if (transport !== undefined) validateSensitiveDrafts(transport)
  const databaseFile = path.join(root, 'settings.db')
  if (!fs.existsSync(databaseFile)) {
    if (transport?.entries.length) throw new Error('The restored database is missing its sensitive drafts.')
    return { restored: 0, unavailable: 0 }
  }
  assertOrdinaryPath(databaseFile)
  const database = new Database(databaseFile, { fileMustExist: true })
  const result: SensitiveDraftRestoreResult = { restored: 0, unavailable: 0 }
  try {
    const current = rows(database)
    if (current.length && !safeStorage.isEncryptionAvailable()) throw new Error('Sensitive draft encryption is unavailable on this system.')
    const byKey = new Map(current.map(row => [row.key, row]))
    const entries = transport?.entries ?? current.map(row => ({ key: row.key, sourceSha256: digest(row.value), state: 'unavailable' as const, reason: 'source-key-unavailable' as const }))
    const replacements: Array<{ key: string; original: string; value: string }> = []
    const discarded: DraftRow[] = []
    const checkStoredDraft = (row: DraftRow) => {
      try { decode(row.value); result.restored++ }
      catch (error) {
        if (error instanceof DraftEncryptionUnavailable) throw error
        requireDraftEncryption()
        discarded.push(row); result.unavailable++
      }
    }
    for (const entry of entries) {
      const row = byKey.get(entry.key)
      if (!row) {
        if (entry.state === 'unavailable') continue
        throw new Error('A sensitive draft listed by the backup is missing from the restored database.')
      }
      byKey.delete(entry.key)
      if (entry.state === 'portable') {
        const clear = JSON.stringify(entry.value)
        if (digest(row.value) !== entry.sourceSha256) {
          try { if (JSON.stringify(decode(row.value)) === clear) { result.restored++; continue } } catch { }
          throw new Error('A restored sensitive draft differs from its verified source.')
        }
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Sensitive draft encryption is unavailable on this system.')
        const encrypted = safeStorage.encryptString(clear).toString('base64')
        if (JSON.stringify(decode(encrypted)) !== clear) throw new Error('Sensitive draft encryption verification failed.')
        replacements.push({ key: row.key, original: row.value, value: encrypted })
        result.restored++
      } else {
        if (digest(row.value) !== entry.sourceSha256) throw new Error('An unavailable draft differs from its preserved source.')
        checkStoredDraft(row)
      }
    }
    for (const row of byKey.values()) {
      checkStoredDraft(row)
    }
    database.transaction(() => {
      if (current.length) requireDraftEncryption()
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) return
      const update = database.prepare('UPDATE app_settings SET value=? WHERE key=? AND value=?')
      for (const row of replacements) if (update.run(row.value, row.key, row.original).changes !== 1) throw new Error('Sensitive drafts changed during restoration.')
      const remove = database.prepare('DELETE FROM app_settings WHERE key=? AND value=?')
      for (const row of discarded) if (remove.run(row.key, row.value).changes !== 1) throw new Error('Sensitive drafts changed during restoration.')
      result.unavailable += database.prepare("DELETE FROM app_settings WHERE key GLOB 'windowDraftRecovery:*'").run().changes
    })()
    database.pragma('wal_checkpoint(TRUNCATE)')
  } finally { database.close() }
  const manifestFile = path.join(root, 'manifest.json')
  if (transport !== undefined && fs.existsSync(manifestFile)) {
    assertOrdinaryPath(manifestFile)
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (Object.hasOwn(manifest, 'sensitiveDrafts')) {
      delete manifest.sensitiveDrafts
      atomicJson(manifestFile, manifest)
    }
  }
  return result
}
