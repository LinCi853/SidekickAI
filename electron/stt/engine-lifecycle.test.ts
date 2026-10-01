import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ recognize: vi.fn(), cancel: vi.fn(async () => {}), stop: vi.fn(async () => new Float32Array(1600)) }))
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null } }))
vi.mock('../audio/capture.js', () => ({ AudioCapture: class { start = async () => {}; stop = fixture.stop; cancel = fixture.cancel } }))
vi.mock('../store/voice-store.js', () => ({ getVoiceConfig: () => ({ sttMode: 'ai', aiProvider: 'fixture' }) }))
vi.mock('../store/ai-provider-store.js', () => ({ aiProviderStore: { get: () => ({ id: 'fixture', apiKey: 'fixture', sttModel: 'whisper-1', apiEndpoint: 'https://fixture' }) }, deriveAudioEndpoint: () => 'https://fixture' }))
vi.mock('./ai-whisper.js', () => ({ recognizeWithOpenAiWhisper: fixture.recognize }))
vi.mock('./ai-mimo.js', () => ({ recognizeWithMimoAsr: vi.fn() }))
vi.mock('./local-exe.js', () => ({ recognizeWithLocalExe: vi.fn() }))
import { SttEngine } from './engine'

describe('speech lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())
  it('discards a late transcription after cancellation', async () => {
    let resolve!: (value: string) => void
    fixture.recognize.mockImplementation(() => new Promise<string>(done => { resolve = done }))
    const engine = new SttEngine()
    await engine.start()
    const pending = engine.stop()
    await vi.waitFor(() => expect(fixture.recognize).toHaveBeenCalled())
    engine.cleanup()
    resolve('late transcription')
    expect(await pending).toBe('')
    expect(fixture.cancel).toHaveBeenCalled()
  })
  it('allows a new recording after a canceled session', async () => {
    fixture.recognize.mockResolvedValue('new transcription')
    const engine = new SttEngine()
    await engine.start(); engine.cleanup(); await engine.start()
    expect(await engine.stop()).toBe('new transcription')
  })
})
