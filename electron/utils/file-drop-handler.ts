import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { assertTrustedRenderer } from '../security/trusted-renderer.js'
import { assertOwnedWebview } from '../security/webview-owner.js'
import { openNativeFile, readNativeFile } from '../security/native-file.js'
import { createLocalPreview } from './pdf-protocol.js'
import { windowState } from '../window-state.js'

export interface DroppedFile {
  filename: string
  dataUrl: string
  mime: string
  size: number
}
interface Owner { sender: WebContents; frame: WebFrameMain; host: WebContents }
interface Challenge extends Owner { nonce: string; timer: NodeJS.Timeout }
interface Captured extends Owner { files: { name: string; bytes: Buffer }[]; timer: NodeJS.Timeout }
const challenges = new Map<WebContents, Challenge>()
const captured = new Map<string, Captured>()
const observed = new WeakSet<WebContents>()
const MAX_FILE = 50 * 1024 * 1024
const MAX_TOTAL = 100 * 1024 * 1024

function owner(event: IpcMainInvokeEvent): Owner {
  const sender = event.sender
  if (!sender || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new Error('拖放来源无效。')
  const host = sender.getType() === 'webview' ? sender.hostWebContents : sender
  if (!host) throw new Error('拖放窗口已关闭。')
  assertTrustedRenderer({ ...event, sender: host, senderFrame: host.mainFrame })
  if (host !== sender) assertOwnedWebview(host, sender)
  return { sender, host, frame: event.senderFrame }
}

function discard(token: string): void {
  const value = captured.get(token)
  if (value) clearTimeout(value.timer)
  captured.delete(token)
}

function revoke(sender: WebContents): void {
  const challenge = challenges.get(sender)
  if (challenge) clearTimeout(challenge.timer)
  challenges.delete(sender)
  for (const [token, value] of captured) if (value.sender === sender || value.host === sender) discard(token)
}

function observe(sender: WebContents): void {
  if (observed.has(sender)) return
  observed.add(sender)
  sender.once('destroyed', () => revoke(sender))
  sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) revoke(sender) })
  sender.on('render-process-gone', () => revoke(sender))
}

function canOpen(source: Owner): boolean {
  const window = BrowserWindow.fromWebContents(source.host)
  return !!window && [...windowState.browserWindowsByProfile.values()].includes(window)
}

/** This challenge is visible only to the isolated native-drop listener. */
export function prepareFileDrop(event: IpcMainInvokeEvent): { nonce: string; fallbackAllowed: boolean } {
  const source = owner(event)
  revoke(source.sender)
  observe(source.sender)
  observe(source.host)
  const nonce = randomUUID()
  const timer = setTimeout(() => challenges.delete(source.sender), 60000)
  timer.unref()
  challenges.set(source.sender, { ...source, nonce, timer })
  return { nonce, fallbackAllowed: canOpen(source) }
}

export function captureFileDrop(event: IpcMainInvokeEvent, input: unknown): { token: string } {
  const source = owner(event)
  const value = input as { nonce?: unknown; paths?: unknown } | null
  const challenge = challenges.get(source.sender)
  if (!challenge || challenge.frame !== source.frame || challenge.host !== source.host || value?.nonce !== challenge.nonce) throw new Error('拖放凭据无效，请重新拖入文件。')
  clearTimeout(challenge.timer)
  challenges.delete(source.sender)
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 32 || value.paths.some(p => typeof p !== 'string')) throw new Error('拖放文件列表无效。')
  let total = 0
  const files = value.paths.map(selected => {
    const file = openNativeFile(selected)
    try {
      const bytes = readNativeFile(file, Math.min(MAX_FILE, MAX_TOTAL - total))
      total += bytes.length
      return { name: file.name, bytes }
    } finally { fs.closeSync(file.descriptor) }
  })
  const token = randomUUID()
  const timer = setTimeout(() => discard(token), 60000)
  timer.unref()
  captured.set(token, { ...source, files, timer })
  return { token }
}

function take(event: IpcMainInvokeEvent, input: unknown): Captured {
  const source = owner(event)
  const token = (input as { token?: unknown } | null)?.token
  const value = typeof token === 'string' ? captured.get(token) : undefined
  if (!value || value.sender !== source.sender || value.frame !== source.frame || value.host !== source.host) throw new Error('拖放文件已失效，请重新拖入。')
  discard(token as string)
  return value
}

export function readDroppedFiles(event: IpcMainInvokeEvent, input: unknown): DroppedFile[] {
  return take(event, input).files.map(({ name, bytes }) => {
    const mime = guessMime(path.extname(name).slice(1).toLowerCase())
    return { filename: name, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, mime, size: bytes.length }
  })
}

export function openDroppedFiles(event: IpcMainInvokeEvent, input: unknown): void {
  const value = take(event, input)
  if (!canOpen(value)) throw new Error('此窗口不提供本地文件预览。')
  const files = value.files.map(file => {
    const preview = createLocalPreview(file.bytes, file.name, value.host)
    return { name: file.name, url: preview.url, kind: preview.kind }
  })
  value.host.send(IPC_CHANNELS.LOCAL_FILES_DROPPED, { guestId: value.sender === value.host ? null : value.sender.id, files })
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    // 图片
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    // 文档
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    json: 'application/json',
    // 代码
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    go: 'text/x-go',
    rs: 'text/x-rust',
    rb: 'text/x-ruby',
    php: 'application/x-php',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    yml: 'text/yaml',
    yaml: 'text/yaml',
    toml: 'application/toml',
    ini: 'text/plain',
    cfg: 'text/plain',
    css: 'text/css',
    scss: 'text/x-scss',
    // Office
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // 压缩
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    rar: 'application/x-rar-compressed',
    // 音视频
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    // 数据
    sql: 'application/sql',
  }
  return map[ext] || 'application/octet-stream'
}
