import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamAssetRecorder, type RecordedStream } from './stream-recorder'

describe('stream asset recorder', () => {
  afterEach(() => vi.useRealTimers())
  it('flushes partial output and reasoning and preserves stopped content once', () => {
    vi.useFakeTimers()
    const values: RecordedStream[] = []
    const recorder = new StreamAssetRecorder(value => values.push(value))
    recorder.append('reasoning', '想'); recorder.append('output', '答')
    vi.advanceTimersByTime(100)
    expect(values[0]).toEqual({ content: '答', reasoning: '想', status: 'streaming' })
    recorder.append('output', '案'); recorder.finish('stopped'); recorder.finish('complete')
    vi.runAllTimers()
    expect(values).toHaveLength(2)
    expect(values[1]).toEqual({ content: '答案', reasoning: '想', status: 'stopped' })
  })
  it('keeps persistence failures visible and retries all received content at completion', () => {
    vi.useFakeTimers()
    const persist = vi.fn().mockImplementationOnce(() => { throw new Error('disk full') })
    const recorder = new StreamAssetRecorder(persist)
    recorder.append('output', 'partial'); vi.advanceTimersByTime(100)
    expect(recorder.persistenceError?.message).toBe('disk full')
    recorder.finish('failed')
    expect(persist).toHaveBeenLastCalledWith({ content: 'partial', reasoning: '', status: 'failed' })
  })
})
