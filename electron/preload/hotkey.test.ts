import { beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS } from '../shared/types.js'

const state = vi.hoisted(() => ({ renderer: null as unknown as EventEmitter, invoke: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: {
  on: (channel: string, listener: (...args: unknown[]) => void) => state.renderer.on(channel, listener),
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => state.renderer.removeListener(channel, listener),
  invoke: (...args: unknown[]) => state.invoke(...args),
} }))
import { hotkeyApi } from './hotkey.js'
beforeEach(() => { state.renderer = new EventEmitter(); state.invoke.mockReset().mockResolvedValue(true) })

it('replaces a renderer shortcut callback without retaining the previous subscription', async () => {
  const previous = vi.fn(), current = vi.fn()
  await hotkeyApi.hotkey.register('Control+Alt+J', previous)
  await hotkeyApi.hotkey.register('Control+Alt+J', current)
  state.renderer.emit(IPC_CHANNELS.HOTKEY_TRIGGERED, {}, 'Control+Alt+J')
  expect(previous).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledOnce()
  await hotkeyApi.hotkey.unregister('Control+Alt+J')
  state.renderer.emit(IPC_CHANNELS.HOTKEY_TRIGGERED, {}, 'Control+Alt+J')
  expect(current).toHaveBeenCalledOnce()
})
it('removes the renderer subscription when native registration rejects', async () => {
  const callback = vi.fn()
  state.invoke.mockRejectedValueOnce(new Error('Unavailable'))
  await expect(hotkeyApi.hotkey.register('Control+Alt+K', callback)).rejects.toThrow('Unavailable')
  state.renderer.emit(IPC_CHANNELS.HOTKEY_TRIGGERED, {}, 'Control+Alt+K')
  expect(callback).not.toHaveBeenCalled()
})
it('keeps the hook fallback callback when operating-system registration is unavailable', async () => {
  const callback = vi.fn()
  state.invoke.mockResolvedValueOnce(false)
  expect(await hotkeyApi.hotkey.register('Alt+Space', callback)).toBe(false)
  state.renderer.emit(IPC_CHANNELS.HOTKEY_TRIGGERED, {}, 'Alt+Space')
  expect(callback).toHaveBeenCalledOnce()
  await hotkeyApi.hotkey.unregister('Alt+Space')
  state.renderer.emit(IPC_CHANNELS.HOTKEY_TRIGGERED, {}, 'Alt+Space')
  expect(callback).toHaveBeenCalledOnce()
})
