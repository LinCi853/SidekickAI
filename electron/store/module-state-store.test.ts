import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'exe' ? path.join(runtime.directory, 'app.exe') : runtime.directory },
}))

let stores: typeof import('./module-state-store.js')

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  runtime.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-store-'))
  stores = await import('./module-state-store.js')
})

afterEach(() => {
  stores.closeModuleStateDb()
  fs.rmSync(runtime.directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('settings connection lifetime', () => {
  it('keeps existing consumers usable after the shared database is reopened', () => {
    const settings = stores.createSqliteJsonStore({ tableName: 'fixture', defaults: { title: 'initial' } })
    settings.set('title', 'saved')
    stores.closeModuleStateDb()
    settings.set('title', 'after-reopen')
    expect(settings.get('title')).toBe('after-reopen')
    const reader = stores.createSqliteJsonStore({ tableName: 'fixture', defaults: { title: 'initial' } })
    expect(reader.get('title')).toBe('after-reopen')
  })

  it('refreshes cached data when the database is replaced during restore', () => {
    const settings = stores.createSqliteJsonStore({ tableName: 'fixture', defaults: { title: 'initial' } })
    settings.set('title', 'old')
    stores.closeModuleStateDb()
    const restored = stores.createSqliteJsonStore({ tableName: 'fixture', defaults: { title: 'initial' } })
    restored.set('title', 'restored')
    expect(settings.get('title')).toBe('restored')
  })
})
