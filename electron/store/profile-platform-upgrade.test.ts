import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from '../shared/types'

const memory = vi.hoisted(() => ({ profiles: [] as Profile[], version: 1 }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, session: {} }))
vi.mock('../shared/broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('./module-state-store', () => ({ createSqliteJsonStore: () => ({
  get: (key: keyof typeof memory) => memory[key],
  set: (key: keyof typeof memory, value: never) => { memory[key] = value },
}) }))
vi.mock('./preset-store', () => ({ getPreset: () => ({ viewport: { width: 393, height: 852 }, devicePixelRatio: 3, language: 'zh-CN', timezone: 'Asia/Shanghai' }) }))
import { ensureDefaultProfiles, profileStore } from './profile-store'

describe('persisted platform upgrade', () => {
  beforeEach(() => { memory.profiles = []; memory.version = 1 })
  it('upgrades the old palette and adds Qianwen only once', () => {
    const existing = { id: 'same-partition', name: 'My Doubao', isAIPlatform: true, aiPlatformId: 'doubao', aiThemeColor: '#3370ff', order: 5 } as Profile
    memory.profiles = [existing]
    const added = ensureDefaultProfiles()
    expect(added).toHaveLength(1)
    expect(added[0].aiPlatformId).toBe('qianwen')
    expect(memory.profiles[0]).toEqual({ ...existing, aiThemeColor: '#d64f68' })
    expect(memory.version).toBe(2)
    profileStore.delete(added[0].id)
    expect(ensureDefaultProfiles()).toEqual([])
    expect(memory.profiles).toHaveLength(1)
  })
  it('retains a custom Qianwen profile and a custom accent', () => {
    memory.profiles = [{ id: 'custom', name: 'Personal', isAIPlatform: true, aiPlatformUrl: 'https://www.qianwen.com/chat/existing', aiThemeColor: '#abc' } as Profile]
    expect(ensureDefaultProfiles()).toEqual([])
    expect(memory.profiles[0].aiThemeColor).toBe('#abc')
    expect(memory.profiles[0].id).toBe('custom')
  })
  it('creates ten presets for a fresh user and keeps the upgrade completed', () => {
    expect(ensureDefaultProfiles()).toHaveLength(10)
    expect(memory.profiles.filter(profile => profile.aiPlatformId === 'qianwen')).toHaveLength(1)
    expect(memory.version).toBe(2)
    expect(ensureDefaultProfiles()).toEqual([])
  })
  it('retains an intentionally empty profile list after the upgrade', () => {
    memory.version = 2
    expect(ensureDefaultProfiles()).toEqual([])
    expect(memory.profiles).toEqual([])
  })
})
