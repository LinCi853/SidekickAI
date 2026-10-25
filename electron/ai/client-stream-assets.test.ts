import { describe, expect, it, vi } from 'vitest'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('undici', () => ({ request }))
vi.mock('../store/proxy-helper.js', () => ({ getProxyDispatcher: () => undefined }))
import { streamChat } from './client'
import type { CustomAIProvider } from '../shared/chat.types'

const provider: CustomAIProvider = {
  id: 'fixture',
  name: 'Fixture',
  protocol: 'openai',
  apiEndpoint: 'http://fixture.test',
  apiKey: 'fixture',
  model: 'fixture',
  createdAt: 0,
  updatedAt: 0,
}
function response(frames: unknown[]) {
  request.mockResolvedValue({
    statusCode: 200,
    body: (async function* () {
      for (const frame of frames)
        yield Buffer.from(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    })(),
  })
}
describe('reasoning and interrupted streams', () => {
  it('keeps OpenAI-compatible reasoning separate from visible output', async () => {
    response([
      { choices: [{ delta: { reasoning_content: '想😀' } }] },
      { choices: [{ delta: { content: '好' } }] },
      '[DONE]',
    ])
    const thought = vi.fn()
    const output = vi.fn()
    const done = vi.fn()
    await streamChat(provider, [], {
      onDelta: output,
      onReasoningDelta: thought,
      onDone: done,
      onError: vi.fn(),
    })
    expect(thought).toHaveBeenCalledWith('想😀')
    expect(output).toHaveBeenCalledWith('好')
    expect(done).toHaveBeenCalledWith('好')
  })
  it('reports an Anthropic server error after partial reasoning and does not claim completion', async () => {
    response([
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'partial thought' },
      },
      { type: 'error', error: { message: 'network interrupted' } },
    ])
    const error = vi.fn()
    const done = vi.fn()
    const thought = vi.fn()
    await streamChat({ ...provider, protocol: 'anthropic' }, [], {
      onDelta: vi.fn(),
      onReasoningDelta: thought,
      onDone: done,
      onError: error,
    })
    expect(thought).toHaveBeenCalledWith('partial thought')
    expect(error).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
  it('reports a stream that ends without a protocol completion marker', async () => {
    response([{ choices: [{ delta: { content: 'partial output' } }] }])
    const error = vi.fn(),
      done = vi.fn(),
      output = vi.fn()
    await streamChat(provider, [], { onDelta: output, onDone: done, onError: error })
    expect(output).toHaveBeenCalledWith('partial output')
    expect(error).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
  it('keeps reading when a compatible gateway repeats finish_reason on every frame', async () => {
    // 部分中转/自建网关每帧都带 finish_reason；首帧即收尾会把回复截断成空。
    response([
      { choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] },
      { choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const output = vi.fn(),
      done = vi.fn(),
      error = vi.fn()
    await streamChat(provider, [], { onDelta: output, onDone: done, onError: error })
    expect(output.mock.calls.map((call) => call[0]).join('')).toBe('你好，世界')
    expect(done).toHaveBeenCalledWith('你好，世界')
    expect(error).not.toHaveBeenCalled()
  })
  it('completes on finish_reason alone for services that never send [DONE]', async () => {
    response([
      { choices: [{ delta: { content: '完整回复' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const done = vi.fn(),
      error = vi.fn()
    await streamChat(provider, [], { onDelta: vi.fn(), onDone: done, onError: error })
    expect(done).toHaveBeenCalledWith('完整回复')
    expect(error).not.toHaveBeenCalled()
  })
  it('keeps the payload when a usage-only frame carries an empty choices array', async () => {
    response([
      { choices: [{ delta: { content: '回复' } }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      '[DONE]',
    ])
    const done = vi.fn(),
      usage = vi.fn(),
      error = vi.fn()
    await streamChat(provider, [], {
      onDelta: vi.fn(),
      onDone: done,
      onError: error,
      onUsage: usage,
    })
    expect(done).toHaveBeenCalledWith('回复')
    expect(usage).toHaveBeenCalledWith({ promptTokens: 7, completionTokens: 3 })
  })
  it('applies a connect and idle timeout to the streaming request', async () => {
    response([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]'])
    await streamChat(provider, [], { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() })
    const options = request.mock.calls.at(-1)![1]
    expect(options.headersTimeout).toBeGreaterThan(0)
    expect(options.bodyTimeout).toBeGreaterThan(options.headersTimeout)
  })
})
