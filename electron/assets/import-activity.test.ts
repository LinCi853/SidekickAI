import { describe, expect, it } from 'vitest'
import { hasActiveAssetImports, runAssetImport } from './import-activity'

describe('asset imports', () => {
  it('keeps clear blocked until every outstanding dialog or import settles', async () => {
    let complete!: () => void
    const waiting = runAssetImport(() => new Promise<void>(resolve => { complete = resolve }))
    expect(hasActiveAssetImports()).toBe(true)
    await expect(runAssetImport(async () => { throw new Error('read failure') })).rejects.toThrow('read failure')
    expect(hasActiveAssetImports()).toBe(true)
    complete(); await waiting
    expect(hasActiveAssetImports()).toBe(false)
  })
})
