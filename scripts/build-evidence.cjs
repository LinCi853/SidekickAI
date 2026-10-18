'use strict'

const path = require('node:path')
const { atomicWrite } = require('./build-cache.cjs')

const reports = new Map()

function record(output, component, inputs, decision, started, details = {}) {
  const file = path.join(output, 'build-timings.json')
  const entries = reports.get(file) || []
  const entry = { component, inputFingerprint: typeof inputs === 'string' ? inputs : inputs.fingerprint,
    reused: decision.reason === 'matched', reason: decision.reason, durationMs: Date.now() - started, ...details }
  entries.push(entry)
  reports.set(file, entries)
  atomicWrite(file, JSON.stringify({ schemaVersion: 1, components: entries }, null, 2) + '\n')
  console.log(`[cache] ${component}: ${entry.reused ? 'reused' : 'built'} (${entry.reason}), ${entry.durationMs} ms`)
  return entry
}

module.exports = { record }
