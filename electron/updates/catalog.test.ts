import { describe, expect, it, vi } from 'vitest'
import { fetchReleases } from './catalog.js'
import { compareVersions, contentDigest, validateRelease, verifyProof } from './contract.js'
import { distributionFixture } from './fixtures.js'

function fixture() {
  const input = distributionFixture()
  const records = new Map<string, number>()
  const sequences = { read: (key: string) => records.get(key) ?? 0, write: (key: string, sequence: number) => { records.set(key, sequence) } }
  const fetcher = vi.fn(async url => new Response(JSON.stringify(input.signed(String(url).includes('/channels/') ? input.pointer : input.release,
    String(url).includes('/channels/') ? 'channel' : 'release')))) as typeof fetch
  return { ...input, sequences, fetcher, origin: 'https://fixture.invalid', channels: ['stable'] as const }
}
describe('concept release selection', () => {
  it('verifies exact channel and release with both native installers and portable ZIP', async () => {
    const input = fixture()
    const selected = await fetchReleases({ ...input, channels: ['stable'] })
    expect(selected[0]).toMatchObject({ manifestSha256: contentDigest(input.release), release: { productVersion: '0.1.7' } })
    expect(verifyProof(JSON.parse(selected[0].releaseProof), input.keys, 'release')).toEqual(input.release)
    expect(input.fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects wrong purpose, tampered payload, missing evidence and substituted native target', () => {
    const input = fixture()
    expect(() => verifyProof(input.signed(input.release, 'channel'), input.keys, 'release')).toThrow()
    expect(() => verifyProof({ ...input.signed(input.release, 'release'), payload: { ...input.release, productVersion: '9.0.0' } }, input.keys, 'release')).toThrow()
    const incomplete = structuredClone(input.release)
    incomplete.architectureEvidence.pop()
    expect(() => validateRelease(incomplete)).toThrow()
    const wrongTarget = structuredClone(input.release)
    wrongTarget.assets[1].executableArchitecture = 'x64'
    wrongTarget.assets[1].supportedNativeArchitectures = ['x64']
    expect(() => validateRelease(wrongTarget)).toThrow()
  })
  it('rejects expired, lower-sequence and mismatched release selections', async () => {
    for (const kind of ['expired', 'sequence', 'digest']) {
      const input = fixture()
      if (kind === 'expired') { input.pointer.issuedAt -= 7200; input.pointer.expiresAt -= 7200 }
      if (kind === 'sequence') { await fetchReleases({ ...input, channels: ['stable'] }); input.pointer.sequence-- }
      if (kind === 'digest') input.pointer.releaseManifestSha256 = 'f'.repeat(64)
      await expect(fetchReleases({ ...input, channels: ['stable'] })).rejects.toThrow()
    }
  })
  it.each(['stable', 'alpha', 'beta', 'rc'] as const)('binds a signed %s release to its version stage', async channel => {
    const input = fixture()
    input.release.productVersion = channel === 'stable' ? '0.1.7+build.2' : `0.1.7-${channel}.2+build.2`
    input.release.channel = channel
    expect(validateRelease(input.release).channel).toBe(channel)
    input.release.channel = channel === 'stable' ? 'rc' : 'stable'
    input.pointer.channel = input.release.channel
    input.pointer.releaseManifestSha256 = contentDigest(input.release)
    await expect(fetchReleases({ ...input, channels: [input.release.channel] })).rejects.toThrow()
  })
  it.each(['01.1.7', '0.1.7-alpha.01', '0.1.7+build..1', '0.1.7\n'])('rejects a signed invalid semantic version %j', async version => {
    const input = fixture()
    input.release.productVersion = version
    input.pointer.releaseManifestSha256 = contentDigest(input.release)
    await expect(fetchReleases({ ...input, channels: ['stable'] })).rejects.toThrow()
  })
  it('retains prerelease ordering and never treats build metadata as a newer product', () => {
    expect(compareVersions('0.1.7', '0.1.7-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.1.7-beta.10', '0.1.7-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('0.1.6+revision.2', '0.1.6')).toBe(0)
  })
})
