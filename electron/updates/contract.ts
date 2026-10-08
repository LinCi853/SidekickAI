import { createHash, createPublicKey, verify } from 'node:crypto'
import type { DistributionKey, NativeArchitecture, ReleaseChannel, UpdateRelease } from './types.js'

export const DISTRIBUTION_PATH = '/api/public/application-distribution/v1'
const ARCHITECTURES = ['x64', 'arm64']
const CHANNELS = ['stable', 'alpha', 'beta', 'rc']
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/
type ObjectValue = Record<string, any>

function exact(value: unknown, keys: string[]): asserts value is ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('软件发行字段无效。')
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('软件发行身份或协议无效。')
}
function timestamp(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  throw new Error('软件发行 JSON 无效。')
}
export const contentDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')

export function verifyProof(envelope: unknown, keys: DistributionKey[], kind: 'release' | 'channel'): ObjectValue {
  exact(envelope, ['payload', 'signature'])
  requireValue(typeof envelope.signature === 'string' && envelope.signature.length <= 4 * 1024 ** 2)
  const parts = envelope.signature.split('.') as string[]
  requireValue(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)))
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown
  exact(header, ['alg', 'kid', 'typ'])
  requireValue(header.alg === 'EdDSA' && header.typ === `sidekickai-application-${kind}-v1` && typeof header.kid === 'string')
  const key = keys.find(item => item.id === header.kid)
  requireValue(key && key.publicKey.kty === 'OKP' && key.publicKey.crv === 'Ed25519' && /^[A-Za-z0-9_-]{43}$/.test(key.publicKey.x)
    && !Object.hasOwn(key.publicKey, 'd'))
  const signature = Buffer.from(parts[2], 'base64url')
  requireValue(signature.length === 64 && verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key.publicKey, format: 'jwk' }), signature))
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
  requireValue(contentDigest(payload) === contentDigest(envelope.payload))
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload))
  return payload as ObjectValue
}

export function validateRelease(value: unknown): UpdateRelease {
  exact(value, ['protocolVersion', 'productId', 'edition', 'productVersion', 'releaseId', 'channel', 'platform',
    'maintenanceProtocolVersion', 'recoveryProtocolVersion', 'assets', 'publicAssetIds', 'architectureEvidence', 'notes', 'createdAt'])
  requireValue(value.protocolVersion === 1 && value.productId === 'sidekickai' && value.edition === 'concept' && value.platform === 'windows'
    && value.maintenanceProtocolVersion === 1 && value.recoveryProtocolVersion === 1 && UUID.test(value.releaseId)
    && typeof value.productVersion === 'string' && value.productVersion.length <= 64 && VERSION.test(value.productVersion)
    && CHANNELS.includes(value.channel) && timestamp(value.createdAt) && typeof value.notes === 'string' && value.notes.length <= 8000
    && Array.isArray(value.assets) && value.assets.length === 3 && Array.isArray(value.publicAssetIds) && value.publicAssetIds.length === 3)
  requireValue(value.channel === (value.productVersion.split('+')[0].split('-')[1]?.split('.')[0] ?? 'stable'))
  const ids = new Set<string>()
  const targets = new Set<NativeArchitecture>()
  let portable = 0
  for (const asset of value.assets) {
    exact(asset, ['assetId', 'role', 'filename', 'sizeBytes', 'sha256', 'contentType', 'executableArchitecture', 'supportedNativeArchitectures', 'bodyProofSha256'])
    requireValue(SHA256.test(asset.sha256) && asset.assetId === asset.sha256 && !ids.has(asset.assetId)
      && SHA256.test(asset.bodyProofSha256) && Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes >= 1 && asset.sizeBytes <= 2 * 1024 ** 3
      && typeof asset.filename === 'string' && asset.filename.length <= 240 && !/[\\/:\x00-\x1f\x7f]/.test(asset.filename)
      && !/[. ]$/.test(asset.filename) && typeof asset.contentType === 'string' && asset.contentType.length <= 120
      && /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/.test(asset.contentType)
      && Array.isArray(asset.supportedNativeArchitectures) && new Set(asset.supportedNativeArchitectures).size === asset.supportedNativeArchitectures.length
      && asset.supportedNativeArchitectures.every((arch: string) => ARCHITECTURES.includes(arch)))
    ids.add(asset.assetId)
    if (asset.role === 'offline-installer') {
      requireValue(asset.supportedNativeArchitectures.length === 1 && asset.executableArchitecture === asset.supportedNativeArchitectures[0]
        && !targets.has(asset.executableArchitecture) && asset.filename.toLowerCase().endsWith('.exe'))
      targets.add(asset.executableArchitecture)
    } else {
      requireValue(asset.role === 'portable' && asset.executableArchitecture === null && asset.supportedNativeArchitectures.length === 2
        && asset.filename.toLowerCase().endsWith('.zip'))
      portable++
    }
  }
  requireValue(targets.size === 2 && portable === 1 && new Set(value.publicAssetIds).size === 3
    && value.publicAssetIds.every((id: string) => ids.has(id)) && Array.isArray(value.architectureEvidence) && value.architectureEvidence.length === 2)
  const evidence = new Set<string>()
  for (const item of value.architectureEvidence) {
    exact(item, ['nativeArchitecture', 'evidenceId', 'testedAt', 'nativePackageVerified'])
    requireValue(ARCHITECTURES.includes(item.nativeArchitecture) && !evidence.has(item.nativeArchitecture) && SHA256.test(item.evidenceId)
      && timestamp(item.testedAt) && item.nativePackageVerified === true)
    evidence.add(item.nativeArchitecture)
  }
  return structuredClone(value) as UpdateRelease
}

export function validateChannel(value: unknown, channel: ReleaseChannel, minimumSequence: number, now = Date.now()): ObjectValue {
  exact(value, ['protocolVersion', 'productId', 'edition', 'channel', 'releaseId', 'releaseManifestSha256', 'sequence', 'issuedAt', 'expiresAt'])
  const seconds = Math.floor(now / 1000)
  requireValue(value.protocolVersion === 1 && value.productId === 'sidekickai' && value.edition === 'concept' && value.channel === channel
    && Number.isSafeInteger(value.sequence) && value.sequence >= Math.max(1, minimumSequence)
    && Number.isSafeInteger(value.issuedAt) && value.issuedAt > 0 && value.issuedAt <= seconds + 60
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > seconds && value.expiresAt > value.issuedAt && value.expiresAt <= value.issuedAt + 86400)
  requireValue(value.releaseId === null ? value.releaseManifestSha256 === null : UUID.test(value.releaseId) && SHA256.test(value.releaseManifestSha256))
  return value
}

export function compareVersions(left: string, right: string): number {
  requireValue(VERSION.test(left) && VERSION.test(right))
  const split = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(value)!
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] }
  }
  const a = split(left), b = split(right)
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  const x = a.prerelease.split('.'), y = b.prerelease.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const numericX = /^\d+$/.test(x[i]), numericY = /^\d+$/.test(y[i])
    if (numericX && numericY) return Number(x[i]) > Number(y[i]) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x[i] > y[i] ? 1 : -1
  }
  return 0
}

export function releaseChannels(version: string): ReleaseChannel[] {
  const stage = version.split('+')[0].split('-')[1]?.split('.')[0]
  return stage === 'alpha' ? ['stable', 'alpha', 'beta', 'rc'] : stage === 'beta' ? ['stable', 'beta', 'rc'] : stage === 'rc' ? ['stable', 'rc'] : ['stable']
}
