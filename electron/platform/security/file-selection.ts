import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { openNativeFile, readNativeFile, type NativeFile } from './native-file.js'

const MAX_PROVIDER_FILE_BYTES = 16 * 1024 * 1024
type SelectionKind = 'import' | 'export'
interface Selection {
  sender: WebContents
  frame: WebFrameMain
  kind: SelectionKind
  content?: string
  file?: NativeFile
  timer: NodeJS.Timeout
}

/** One-use, document-bound file capabilities created only from native dialog results. */
export class FileSelections {
  private selections = new Map<string, Selection>()
  private observed = new WeakSet<WebContents>()

  private discard(token: string): void {
    const selection = this.selections.get(token)
    if (!selection) return
    clearTimeout(selection.timer)
    this.selections.delete(token)
    if (selection.file) fs.closeSync(selection.file.descriptor)
  }

  private revoke(sender: WebContents): void {
    for (const [token, selection] of this.selections) if (selection.sender === sender) this.discard(token)
  }

  select(event: IpcMainInvokeEvent, selected: string, kind: SelectionKind): { token: string; name: string } {
    if (!event.senderFrame) throw new Error('文件选择窗口已失效。')
    const file = openNativeFile(selected, kind === 'export')
    let content: string | undefined
    if (kind === 'import') {
      try { content = readNativeFile(file, MAX_PROVIDER_FILE_BYTES).toString('utf8') }
      finally { fs.closeSync(file.descriptor) }
    }
    for (const [token, selection] of this.selections) if (selection.sender === event.sender && selection.kind === kind) this.discard(token)
    if (!this.observed.has(event.sender)) {
      this.observed.add(event.sender)
      event.sender.once('destroyed', () => this.revoke(event.sender))
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) this.revoke(event.sender) })
    }
    const token = randomUUID()
    const timer = setTimeout(() => this.discard(token), 5 * 60 * 1000)
    timer.unref()
    this.selections.set(token, { sender: event.sender, frame: event.senderFrame, kind, content, file: kind === 'export' ? file : undefined, timer })
    return { token, name: file.name }
  }

  private take(event: IpcMainInvokeEvent, token: unknown, kind: SelectionKind): Selection {
    const selected = typeof token === 'string' ? this.selections.get(token) : undefined
    if (!selected || selected.kind !== kind || selected.sender !== event.sender || selected.frame !== event.senderFrame) {
      throw new Error('文件选择已失效，请重新选择文件。')
    }
    this.selections.delete(token as string)
    clearTimeout(selected.timer)
    return selected
  }

  read(event: IpcMainInvokeEvent, token: unknown): string {
    return this.take(event, token, 'import').content!
  }

  write(event: IpcMainInvokeEvent, token: unknown, content: unknown): void {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_PROVIDER_FILE_BYTES) throw new Error('导出内容无效或过大。')
    const selected = this.take(event, token, 'export')
    try {
      const bytes = Buffer.from(content, 'utf8')
      let written = 0
      while (written < bytes.length) {
        const count = fs.writeSync(selected.file!.descriptor, bytes, written, bytes.length - written, written)
        if (!count) throw new Error('导出文件写入未完成。')
        written += count
      }
      fs.ftruncateSync(selected.file!.descriptor, bytes.length)
      fs.fsyncSync(selected.file!.descriptor)
    } finally { fs.closeSync(selected.file!.descriptor) }
  }
}
