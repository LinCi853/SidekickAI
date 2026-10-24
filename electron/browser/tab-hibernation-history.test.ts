import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TabHibernationEntry } from '../shared/tab-hibernation.types.js'
const assetsDir = path.join(os.tmpdir(), `sidekick-hibernate-test-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => assetsDir } }))
const memoryStore = new Map<string, unknown>()
vi.mock('../store/module-state-store.js', () => ({
  createSqliteJsonStore: (options: { defaults: Record<string, unknown> }) => ({
    get: (key: string) => memoryStore.get(key) ?? options.defaults[key],
    set: (key: string, value: unknown) => memoryStore.set(key, value),
  }),
}))
const { TabHibernationStore } = await import('./tab-hibernate-store.js')
const image = '11111111-2222-3333-4444-555555555555.png'
const orphan = '22222222-2222-3333-4444-555555555555.jpg'
const directory = path.join(assetsDir, 'tab-hibernation')
const entry = (tabId: string, hibernatedAt: number, snapshotPath: string | null = null): TabHibernationEntry => ({
  tabId, hibernatedAt, snapshotPath, profileId: 'p', windowId: 'main', url: 'https://example.test', title: tabId,
})
describe('historical hibernation data', () => {
  const store = new TabHibernationStore()
  beforeEach(() => { memoryStore.clear(); fs.mkdirSync(assetsDir, { recursive: true }) })
  afterEach(() => { fs.rmSync(assetsDir, { recursive: true, force: true }); vi.restoreAllMocks() })
  it('reads metadata without creating an empty snapshot directory', () => {
    memoryStore.set('entries', [entry('a', 1), entry('b', 2)])
    expect(store.list().map(item => item.tabId)).toEqual(['b', 'a'])
    expect(store.snapshotStats()).toEqual({ snapshotCount: 0, snapshotBytes: 0 })
    expect(fs.existsSync(directory)).toBe(false)
  })
  it('counts actual and orphan images once, excluding missing files, directories and unrelated files', () => {
    memoryStore.set('entries', [entry('a', 1, image), entry('b', 2)])
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, image), Buffer.alloc(70))
    fs.writeFileSync(path.join(directory, orphan), Buffer.alloc(128))
    fs.writeFileSync(path.join(directory, 'unrelated.txt'), Buffer.alloc(256))
    fs.mkdirSync(path.join(directory, '33333333-2222-3333-4444-555555555555.png'))
    expect(store.snapshotStats()).toEqual({ snapshotCount: 2, snapshotBytes: 198 })
    fs.unlinkSync(path.join(directory, image))
    expect(store.snapshotStats()).toEqual({ snapshotCount: 1, snapshotBytes: 128 })
    expect(store.list()).toHaveLength(2)
  })
  it('reports inaccessible stats instead of a false zero', () => {
    vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }) })
    expect(() => store.snapshotStats()).toThrow('Denied')
  })
  it('prunes expired metadata and images while retaining recent data and removing orphans', () => {
    const now = 10 * 86_400_000
    memoryStore.set('entries', [entry('old', 1, image), entry('recent', now)])
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, image), 'old')
    fs.writeFileSync(path.join(directory, orphan), 'orphan')
    expect(store.prune({ retentionDays: 7, maxCount: 40 }, now)).toEqual({ removed: 1, expired: 1, orphans: 1 })
    expect(store.list().map(item => item.tabId)).toEqual(['recent'])
    expect(fs.readdirSync(directory)).toEqual([])
  })
  it('keeps newest records under the count limit and treats zero limits as unlimited', () => {
    memoryStore.set('entries', [entry('a', 1), entry('b', 2), entry('c', 3)])
    expect(store.prune({ retentionDays: 0, maxCount: 0 }, 1_000_000)).toEqual({ removed: 0, expired: 0, orphans: 0 })
    expect(store.prune({ retentionDays: 0, maxCount: 2 }, 1_000_000)).toEqual({ removed: 1, expired: 0, orphans: 0 })
    expect(store.list().map(item => item.tabId)).toEqual(['c', 'b'])
  })
  it('does not follow unsafe historical snapshot paths during pruning', () => {
    const outside = path.join(assetsDir, 'protected.txt')
    fs.writeFileSync(outside, 'keep')
    memoryStore.set('entries', [entry('old', 0, '../protected.txt')])
    store.prune({ retentionDays: 1, maxCount: 1 }, 2 * 86_400_000)
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
  })
})
