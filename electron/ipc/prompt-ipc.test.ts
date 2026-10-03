import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptTemplate } from '../shared/chat.types'

const runtime = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => runtime.handlers.set(channel, handler), on: vi.fn() } }))
import { registerPromptIpc } from './prompt-ipc'
import { IPC_CHANNELS } from '../shared/types'

const template: PromptTemplate = { id: 'a', title: 'Prompt', content: 'General text', example: { content: 'Private example', conversationId: 'conversation' }, createdAt: 1, updatedAt: 1 }
beforeEach(() => {
  runtime.handlers.clear(); runtime.send.mockClear()
  registerPromptIpc({ showPromptWindow: vi.fn(), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: runtime.send } }) as never, getPromptWindow: () => null })
})

describe('general prompt injection', () => {
  it('forwards general text without the saved example or source', () => {
    runtime.handlers.get(IPC_CHANNELS.PROMPT_INJECT_REQUEST)!({}, template)
    expect(runtime.send).toHaveBeenCalledWith(IPC_CHANNELS.PROMPT_INJECT_REQUEST, { id: 'a', title: 'Prompt', content: 'General text', createdAt: 1, updatedAt: 1 })
  })

  it('rejects case-only and malformed requests before forwarding', () => {
    const inject = runtime.handlers.get(IPC_CHANNELS.PROMPT_INJECT_REQUEST)!
    expect(() => inject({}, { ...template, content: ' ' })).toThrow('请先编写通用提示词')
    expect(() => inject({}, { ...template, example: { content: 7 } })).toThrow()
    expect(() => inject({}, null)).toThrow()
    expect(runtime.send).not.toHaveBeenCalled()
  })
})
