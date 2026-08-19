import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}))

// Mock module-state-store (voice-store uses createSqliteJsonStore from here)
vi.mock('./module-state-store.js', () => ({
  createSqliteJsonStore: vi.fn(() => {
    let data: Record<string, unknown> = {}
    return {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => {
        data[key] = value
      },
      delete: (key: string) => {
        delete data[key]
      },
      has: (key: string) => key in data,
    }
  }),
}))

describe('voice-store', () => {
  let voiceStore: typeof import('./voice-store.js')

  beforeEach(async () => {
    vi.resetModules()
    voiceStore = await import('./voice-store.js')
  })

  describe('getVoiceConfig', () => {
    it('should return default config', () => {
      const config = voiceStore.getVoiceConfig()

      expect(config.confirmMode).toBe('auto')
      expect(config.inputMethod).toBe('layered')
      expect(config.enterToSend).toBe(false)
      expect(config.sttMode).toBe('ai')
      expect(config.language).toBe('zh')
      expect(config.ttsMode).toBe('disable')
    })

    it('should merge stored config with defaults', () => {
      voiceStore.updateVoiceConfig({ language: 'en' })

      const config = voiceStore.getVoiceConfig()
      expect(config.language).toBe('en')
      expect(config.confirmMode).toBe('auto') // default preserved
    })
  })

  describe('updateVoiceConfig', () => {
    it('should update config with patch', () => {
      const updated = voiceStore.updateVoiceConfig({ language: 'en', enterToSend: true })

      expect(updated.language).toBe('en')
      expect(updated.enterToSend).toBe(true)
    })

    it('should preserve unpatched fields', () => {
      voiceStore.updateVoiceConfig({ language: 'en' })
      const config = voiceStore.getVoiceConfig()

      expect(config.language).toBe('en')
      expect(config.confirmMode).toBe('auto') // preserved
      expect(config.sttMode).toBe('ai') // preserved
    })

    it('should handle multiple updates', () => {
      voiceStore.updateVoiceConfig({ language: 'en' })
      voiceStore.updateVoiceConfig({ enterToSend: true })
      voiceStore.updateVoiceConfig({ sttMode: 'local' })

      const config = voiceStore.getVoiceConfig()
      expect(config.language).toBe('en')
      expect(config.enterToSend).toBe(true)
      expect(config.sttMode).toBe('local')
    })
  })

  describe('registerVoiceConfigIPC', () => {
    it('should register IPC handlers with scope', () => {
      const mockScope = {
        ipcHandle: vi.fn(),
      }

      voiceStore.registerVoiceConfigIPC(mockScope as any)

      expect(mockScope.ipcHandle).toHaveBeenCalledWith('voice:getConfig', expect.any(Function))
      expect(mockScope.ipcHandle).toHaveBeenCalledWith('voice:setConfig', expect.any(Function))
    })
  })
})
