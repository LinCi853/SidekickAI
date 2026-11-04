'use strict'

// Diagnostic: print the SKSETUP3 container layout of finished installers
// ([extractor][payload blob][metadata][68-byte footer]) so size differences can be
// attributed per section. Read-only; it never executes the installer.
// Usage: node scripts/audit-installer-footer.cjs <installer.exe> [more installers...]

const fs = require('node:fs')

const files = process.argv.slice(2).filter(argument => !argument.startsWith('--'))
if (files.length === 0) throw new Error('Usage: node scripts/audit-installer-footer.cjs <installer.exe> [...]')

for (const file of files) {
  const buffer = fs.readFileSync(file)
  const footer = buffer.subarray(buffer.length - 68)
  const magic = footer.subarray(0, 8).toString('latin1')
  if (magic !== 'SKSETUP3') throw new Error('Missing SKSETUP3 footer: ' + file)
  const P = Number(footer.readBigUInt64LE(8))
  const E = Number(footer.readBigUInt64LE(16))
  const M = Number(footer.readBigUInt64LE(24))
  const C = buffer.length
  const W = C - 68 - M - E - P
  const metadata = JSON.parse(buffer.subarray(W + P + E, W + P + E + M).toString('utf8'))
  const summary = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'distributionProof' && value && typeof value === 'object') {
      summary.distributionProof = {
        payload: value.payload && {
          archive: value.payload.archive,
          components: value.payload.components,
          files: value.payload.files?.length,
        },
        ...Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'payload')),
      }
    } else summary[key] = value
  }
  console.log(JSON.stringify({
    file, bytes: C, extractorBytes: W, payloadBlobBytes: P, reservedBytes: E, metadataBytes: M,
    metadata: summary,
  }, null, 2))
}
