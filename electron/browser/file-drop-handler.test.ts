import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const windows = vi.hoisted(() => new Map<string, any>())
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: (sender: any) => sender.window },
}))
vi.mock('../platform/window/window-state.js', () => ({
  windowState: { browserWindowsByProfile: windows, mainWindow: null as any },
}))
vi.mock('../platform/security/trusted-renderer.js', () => ({
  assertTrustedRenderer: (event: any) => {
    if (!event.sender.trusted || event.senderFrame !== event.sender.mainFrame)
      throw new Error('untrusted')
  },
}))
vi.mock('../platform/security/webview-owner.js', () => ({
  assertOwnedWebview: (host: any, guest: any) => {
    if (guest.hostWebContents !== host || !guest.registered) throw new Error('unregistered')
  },
}))
vi.mock('./pdf-protocol.js', () => ({
  createLocalPreview: (bytes: Buffer, name: string) => ({
    url: `preview:${name}:${bytes.toString()}`,
    kind: 'file',
  }),
}))
import {
  prepareFileDrop,
  captureFileDrop,
  readDroppedFiles,
  openDroppedFiles,
  importDroppedFiles,
  fileDropCapabilities,
} from './file-drop-handler.js'
import { windowState } from '../platform/window/window-state.js'

let root: string
const contents: any[] = []
function source(host?: any): any {
  const sender: any = Object.assign(new EventEmitter(), {
    id: contents.length + 1,
    trusted: !host,
    registered: true,
    hostWebContents: host,
    mainFrame: {},
    send: vi.fn(),
    isDestroyed: () => false,
    getType: () => (host ? 'webview' : 'window'),
  })
  contents.push(sender)
  if (!host) {
    Object.assign(sender, { window: {} })
    windows.set(String(sender.id), sender.window)
  }
  return { sender, senderFrame: sender.mainFrame }
}
function select(event: any) {
  const file = path.join(root, 'selected.txt')
  fs.writeFileSync(file, 'selected bytes')
  return { file, input: { ...prepareFileDrop(event), paths: [file] } }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-drop-'))
  windowState.mainWindow = null
})
afterEach(() => {
  for (const item of contents.splice(0)) item.emit('destroyed')
  windows.clear()
  fs.rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

it('rejects raw paths and absent or incorrect challenges before reading', () => {
  const event = source()
  const { input } = select(event)
  expect(() => readDroppedFiles(event, input.paths)).toThrow('失效')
  expect(() => captureFileDrop(event, { ...input, nonce: 'unissued' })).toThrow('凭据')
  expect(() => captureFileDrop(event, { paths: input.paths })).toThrow('凭据')
  expect(captureFileDrop(event, input).token).toBeTruthy()
  expect(() => captureFileDrop(event, input)).toThrow('凭据')
})

it('pins selected bytes and consumes a token once in the same document', () => {
  const event = source()
  const { input, file } = select(event)
  const token = captureFileDrop(event, input)
  fs.writeFileSync(file, 'changed bytes')
  expect(() => readDroppedFiles(source(), token)).toThrow('失效')
  expect(() => readDroppedFiles({ ...event, senderFrame: {} }, token)).toThrow('来源')
  expect(readDroppedFiles(event, token)).toEqual([
    {
      filename: 'selected.txt',
      dataUrl: `data:text/plain;base64,${Buffer.from('selected bytes').toString('base64')}`,
      mime: 'text/plain',
      size: 14,
    },
  ])
  expect(() => readDroppedFiles(event, token)).toThrow('失效')
})

it('revokes navigation, expiry and unregistered guests', () => {
  vi.useFakeTimers()
  const event = source()
  const { input } = select(event)
  const token = captureFileDrop(event, input)
  event.sender.emit('did-start-navigation', {}, 'https://example.com', false, true)
  expect(() => readDroppedFiles(event, token)).toThrow('失效')
  const next = select(event).input
  vi.advanceTimersByTime(60001)
  expect(() => captureFileDrop(event, next)).toThrow('凭据')
  const guest = source(event.sender)
  guest.sender.registered = false
  expect(() => prepareFileDrop(guest)).toThrow('unregistered')
})

it('emits a guest snapshot only to its owning host and rejects symlinks', () => {
  const host = source()
  const guest = source(host.sender)
  const { input, file } = select(guest)
  openDroppedFiles(guest, captureFileDrop(guest, input))
  expect(host.sender.send).toHaveBeenCalledWith('localFileDrop:files', {
    guestId: guest.sender.id,
    files: [{ name: 'selected.txt', url: 'preview:selected.txt:selected bytes', kind: 'file' }],
  })
  const link = path.join(root, 'linked')
  fs.symlinkSync(root, link, 'junction')
  expect(() =>
    captureFileDrop(guest, {
      ...prepareFileDrop(guest),
      paths: [path.join(link, path.basename(file))],
    }),
  ).toThrow()
})

it('routes page-ignored drops in the application main window to AI import', () => {
  const host = source()
  windows.clear()
  windowState.mainWindow = host.sender.window
  const guest = source(host.sender)
  expect(fileDropCapabilities(guest)).toEqual({ route: 'import' })
  const { input } = select(guest)
  expect(input.fallbackAllowed).toBe(false)
  const token = captureFileDrop(guest, input)
  importDroppedFiles(guest, token)
  expect(host.sender.send).toHaveBeenCalledWith('localFileDrop:aiFiles', {
    guestId: guest.sender.id,
    files: [
      {
        filename: 'selected.txt',
        dataUrl: `data:text/plain;base64,${Buffer.from('selected bytes').toString('base64')}`,
        mime: 'text/plain',
        size: 14,
      },
    ],
  })
  expect(() => readDroppedFiles(guest, token)).toThrow('失效')
})

it('advertises preview, import or no handling per host', () => {
  const main = source()
  windows.clear()
  windowState.mainWindow = main.sender.window
  expect(fileDropCapabilities(main)).toEqual({ route: 'none' })
  expect(fileDropCapabilities(source(main.sender))).toEqual({ route: 'import' })
  windows.set('browser', main.sender.window)
  expect(fileDropCapabilities(source(main.sender))).toEqual({ route: 'preview' })
})
