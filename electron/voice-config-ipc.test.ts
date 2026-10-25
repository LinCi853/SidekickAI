import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  voice: {} as Record<string, unknown>,
  tts: {} as Record<string, unknown>,
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      fixture.handlers.set(channel, handler),
  },
}))
vi.mock('./modules/plugins/voice/config-store.js', () => ({
  getVoiceSettings: () => ({ ...fixture.voice }),
  updateVoiceSettings: (patch: Record<string, unknown>) => {
    Object.assign(fixture.voice, patch)
    return fixture.voice
  },
}))
vi.mock('./modules/plugins/tts/config-store.js', () => ({
  getTtsSettings: () => ({ ...fixture.tts }),
  updateTtsSettings: (patch: Record<string, unknown>) => {
    Object.assign(fixture.tts, patch)
    return fixture.tts
  },
}))

import { getVoiceConfig, registerVoiceConfigIPC, updateVoiceConfig } from './voice-config-ipc'
import { IPC_CHANNELS as ipc } from './shared/types'

beforeEach(() => {
  fixture.handlers.clear()
  fixture.voice = { confirmMode: 'auto', inputMethod: 'layered', enterToSend: false, sttMode: 'ai' }
  fixture.tts = { ttsMode: 'disable', ttsProvider: '' }
})

describe('merged voice config', () => {
  it('combines voice and tts fields', () => {
    fixture.tts = { ttsMode: 'ai', ttsProvider: 'provider-a' }

    expect(getVoiceConfig()).toEqual({
      confirmMode: 'auto',
      inputMethod: 'layered',
      enterToSend: false,
      sttMode: 'ai',
      ttsMode: 'ai',
      ttsProvider: 'provider-a',
    })
  })

  it('routes voice fields and tts fields to their own stores', () => {
    updateVoiceConfig({ sttMode: 'local', ttsMode: 'ai', ttsProvider: 'provider-a' })

    expect(fixture.voice).toMatchObject({ sttMode: 'local' })
    expect(fixture.voice).not.toMatchObject({ ttsMode: 'ai' })
    expect(fixture.tts).toEqual({ ttsMode: 'ai', ttsProvider: 'provider-a' })
  })

  it('registers both config IPC channels', () => {
    const scope = { ipcHandle: vi.fn() }
    registerVoiceConfigIPC(scope as any)

    expect(scope.ipcHandle).toHaveBeenCalledWith(ipc.VOICE_GET_CONFIG, expect.any(Function))
    expect(scope.ipcHandle).toHaveBeenCalledWith(ipc.VOICE_SET_CONFIG, expect.any(Function))
  })
})
