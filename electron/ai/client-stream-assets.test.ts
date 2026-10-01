import { describe, expect, it, vi } from 'vitest'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('undici', () => ({ request }))
vi.mock('../store/proxy-helper.js', () => ({ getProxyDispatcher: () => undefined }))
import { streamChat } from './client'
import type { CustomAIProvider } from '../shared/chat.types'

const provider: CustomAIProvider = { id: 'fixture', name: 'Fixture', protocol: 'openai', apiEndpoint: 'http://fixture.test',
  apiKey: 'fixture', model: 'fixture', createdAt: 0, updatedAt: 0 }
function response(frames: unknown[]) {
  request.mockResolvedValue({ statusCode: 200, body: (async function* () {
    for (const frame of frames) yield Buffer.from(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
  })() })
}
describe('reasoning and interrupted streams', () => {
  it('keeps OpenAI-compatible reasoning separate from visible output', async () => {
    response([{ choices: [{ delta: { reasoning_content: '想😀' } }] }, { choices: [{ delta: { content: '好' } }] }, '[DONE]'])
    const thought = vi.fn(); const output = vi.fn(); const done = vi.fn()
    await streamChat(provider, [], { onDelta: output, onReasoningDelta: thought, onDone: done, onError: vi.fn() })
    expect(thought).toHaveBeenCalledWith('想😀'); expect(output).toHaveBeenCalledWith('好'); expect(done).toHaveBeenCalledWith('好')
  })
  it('reports an Anthropic server error after partial reasoning and does not claim completion', async () => {
    response([{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'partial thought' } },
      { type: 'error', error: { message: 'network interrupted' } }])
    const error = vi.fn(); const done = vi.fn(); const thought = vi.fn()
    await streamChat({ ...provider, protocol: 'anthropic' }, [], { onDelta: vi.fn(), onReasoningDelta: thought, onDone: done, onError: error })
    expect(thought).toHaveBeenCalledWith('partial thought'); expect(error).toHaveBeenCalled(); expect(done).not.toHaveBeenCalled()
  })
  it('reports a stream that ends without a protocol completion marker', async () => {
    response([{ choices: [{ delta: { content: 'partial output' } }] }])
    const error = vi.fn(), done = vi.fn(), output = vi.fn()
    await streamChat(provider, [], { onDelta: output, onDone: done, onError: error })
    expect(output).toHaveBeenCalledWith('partial output')
    expect(error).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
})
