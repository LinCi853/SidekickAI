'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const u = require('./uninstaller-build-utils.cjs')

const ROOT = path.resolve(__dirname, '../build/component-cache')

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function recordPath(name, key, root) {
  if (!/^[a-z0-9-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid cache identity')
  return path.join(root, name, `${key}.json`)
}

function snapshot(location) {
  return fs.statSync(location).isDirectory()
    ? u.fingerprint(location, u.listFiles(location, new Set())).fingerprint
    : u.sha256(location)
}

function load(name, key, root = ROOT) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(name, key, root), 'utf8'))
    if (record.key !== key || record.protocolVersion !== 1 || record.outputs.length === 0) return null
    for (const output of record.outputs) if (snapshot(output.path) !== output.fingerprint) return null
    return record.value
  } catch { return null }
}

function remember(name, key, locations, value, root = ROOT) {
  const outputs = locations.map(location => ({ path: path.resolve(location), fingerprint: snapshot(location) }))
  atomicWrite(recordPath(name, key, root), JSON.stringify({ protocolVersion: 1, key, outputs, value }, null, 2) + '\n')
  return value
}

module.exports = { atomicWrite, snapshot, load, remember }
