import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson, contentDigest } from './contract.js'
import type { DistributionKey, UpdateRelease } from './types.js'

export function distributionFixture() {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ format: 'jwk' })
  const keys: DistributionKey[] = [{ id: 'fixture_admin', publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x! } }]
  const release: UpdateRelease = {
    protocolVersion: 1, productId: 'sidekickai', edition: 'concept', productVersion: '0.1.7',
    releaseId: 'a7c165ee-41b1-45b5-bc29-803dbdf67072', channel: 'stable', platform: 'windows', maintenanceProtocolVersion: 1, recoveryProtocolVersion: 1,
    assets: [
      ...(['x64', 'arm64'] as const).map((arch, index) => ({ assetId: String(index + 1).repeat(64), role: 'offline-installer' as const,
        filename: `Setup-${arch}.exe`, sizeBytes: 1024, sha256: String(index + 1).repeat(64), contentType: 'application/octet-stream',
        executableArchitecture: arch, supportedNativeArchitectures: [arch], bodyProofSha256: 'c'.repeat(64) })),
      { assetId: '3'.repeat(64), role: 'portable', filename: 'SidekickAI.zip', sizeBytes: 1024, sha256: '3'.repeat(64), contentType: 'application/zip',
        executableArchitecture: null, supportedNativeArchitectures: ['x64', 'arm64'], bodyProofSha256: 'd'.repeat(64) },
    ], publicAssetIds: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
    architectureEvidence: (['x64', 'arm64'] as const).map(nativeArchitecture => ({ nativeArchitecture, evidenceId: 'e'.repeat(64), testedAt: '2026-10-07T13:00:00.000Z', nativePackageVerified: true })),
    notes: 'Fixture release', createdAt: '2026-10-07T13:00:00.000Z',
  }
  const now = Date.parse('2026-10-07T14:00:00.000Z')
  const pointer = { protocolVersion: 1, productId: 'sidekickai', edition: 'concept', channel: 'stable', releaseId: release.releaseId,
    releaseManifestSha256: contentDigest(release), sequence: 3, issuedAt: now / 1000, expiresAt: now / 1000 + 3600 }
  const signed = (payload: unknown, kind: 'release' | 'channel') => {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: keys[0].id, typ: `sidekickai-application-${kind}-v1` })).toString('base64url')
    const body = Buffer.from(canonicalJson(payload)).toString('base64url')
    return { payload, signature: `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), pair.privateKey).toString('base64url')}` }
  }
  return { keys, release, pointer, now, signed }
}
