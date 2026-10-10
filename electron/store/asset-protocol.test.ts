// 资产协议（whiteboard-asset://、notes-asset://）路径穿越防护回归测试。
// 协议处理器必须只放行本模块生成的 <uuid>.<ext> 文件名：
// 目录穿越、反斜杠、百分号编码、绝对路径与 host 伪装一律 404。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ temporary: '', handlers: new Map<string, (request: Request) => Response | Promise<Response>>() }))
vi.mock('electron', () => ({
  app: { getPath: () => runtime.temporary },
  protocol: { handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => { runtime.handlers.set(scheme, handler) } },
}))

import { registerWhiteboardAssetProtocol, saveImageAsset, WHITEBOARD_ASSET_SCHEME } from './whiteboard-asset-store.js'
import { registerNotesAssetProtocol, saveNotesImageAsset, NOTES_ASSET_SCHEME } from './notes-asset-store.js'

const PNG_DATA_URL = 'data:image/png;base64,AAECAwQ='

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-protocol-'))
  runtime.temporary = root
  registerWhiteboardAssetProtocol()
  registerNotesAssetProtocol()
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const cases = [
  { label: 'whiteboard-asset', scheme: WHITEBOARD_ASSET_SCHEME, save: saveImageAsset },
  { label: 'notes-asset', scheme: NOTES_ASSET_SCHEME, save: saveNotesImageAsset },
] as const

for (const { label, scheme, save } of cases) {
  it(`${label}: serves a saved image and binds reads to the asset host`, async () => {
    const url = save(PNG_DATA_URL)
    const response = await runtime.handlers.get(scheme)!(new Request(url))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('AAECAwQ=', 'base64'))
    // 同一文件名换 host 请求必须被拒绝，证明 host 校验独立生效
    const hijacked = new URL(url)
    hijacked.host = 'evil'
    expect((await runtime.handlers.get(scheme)!(new Request(hijacked.href))).status).toBe(404)
  })

  it(`${label}: refuses traversal variants even when the target file exists`, async () => {
    fs.writeFileSync(path.join(root, 'settings.db'), 'secret settings bytes')
    const attempts = [
      `${scheme}://asset/../settings.db`,
      `${scheme}://asset/..%2Fsettings.db`,
      `${scheme}://asset/..\\settings.db`,
      `${scheme}://asset/%2e%2e%2fsettings.db`,
      `${scheme}://asset//${root.replaceAll('\\', '/')}/settings.db`,
      `${scheme}://asset/C:%5CUsers%5Ctest%5Csettings.db`,
    ]
    for (const attempt of attempts) {
      const response = await runtime.handlers.get(scheme)!(new Request(attempt))
      expect(response.status, attempt).toBe(404)
      expect(await response.text(), attempt).not.toContain('secret settings bytes')
    }
  })

  it(`${label}: refuses filenames that were never produced by the save path`, async () => {
    const attempts = [
      `${scheme}://asset/not-a-uuid.png`,
      `${scheme}://asset/0123456789abcdef0123456789abcdef.png`,
      `${scheme}://asset/00000000-0000-4000-8000-000000000000.png.txt`,
      `${scheme}://asset/00000000-0000-4000-8000-000000000000..png`,
    ]
    for (const attempt of attempts) {
      expect((await runtime.handlers.get(scheme)!(new Request(attempt))).status, attempt).toBe(404)
    }
  })
}
