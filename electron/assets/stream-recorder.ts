import type { AssetMessageStatus } from '../shared/ai-assets.types.js'

export interface RecordedStream {
  content: string
  reasoning: string
  status: AssetMessageStatus
}

export class StreamAssetRecorder {
  private content = ''
  private reasoning = ''
  private timer?: ReturnType<typeof setTimeout>
  private finished = false
  private failure?: Error
  constructor(private persist: (value: RecordedStream) => void) {}
  append(kind: 'output' | 'reasoning', delta: string): void {
    if (this.finished || !delta) return
    if (kind === 'output') this.content += delta
    else this.reasoning += delta
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined
      try { this.flush('streaming') } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)) }
    }, 100)
  }
  private flush(status: AssetMessageStatus): void {
    if (this.content || this.reasoning) this.persist({ content: this.content, reasoning: this.reasoning, status })
  }
  finish(status: AssetMessageStatus, content?: string): void {
    if (this.finished) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (content !== undefined) this.content = content
    this.flush(status)
    this.finished = true
    this.failure = undefined
  }
  get received(): boolean { return !!(this.content || this.reasoning) }
  get persistenceError(): Error | undefined { return this.failure }
}
