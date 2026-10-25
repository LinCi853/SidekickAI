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

describe('voice config store', () => {
  let store: typeof import('./config-store.js')

  beforeEach(async () => {
    tables.clear()
    vi.resetModules()
    store = await import('./config-store.js')
  })

  it('returns voice defaults without TTS fields', () => {
    const config = store.getVoiceSettings()

    expect(config).toEqual({
      confirmMode: 'auto',
      inputMethod: 'layered',
      enterToSend: false,
      sttMode: 'ai',
      aiProvider: '',
      language: 'zh',
      inputDeviceId: '',
      inputDeviceList: [],
      localExePath: '',
      localArgs: '',
    })
    expect('ttsMode' in config).toBe(false)
  })

  it('merges stored voice fields with defaults', () => {
    store.updateVoiceSettings({ language: 'en' })

    const config = store.getVoiceSettings()
    expect(config.language).toBe('en')
    expect(config.confirmMode).toBe('auto')
  })

  it('keeps unpatched fields across updates', () => {
    store.updateVoiceSettings({ language: 'en' })
    store.updateVoiceSettings({ enterToSend: true })
    store.updateVoiceSettings({ sttMode: 'local' })

    const config = store.getVoiceSettings()
    expect(config.language).toBe('en')
    expect(config.enterToSend).toBe(true)
    expect(config.sttMode).toBe('local')
    expect(config.confirmMode).toBe('auto')
  })
})
