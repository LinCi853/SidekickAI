import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { transform } from 'esbuild'
import { transformExcalidrawClipboard } from './excalidraw-clipboard-feedback'
describe('whiteboard export result integration', () => {
  it.each([true, false])('accepts the installed library and refuses unrecognized export behavior: %s', async development => {
    const source = readFileSync(`node_modules/@excalidraw/excalidraw/dist/${development ? 'dev' : 'prod'}/index.js`, 'utf8')
    const modified = transformExcalidrawClipboard(source, development)
    expect(modified).not.toBe(source)
    await transform(modified, { loader: 'js', format: 'esm' })
    expect(() => transformExcalidrawClipboard('unknown implementation', development)).toThrow('Unsupported')
  })
})
