import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, truncate } from 'node:fs/promises'
import path from 'node:path'
import type { AssetAttachment } from '../shared/ai-assets.types'
import { readAttachmentPreview, PREVIEW_MEDIA_LIMIT, PREVIEW_TEXT_LIMIT } from './attachment-preview'

let root: string, file: string
const item = (name: string, mimeType: string) => ({ name, mimeType } as AssetAttachment)
beforeEach(async () => { await mkdir(path.resolve('build'), { recursive: true }); root = await mkdtemp(path.resolve('build/preview-test-')); file = path.join(root, 'original') })
afterEach(async () => {
  if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('preview-test-')) throw new Error('Unexpected fixture root')
  await rm(root, { recursive: true, force: true })
})
describe('bounded read-only attachment previews', () => {
  it('returns HTML and script content as text without producing executable markup', async () => {
    const text = '<script>window.fixtureExecuted=true</script><img src="https://fixture.test/">'
    await writeFile(file, text)
    expect(await readAttachmentPreview(file, item('page.html', 'text/html; charset=utf-8'))).toEqual({ ok: true, kind: 'text', text, truncated: false })
  })
  it('reads UTF-16 BOM text and text extensions on historical generic references', async () => {
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文资料', 'utf16le')]))
    expect(await readAttachmentPreview(file, item('historical.txt', 'application/octet-stream'))).toMatchObject({ ok: true, text: '中文资料' })
  })
  it.each([['historical.png', 'image/png', 'image'], ['historical.pdf', 'application/pdf', 'pdf']])('infers safe media type for %s with generic metadata', async (name, mimeType, kind) => {
    await writeFile(file, 'Fixture bytes')
    expect(await readAttachmentPreview(file, item(name, 'application/octet-stream'))).toMatchObject({ ok: true, mimeType, kind })
  })
  it('caps text at one MiB and identifies the partial preview', async () => {
    await writeFile(file, 'a'.repeat(PREVIEW_TEXT_LIMIT + 1))
    const result = await readAttachmentPreview(file, item('large.txt', 'text/plain'))
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok && result.kind === 'text' && result.text.length).toBe(PREVIEW_TEXT_LIMIT)
  })
  it('refuses oversized media before allocating the full file and leaves bytes intact', async () => {
    await writeFile(file, '%PDF-'); await truncate(file, PREVIEW_MEDIA_LIMIT + 1)
    expect(await readAttachmentPreview(file, item('large.pdf', 'application/pdf'))).toMatchObject({ ok: false, error: expect.stringContaining('32 MB') })
  })
  it('rejects binary disguised as text and unsupported active SVG content', async () => {
    await writeFile(file, Buffer.from([0, 1, 2, 3]))
    expect(await readAttachmentPreview(file, item('binary.txt', 'text/plain'))).toMatchObject({ ok: false })
    expect(await readAttachmentPreview(file, item('image.svg', 'image/svg+xml'))).toMatchObject({ ok: false })
  })
})
