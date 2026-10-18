import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cancelPendingAttachmentExpiry, scheduleAttachmentCopyExpiry, sweepStaleRuntimeTemp } from './temp-hygiene'

describe('temp hygiene', () => {
  let root: string
  beforeEach(async () => {
    await mkdir(path.resolve('build'), { recursive: true })
    root = await mkdtemp(path.resolve('build/temp-hygiene-'))
  })
  afterEach(async () => {
    cancelPendingAttachmentExpiry()
    if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('temp-hygiene-')) {
      throw new Error('Unexpected fixture path')
    }
    await rm(root, { recursive: true, force: true })
  })

  it('sweeps only managed names older than the age limit', async () => {
    const stale = path.join(root, 'sidekickai-asset-stale')
    const fresh = path.join(root, 'sidekickai-asset-fresh')
    const foreign = path.join(root, 'dsh-workspace-changes-x')
    await mkdir(stale)
    await mkdir(fresh)
    await mkdir(foreign)
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await utimes(stale, old, old)
    await utimes(foreign, old, old)

    const removed = await sweepStaleRuntimeTemp(root, 24 * 3600 * 1000)
    expect(removed).toBe(1)
    await expect(readdir(root)).resolves.toEqual(expect.arrayContaining(['sidekickai-asset-fresh', 'dsh-workspace-changes-x']))
    await expect(readdir(root)).resolves.not.toEqual(expect.arrayContaining(['sidekickai-asset-stale']))
  })

  it('expires attachment copies after the TTL', async () => {
    const directory = path.join(root, 'sidekickai-asset-copy')
    await mkdir(directory)
    await writeFile(path.join(directory, 'report.pdf'), 'copy')
    scheduleAttachmentCopyExpiry(directory, 20)
    await new Promise(resolve => setTimeout(resolve, 60))
    await expect(readdir(root)).resolves.not.toEqual(expect.arrayContaining(['sidekickai-asset-copy']))
  })
})
