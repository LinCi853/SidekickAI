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
    }, this.flushDelay())
  }
  /**
   * 流式刷盘间隔随累积体量放宽：每次刷盘都要整行重写累积全文并重算内容摘要，
   * 固定短间隔会把长回复变成 O(n²) 写放大并周期性阻塞主进程。
   * 渲染层实时性由 IPC chunk 保证，落库行只服务于资产库与历史记录。
   */
  private flushDelay(): number {
    const size = this.content.length + this.reasoning.length
    if (size <= 4096) return 100
    if (size <= 32768) return 500
    return 2000
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
