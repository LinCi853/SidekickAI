import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OriginalVault } from './original-vault'

describe('original vault', () => {
  let directory: string
  let vault: OriginalVault
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'asset-vault-')); vault = new OriginalVault(directory) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  it('stores one original for differently named repeated references and fragmented input', async () => {
    const bytes = Buffer.from('图片 file original 😀')
    await vault.begin('a'); await vault.append('a', 0, bytes.subarray(0, 3)); await vault.append('a', 3, bytes.subarray(3))
    const original = await vault.finish('a', bytes.length)
    await vault.begin('b'); await vault.append('b', 0, bytes)
    const repeat = await vault.finish('b', bytes.length)
    expect(original.reused).toBe(false); expect(repeat.reused).toBe(true)
    expect(repeat.sha256).toBe(original.sha256)
    expect(await readdir(path.dirname(vault.pathFor(original.sha256)))).toHaveLength(1)
    expect(await vault.verify(original.sha256, bytes.length)).toBe(vault.pathFor(original.sha256))
  })
  it('rejects missing fragments and never publishes incomplete files', async () => {
    await vault.begin('a')
    await expect(vault.append('a', 4, Buffer.from('x'))).rejects.toThrow('offset')
    await expect(vault.finish('a', 1)).rejects.toThrow('size')
    await vault.abort('a')
    expect(await readdir(path.join(directory, '.pending'))).toHaveLength(0)
  })
  it('finishes canceling a starting transfer before accepting its replacement', async () => {
    const starting = vault.begin('restarted')
    await vault.abort('restarted')
    await starting
    try { expect(await readdir(path.join(directory, '.pending'))).toHaveLength(0) }
    finally { await vault.abort('restarted') }
    await vault.begin('restarted'); await vault.append('restarted', 0, Buffer.from('new'))
    const original = await vault.finish('restarted', 3)
    expect(await readFile(await vault.verify(original.sha256), 'utf8')).toBe('new')
  })
  it('serializes concurrent fragments before final verification', async () => {
    await vault.begin('concurrent')
    await Promise.all([vault.append('concurrent', 0, Buffer.from('first')), vault.append('concurrent', 5, Buffer.from('second'))])
    const result = await vault.finish('concurrent', 11)
    expect(await vault.verify(result.sha256, 11)).toBe(vault.pathFor(result.sha256))
  })
  it('detects damaged existing originals instead of marking them as reused', async () => {
    const bytes = Buffer.from('original')
    await vault.begin('a'); await vault.append('a', 0, bytes)
    const original = await vault.finish('a', bytes.length)
    await writeFile(vault.pathFor(original.sha256), 'damaged!')
    await vault.begin('b'); await vault.append('b', 0, bytes)
    await expect(vault.finish('b', bytes.length)).rejects.toThrow('check failed')
    expect(await readdir(path.join(directory, '.pending'))).toHaveLength(0)
  })
  it('serializes recovery across independent transfer owners and retains damaged bytes', async () => {
    const bytes = Buffer.from('original')
    await vault.begin('a'); await vault.append('a', 0, bytes)
    const original = await vault.finish('a', bytes.length)
    await writeFile(vault.pathFor(original.sha256), 'damaged!')
    const second = new OriginalVault(directory)
    await Promise.all([vault.begin('b'), second.begin('c')])
    await Promise.all([vault.append('b', 0, bytes), second.append('c', 0, bytes)])
    const recovered = await Promise.all([vault.finish('b', bytes.length, original.sha256), second.finish('c', bytes.length, original.sha256)])
    expect(recovered.map(item => item.reused).sort()).toEqual([false, true])
    expect(await readFile(await vault.verify(original.sha256))).toEqual(bytes)
    const quarantine = await readdir(path.join(directory, 'quarantine'))
    expect(quarantine).toHaveLength(1)
    expect(await readFile(path.join(directory, 'quarantine', quarantine[0]), 'utf8')).toBe('damaged!')
  })
})
