import type { SensitiveDraftTransport } from './types.js'

export const MAX_DRAFT_BYTES = 1024 * 1024
export const MAX_DRAFT_ENTRIES = 4096
export const MAX_DRAFT_TRANSPORT_BYTES = 32 * 1024 * 1024

export function validDraftKey(key: unknown): key is string {
  return typeof key === 'string' && /^windowDraft:[a-zA-Z0-9_.:-]{1,512}$/.test(key)
}

export function validateSensitiveDrafts(value: unknown): asserts value is SensitiveDraftTransport {
  const transport = value as SensitiveDraftTransport | undefined
  if (!transport || transport.version !== 1 || !Array.isArray(transport.entries) || transport.entries.length > MAX_DRAFT_ENTRIES) throw new Error('Invalid sensitive draft transport.')
  const seen = new Set<string>()
  for (const entry of transport.entries) {
    if (!entry || !validDraftKey(entry.key) || seen.has(entry.key) || typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) throw new Error('Invalid sensitive draft identity.')
    seen.add(entry.key)
    if (entry.state === 'portable') {
      const encoded = JSON.stringify(entry.value)
      if (!encoded || Buffer.byteLength(encoded) > MAX_DRAFT_BYTES) throw new Error('Sensitive draft exceeds its supported size.')
    } else if (entry.state !== 'unavailable' || entry.reason !== 'source-key-unavailable' || Object.hasOwn(entry, 'value')) throw new Error('Invalid sensitive draft status.')
  }
  if (Buffer.byteLength(JSON.stringify(transport)) > MAX_DRAFT_TRANSPORT_BYTES) throw new Error('Sensitive draft transport exceeds its supported size.')
}
