import { afterEach, expect, it, vi } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const runtime = vi.hoisted(() => ({ packaged: true }))
vi.mock('electron', () => ({ app: { get isPackaged() { return runtime.packaged } }, BrowserWindow: { fromWebContents: (sender: any) => sender.window } }))
vi.mock('../window-factory/paths.js', () => ({ __dirname: 'E:/fixture/out/main' }))
import { assertTrustedRenderer, isTrustedRendererUrl } from './trusted-renderer.js'
const document = pathToFileURL(path.resolve('E:/fixture/out/renderer/index.html')).href
const original = process.env.ELECTRON_RENDERER_URL
afterEach(() => { runtime.packaged = true; if (original === undefined) delete process.env.ELECTRON_RENDERER_URL; else process.env.ELECTRON_RENDERER_URL = original })
it('requires the actual application document and permits its route query', () => {
  expect(isTrustedRendererUrl(document + '?mode=browser#route')).toBe(true)
  for (const value of ['file:///C:/unrelated.html', document.replace('index.html', 'other.html'), 'https://example.com/']) expect(isTrustedRendererUrl(value)).toBe(false)
})
it('ignores development overrides in packaged runs and checks the exact development document', () => {
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  expect(isTrustedRendererUrl(process.env.ELECTRON_RENDERER_URL)).toBe(false)
  runtime.packaged = false
  expect(isTrustedRendererUrl('http://localhost:5173/?mode=browser')).toBe(true)
  expect(isTrustedRendererUrl('http://localhost:5173/other.html')).toBe(false)
  expect(isTrustedRendererUrl('http://localhost:5174/')).toBe(false)
})
it('rejects guest frames, detached windows and destroyed senders', () => {
  const sender: any = { getURL: () => document, getType: () => 'window', mainFrame: {}, isDestroyed: () => false, window: { isDestroyed: () => false } }
  const event: any = { sender, senderFrame: sender.mainFrame }
  expect(() => assertTrustedRenderer(event)).not.toThrow()
  expect(() => assertTrustedRenderer({ ...event, senderFrame: {} })).toThrow()
  sender.getType = () => 'webview'
  expect(() => assertTrustedRenderer(event)).toThrow()
  sender.getType = () => 'window'; sender.window = null
  expect(() => assertTrustedRenderer(event)).toThrow()
  sender.isDestroyed = () => true
  expect(() => assertTrustedRenderer(event)).toThrow()
})
