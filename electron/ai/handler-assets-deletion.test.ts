import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  store: undefined as any,
  stream: vi.fn(),
  originals: vi.fn(async () => {}),
  callbacks: undefined as any,
  resolveStream: undefined as undefined | (() => void),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => fixture.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
}))
vi.mock('../store/chat-store.js', async original => ({ ...await original<any>(), getChatStore: () => fixture.store }))
vi.mock('../store/ai-provider-store.js', () => ({ aiProviderStore: { get: () => ({ id: 'provider', name: 'Fixture', protocol: 'openai' }) } }))
vi.mock('../store/app-settings-store.js', () => ({ getAppSettings: () => ({}) }))
vi.mock('../store/injection-history-store.js', () => ({ injectionHistoryStore: {} }))
vi.mock('../notify.js', () => ({ showNotification: vi.fn() }))
vi.mock('../assets/asset-ipc.js', () => ({ registerAiAssetIpc: vi.fn() }))
vi.mock('../assets/api-originals.js', () => ({ collectApiOriginals: fixture.originals }))
vi.mock('../assets/import-activity.js', () => ({ runAssetImport: vi.fn() }))
vi.mock('./client.js', () => ({ streamChat: fixture.stream, testProvider: vi.fn(), listModels: vi.fn() }))
import { ChatStore } from '../store/chat-store'
import { registerAIChatIPC, cleanupActiveStreams } from './handler'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels'

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); fixture.handlers.clear()
  fixture.store = new ChatStore(':memory:')
  fixture.stream.mockImplementation(async (_provider, _history, callbacks) => {
    fixture.callbacks = callbacks
    await new Promise<void>(resolve => { fixture.resolveStream = resolve })
  })
  registerAIChatIPC()
})
afterEach(async () => {
  cleanupActiveStreams(); fixture.resolveStream?.()
  await Promise.resolve(); await Promise.resolve()
  fixture.store.close(); fixture.resolveStream = undefined; vi.useRealTimers()
})

describe('API asset deletion during recording', () => {
  it.each(['message', 'conversation'] as const)('keeps a deleted %s absent across partial flush and completion', async target => {
    const conversation = fixture.store.createConversation('provider', 'api', 'Fixture')
    const sender = { isDestroyed: () => false, send: vi.fn() }
    await fixture.handlers.get(ipc.CHAT_SEND)!({ sender }, { providerId: 'provider', conversationId: conversation.id, message: 'Question' })
    fixture.callbacks.onDelta('First'); vi.advanceTimersByTime(100)
    const output = fixture.store.listMessages(conversation.id).find((message: any) => message.role === 'assistant')!
    if (target === 'message') fixture.store.deleteMessage(output.id)
    else fixture.store.deleteConversation(conversation.id)
    fixture.originals.mockClear()
    fixture.callbacks.onDelta(' second'); vi.advanceTimersByTime(100)
    expect(fixture.store.listMessages(conversation.id).some((message: any) => message.role === 'assistant')).toBe(false)
    expect(() => fixture.callbacks.onDone('First second')).not.toThrow()
    expect(fixture.store.listMessages(conversation.id).some((message: any) => message.role === 'assistant')).toBe(false)
    expect(fixture.originals).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenLastCalledWith(ipc.CHAT_STREAM_END, expect.objectContaining({ assistantMessageId: undefined }))
    if (target === 'conversation') expect(fixture.store.listConversations()).toEqual([])
  })

  it('rejects sending to a deleted conversation before starting a stream', async () => {
    const conversation = fixture.store.createConversation('provider', 'api', 'Fixture')
    fixture.store.deleteConversation(conversation.id)
    await expect(fixture.handlers.get(ipc.CHAT_SEND)!({ sender: { isDestroyed: () => false, send: vi.fn() } }, {
      providerId: 'provider', conversationId: conversation.id, message: 'Question',
    })).rejects.toThrow()
    expect(fixture.stream).not.toHaveBeenCalled()
  })
})
