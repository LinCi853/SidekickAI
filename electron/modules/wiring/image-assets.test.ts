import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  protocols: new Map<string, (request: { url: string }) => Response>(),
  closeNotes: vi.fn(),
  closeWhiteboard: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      if (fixture.handlers.has(channel)) throw new Error('Duplicate handler: ' + channel)
      fixture.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    removeAllListeners: vi.fn(),
  },
  protocol: {
    handle: (scheme: string, handler: (request: { url: string }) => Response) => {
      if (fixture.protocols.has(scheme)) throw new Error('Duplicate protocol: ' + scheme)
      fixture.protocols.set(scheme, handler)
    },
  },
}))
vi.mock('../../store/store-paths.js', () => ({ resolveSqlitePath: (name: string) => path.join(fixture.root, name) }))
vi.mock('../../store/notes-db.js', () => ({
  registerNotesIPC: (scope: any) => scope.ipcHandle('notes:list', () => []),
  closeNotesDb: fixture.closeNotes,
}))
vi.mock('../../ipc/notes-ipc.js', () => ({
  registerNotesExtraIpc: (scope: any) => {
    scope.ipcHandle('notes:sendToAi', () => ({ success: true }))
    scope.ipcHandle('notes:saveAsPrompt', () => ({ success: true }))
  },
}))
vi.mock('../../store/whiteboard-db.js', () => ({
  registerWhiteboardIPC: (scope: any) => scope.ipcHandle('whiteboard:list', () => []),
  closeWhiteboardDb: fixture.closeWhiteboard,
}))
vi.mock('../../window-factory.js', () => ({ openAdvancedPanelWindow: vi.fn() }))
vi.mock('../../window-state.js', () => ({ windowState: { advancedPanelWindow: null } }))

import { initNotesModule, teardownNotesModule, clearNotesData } from './notes.js'
import { initWhiteboardModule, teardownWhiteboardModule, clearWhiteboardData } from './whiteboard.js'

const image = Buffer.from('persistent fixture bytes')
const dataUrl = 'data:image/png;base64,' + image.toString('base64')
const modules = [
  { id: 'notes', init: initNotesModule, teardown: teardownNotesModule, clear: clearNotesData, close: fixture.closeNotes,
    channels: ['notes:list', 'notes:saveImage', 'notes:sendToAi', 'notes:saveAsPrompt'],
    save: async () => (await fixture.handlers.get('notes:saveImage')!(null, dataUrl)).url },
  { id: 'whiteboard', init: initWhiteboardModule, teardown: teardownWhiteboardModule, clear: clearWhiteboardData, close: fixture.closeWhiteboard,
    channels: ['whiteboard:list', 'whiteboard:saveImage', 'whiteboard:pushImageRequest'],
    save: async () => fixture.handlers.get('whiteboard:saveImage')!(null, dataUrl) },
]

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-image-lifecycle-'))
  fixture.handlers.clear()
  fixture.closeNotes.mockClear()
  fixture.closeWhiteboard.mockClear()
})
afterEach(async () => {
  await teardownNotesModule()
  await teardownWhiteboardModule()
  fixture.handlers.clear()
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe.each(modules)('$id image lifecycle', module => {
  it('releases every write channel and restores all handlers on repeated enable', async () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      await module.init()
      expect([...fixture.handlers.keys()].sort()).toEqual(module.channels.slice().sort())
      await module.teardown()
      expect([...fixture.handlers.keys()]).toEqual([])
    }
  })

  it('keeps saved image bytes readable after teardown and repeated initialization', async () => {
    await module.init()
    const url = await module.save()
    const read = () => fixture.protocols.get(module.id + '-asset')!({ url })
    await module.teardown()
    expect(Buffer.from(await read().arrayBuffer())).toEqual(image)
    await module.init()
    await module.init()
    expect(Buffer.from(await read().arrayBuffer())).toEqual(image)
    expect([...fixture.handlers.keys()].sort()).toEqual(module.channels.slice().sort())
    expect(fixture.protocols.has(module.id + '-asset')).toBe(true)
  })

  it('closes the database before deleting only its data and releases write handlers', async () => {
    await module.init()
    const url = await module.save()
    const db = path.join(fixture.root, module.id + '.db')
    const asset = path.join(fixture.root, module.id + '-assets', new URL(url).pathname.slice(1))
    fs.writeFileSync(db, 'database fixture')
    for (const suffix of ['-wal', '-shm']) fs.writeFileSync(db + suffix, 'sqlite sidecar')
    const unrelated = path.join(fixture.root, 'preserved.txt')
    fs.writeFileSync(unrelated, 'unrelated data')
    let existedBeforeClose = false
    module.close.mockImplementationOnce(() => {
      existedBeforeClose = fs.existsSync(db) && fs.existsSync(asset)
    })
    await module.clear()
    expect(existedBeforeClose).toBe(true)
    expect(module.close).toHaveBeenCalledTimes(1)
    expect([...fixture.handlers.keys()]).toEqual([])
    expect(fs.existsSync(db)).toBe(false)
    expect(fs.existsSync(db + '-wal')).toBe(false)
    expect(fs.existsSync(db + '-shm')).toBe(false)
    expect(fs.existsSync(path.dirname(asset))).toBe(false)
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated data')
    expect(readImage(url).status).toBe(404)
  })
})

function readImage(url: string): Response {
  return fixture.protocols.get(new URL(url).protocol.slice(0, -1))!({ url })
}
