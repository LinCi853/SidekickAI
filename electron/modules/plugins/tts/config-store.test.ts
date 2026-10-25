import { beforeEach, describe, expect, it, vi } from 'vitest'

const tables = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock('../../../store/module-state-store.js', () => ({
  createSqliteJsonStore: ({
    tableName,
    defaults,
  }: {
    tableName: string
    defaults: Record<string, unknown>
  }) => {
    const data = () => {
      if (!tables.has(tableName)) tables.set(tableName, { ...defaults })
      return tables.get(tableName)!
    }
    return {
      get: (key: string) => data()[key],
      set: (key: string, value: unknown) => {
        data()[key] = value
      },
      delete: (key: string) => {
        delete data()[key]
      },
      has: (key: string) => key in data(),
      invalidate: () => {},
    }
  },
}))

describe('tts config store', () => {
  let store: typeof import('./config-store.js')

  beforeEach(async () => {
    tables.clear()
    vi.resetModules()
    store = await import('./config-store.js')
  })

  it('returns defaults when no legacy TTS fields exist', () => {
    expect(store.getTtsSettings()).toEqual({ ttsMode: 'disable', ttsProvider: '' })
  })

  it('migrates TTS fields from the legacy voice_config table once', () => {
    tables.set('voice_config', {
      config: { confirmMode: 'auto', ttsMode: 'ai', ttsProvider: 'provider-a' },
      version: 2,
    })

    expect(store.getTtsSettings()).toEqual({ ttsMode: 'ai', ttsProvider: 'provider-a' })
    expect(tables.get('voice_config')?.config).toMatchObject({
      ttsMode: 'ai',
      ttsProvider: 'provider-a',
    })
    expect(tables.get('tts_config')).toMatchObject({ migratedFromVoice: true })

    tables.get('voice_config')!.config = { ttsMode: 'disable', ttsProvider: 'provider-b' }
    expect(store.getTtsSettings()).toEqual({ ttsMode: 'ai', ttsProvider: 'provider-a' })
  })

  it('updates only the tts_config storage', () => {
    store.updateTtsSettings({ ttsProvider: 'provider-a' })

    expect(store.getTtsSettings().ttsProvider).toBe('provider-a')
    expect(store.getTtsSettings().ttsMode).toBe('disable')
    expect(tables.get('tts_config')?.config).toEqual({
      ttsMode: 'disable',
      ttsProvider: 'provider-a',
    })
  })
})
