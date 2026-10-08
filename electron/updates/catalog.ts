import { createHash } from 'node:crypto'
import { contentDigest, DISTRIBUTION_PATH, validateChannel, validateRelease, verifyProof } from './contract.js'
import type { DistributionKey, ReleaseChannel, UpdateRelease } from './types.js'

export function distributionOrigin(value: string): URL {
  const origin = new URL(value)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('软件发行来源必须使用 HTTPS。')
  }
  return origin
}
async function fetchJson(url: URL, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { Accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok || !response.body) throw new Error(`软件发行服务不可用（HTTP ${response.status}）。`)
  const maximum = 4 * 1024 ** 2
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body.cancel(); throw new Error('发行清单过大。') }
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > maximum) throw new Error('发行清单过大。'); chunks.push(chunk.value) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
export async function fetchReleases(input: {
  origin: string; keys: DistributionKey[]; channels: ReleaseChannel[];
  sequences: { read(key: string): number; write(key: string, sequence: number): void }; fetcher?: typeof fetch; now?: number
}): Promise<Array<{ release: UpdateRelease; manifestSha256: string; releaseProof: string }>> {
  const origin = distributionOrigin(input.origin)
  if (!input.keys.length) throw new Error('软件发行公钥尚未配置。')
  const fetcher = input.fetcher ?? fetch
  const result: Array<{ release: UpdateRelease; manifestSha256: string; releaseProof: string }> = []
  for (const channel of input.channels) {
    const sequenceKey = createHash('sha256').update(`${origin.origin}/concept/${channel}`).digest('hex')
    const raw = await fetchJson(new URL(`${DISTRIBUTION_PATH}/channels/concept/${channel}`, origin), fetcher)
    if (!raw) continue
    const pointer = validateChannel(verifyProof(raw, input.keys, 'channel'), channel, input.sequences.read(sequenceKey), input.now)
    if (pointer.releaseId === null) { input.sequences.write(sequenceKey, pointer.sequence); continue }
    const proof = await fetchJson(new URL(`${DISTRIBUTION_PATH}/releases/${pointer.releaseId}`, origin), fetcher)
    const release = validateRelease(verifyProof(proof, input.keys, 'release'))
    const manifestSha256 = contentDigest(release)
    if (release.releaseId !== pointer.releaseId || release.channel !== channel || manifestSha256 !== pointer.releaseManifestSha256) throw new Error('发行与已签频道不一致。')
    input.sequences.write(sequenceKey, pointer.sequence)
    result.push({ release, manifestSha256, releaseProof: JSON.stringify(proof) })
  }
  return result
}
