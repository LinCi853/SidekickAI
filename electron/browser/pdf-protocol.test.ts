import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const runtime = vi.hoisted(() => ({ temporary: '', handler: undefined as undefined | ((request: Request) => Response | Promise<Response>) }))
vi.mock('electron', () => ({ app: { getPath: () => runtime.temporary }, protocol: { handle: (_scheme: string, handler: typeof runtime.handler) => { runtime.handler = handler } } }))

let root: string
let owner: any
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-boundary-'))
  runtime.temporary = root
  owner = new EventEmitter(); owner.id = 17
  vi.resetModules()
})
afterEach(() => { owner.emit('destroyed'); fs.rmSync(root, { recursive: true, force: true }) })

it('refuses caller supplied absolute paths even when they exist', async () => {
  const api = await import('./pdf-protocol.js')
  api.registerPdfProtocol()
  const unrelated = path.join(root, 'unrelated.pdf')
  fs.writeFileSync(unrelated, 'unrelated bytes')
  const response = await runtime.handler!(new Request(`sidekick-pdf://preview/${encodeURIComponent(unrelated)}`))
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('unrelated bytes')
})

it('serves a registered preview and binds save and deletion to its owner', async () => {
  const api = await import('./pdf-protocol.js')
  const bytes = Buffer.from('%PDF-1.7\nfixture')
  const token = api.createPdfPreview(bytes, owner)
  api.registerPdfProtocol()
  const response = await runtime.handler!(new Request(api.toPdfProtocolUrl(token)))
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect(api.readPdfPreview(token, owner)).toEqual(bytes)
  expect(() => api.readPdfPreview(token, new EventEmitter() as any)).toThrow()
  expect(api.deletePdfPreview(token, new EventEmitter() as any)).toBe(false)
  expect(api.deletePdfPreview(token, owner)).toBe(true)
  expect((await runtime.handler!(new Request(api.toPdfProtocolUrl(token)))).status).toBe(404)
})

it('rejects a registered path replaced with another ordinary file', async () => {
  const api = await import('./pdf-protocol.js')
  const token = api.createPdfPreview(Buffer.from('%PDF-1.7\noriginal'), owner)
  const directory = fs.readdirSync(root).find(name => name.startsWith('sidekick-previews-'))!
  const file = path.join(root, directory, token + '.pdf')
  fs.renameSync(file, file + '.original')
  fs.writeFileSync(file, 'unrelated replacement')
  expect(() => api.readPdfPreview(token, owner)).toThrow('变化')
  expect(api.deletePdfPreview(token, owner)).toBe(true)
  expect(fs.readFileSync(file, 'utf8')).toBe('unrelated replacement')
})
