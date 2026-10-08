import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { attachmentFileName, createAttachmentCopy } from './attachment-file'

describe('attachment file names', () => {
  it.each([
    ['report.PDF', 'application/pdf', 'report.PDF'],
    ['archive.tar.gz', 'application/gzip', 'archive.tar.gz'],
    ['C:\\private\\report.docx', '', 'report.docx'],
    ['../../report.pdf', '', 'report.pdf'],
    ['a<>:"|?*\u0001.png', '', 'a________.png'],
    ['report.pdf. ', '', 'report.pdf'],
    ['CON.txt', 'text/plain', '_CON.txt'],
    ['lpt1', 'text/plain', '_lpt1.txt'],
    ['COM\u00b9.pdf', '', '_COM\u00b9.pdf'],
    ['..', 'application/pdf', 'asset.pdf'],
    ['', 'application/octet-stream', 'asset.bin'],
    ['image', 'IMAGE/PNG; charset=utf-8', 'image.png'],
    ['report', 'application/pdf', 'report.pdf'],
    ['report', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'],
    ['unknown', 'unknown/type', 'unknown.bin'],
    ['unknown', '__proto__', 'unknown.bin'],
    ['unknown', 'constructor', 'unknown.bin'],
    ['\u8d44\u6599.pdf', 'application/pdf', '\u8d44\u6599.pdf'],
  ])('keeps a usable name for %j', (name, mimeType, expected) => {
    expect(attachmentFileName({ name, mimeType })).toBe(expected)
  })
  it('limits the stem while retaining the extension and complete Unicode characters', () => {
    const name = attachmentFileName({ name: '\ud83d\ude00'.repeat(100) + '.docx', mimeType: '' })
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.endsWith('.docx')).toBe(true)
    expect(name).not.toMatch(/[\uD800-\uDBFF]\.docx$/)
    expect(attachmentFileName({ name: 'x'.repeat(200) + '.pdf', mimeType: '' }, 40)).toHaveLength(40)
    expect(() => attachmentFileName({ name: 'report.' + 'x'.repeat(30), mimeType: '' }, 20)).toThrow('path')
  })
})

describe('attachment file copies', () => {
  let root: string
  const bytes = Buffer.from('verified attachment')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  beforeEach(async () => {
    await mkdir(path.resolve('build'), { recursive: true })
    root = await mkdtemp(path.resolve('build/attachment-copy-test-'))
    await writeFile(path.join(root, sha256), bytes)
  })
  afterEach(async () => {
    if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('attachment-copy-test-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  })
  it('keeps different names for the same object and independent bytes for repeated access', async () => {
    const first = await createAttachmentCopy(root, path.join(root, sha256), { name: 'one.pdf', mimeType: '', sha256 })
    const second = await createAttachmentCopy(root, path.join(root, sha256), { name: 'two.pdf', mimeType: '', sha256 })
    expect(path.basename(first)).toBe('one.pdf')
    expect(path.basename(second)).toBe('two.pdf')
    await writeFile(first, 'edited copy')
    expect(await readFile(path.join(root, sha256))).toEqual(bytes)
    expect(await readFile(second)).toEqual(bytes)
  })
  it('keeps the same name with different contents in separate directories', async () => {
    const changed = Buffer.from('different attachment')
    const otherHash = createHash('sha256').update(changed).digest('hex')
    await writeFile(path.join(root, otherHash), changed)
    const first = await createAttachmentCopy(root, path.join(root, sha256), { name: 'report.pdf', mimeType: '', sha256 })
    const second = await createAttachmentCopy(root, path.join(root, otherHash), { name: 'report.pdf', mimeType: '', sha256: otherHash })
    expect(path.basename(first)).toBe(path.basename(second))
    expect(first).not.toBe(second)
    expect(await readFile(first)).toEqual(bytes)
    expect(await readFile(second)).toEqual(changed)
  })
  it('removes unfinished copies when copying or validating fails', async () => {
    const item = { name: '../../report.pdf', mimeType: '', sha256 }
    const before = await readdir(root)
    await expect(createAttachmentCopy(root, path.join(root, 'missing'), item)).rejects.toThrow()
    await expect(createAttachmentCopy(root, path.join(root, sha256), { ...item, size: 999 })).rejects.toThrow('size')
    await expect(createAttachmentCopy(root, path.join(root, sha256), { ...item, sha256: '0'.repeat(64) })).rejects.toThrow('digest')
    expect(await readdir(root)).toEqual(before)
  })
})
