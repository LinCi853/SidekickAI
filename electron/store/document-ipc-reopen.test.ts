import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EffectScope } from '../modules/effect-scope.js'

const runtime = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => runtime.root, isPackaged: false },
  ipcMain: {}, BrowserWindow: {},
}))
import { closeNotesDb, getNotesDb, registerNotesIPC } from './notes-db.js'
import { closeWhiteboardDb, getWhiteboardDb, registerWhiteboardIPC } from './whiteboard-db.js'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'

const handlers = new Map<string, (...args: any[]) => any>()
const listeners = new Map<string, (...args: any[]) => any>()
const scope = {
  ipcHandle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
  ipcOn: (channel: string, handler: (...args: any[]) => any) => listeners.set(channel, handler),
} as unknown as EffectScope
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
const sync = (channel: string, ...args: unknown[]) => {
  const event = { returnValue: undefined as unknown }
  listeners.get(channel)!(event, ...args)
  return event.returnValue
}
beforeEach(() => {
  mkdirSync(path.resolve('build'), { recursive: true })
  runtime.root = mkdtempSync(path.resolve('build', 'document-ipc-reopen-'))
  handlers.clear(); listeners.clear()
  registerNotesIPC(scope); registerWhiteboardIPC(scope)
})
afterEach(() => {
  closeNotesDb(); closeWhiteboardDb()
  if (path.dirname(runtime.root) !== path.resolve('build') || !path.basename(runtime.root).startsWith('document-ipc-reopen-'))
    throw new Error('Unexpected fixture directory')
  rmSync(runtime.root, { recursive: true, force: true })
})
it('reads notes and active metadata through registered IPC after a backup closes its connection', async () => {
  const note = await invoke(ipc.NOTES_SAVE, { id: 'retained-note', content: 'Retained words', tags: ['retained'] })
  await invoke(ipc.NOTES_SET_ACTIVE, note.id)
  closeNotesDb()
  expect(getNotesDb().getNote(note.id)?.content).toBe('Retained words')
  expect(await invoke(ipc.NOTES_LIST)).toMatchObject([{ id: note.id, content: 'Retained words' }])
  expect(await invoke(ipc.NOTES_GET_ACTIVE)).toMatchObject({ id: note.id, content: 'Retained words' })
  expect(await invoke(ipc.NOTES_LIST_TAGS)).toEqual(['retained'])
})
it('saves note shutdown data through the registered sync IPC after a backup closes its connection', async () => {
  await invoke(ipc.NOTES_SAVE, { id: 'retained-note', content: 'Before export' })
  closeNotesDb()
  expect(sync(ipc.NOTES_SAVE_SYNC, { id: 'retained-note', content: 'After export' })).toMatchObject({ ok: true })
  closeNotesDb()
  expect(getNotesDb().getNote('retained-note')?.content).toBe('After export')
})
it('reads whiteboard metadata and snapshots through registered IPC after a backup closes its connection', async () => {
  const board = await invoke(ipc.WHITEBOARD_CREATE, 'Retained board')
  await invoke(ipc.WHITEBOARD_SET_ACTIVE, board.id)
  await invoke(ipc.WHITEBOARD_SAVE_SNAPSHOT, board.id, '{"elements":[{"id":"retained"}]}')
  closeWhiteboardDb()
  expect(getWhiteboardDb().loadSnapshot(board.id)).toBe('{"elements":[{"id":"retained"}]}')
  expect(await invoke(ipc.WHITEBOARD_LIST)).toMatchObject([{ id: board.id, title: 'Retained board' }])
  expect(await invoke(ipc.WHITEBOARD_GET_ACTIVE)).toBe(board.id)
  expect(await invoke(ipc.WHITEBOARD_GET_SNAPSHOT, board.id)).toBe('{"elements":[{"id":"retained"}]}')
})
it('saves whiteboard shutdown data through registered sync IPC after a backup closes its connection', async () => {
  const board = await invoke(ipc.WHITEBOARD_CREATE, 'Retained board')
  closeWhiteboardDb()
  expect(sync(ipc.WHITEBOARD_SAVE_SNAPSHOT_SYNC, board.id, '{"elements":[{"id":"after-export"}]}')).toMatchObject({ ok: true })
  closeWhiteboardDb()
  expect(getWhiteboardDb().loadSnapshot(board.id)).toBe('{"elements":[{"id":"after-export"}]}')
})
