'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const u = require('./build-utils.cjs')

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

function inspect(name, key, root = ROOT) {
  if (process.env.SIDEKICK_REBUILD_ALL === '1') return { value: null, reason: 'forced' }
  try {
    const file = recordPath(name, key, root)
    if (!fs.existsSync(file)) return { value: null, reason: fs.existsSync(path.dirname(file)) ? 'inputs-changed' : 'missing' }
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (record.key !== key || record.protocolVersion !== 1 || !Array.isArray(record.outputs) || record.outputs.length === 0) return { value: null, reason: 'incompatible-record' }
    for (const output of record.outputs) if (snapshot(output.path) !== output.fingerprint) return { value: null, reason: 'output-changed' }
    return { value: record.value, reason: 'matched' }
  } catch { return { value: null, reason: 'unreadable-or-missing-output' } }
}

function load(name, key, root = ROOT) { return inspect(name, key, root).value }

function remember(name, key, locations, value, root = ROOT) {
  const outputs = locations.map(location => ({ path: path.resolve(location), fingerprint: snapshot(location) }))
  atomicWrite(recordPath(name, key, root), JSON.stringify({ protocolVersion: 1, key, outputs, value }, null, 2) + '\n')
  return value
}

function retainDirectory(name, key, directory, root = ROOT) {
  recordPath(name, key, root)
  const expected = snapshot(directory)
  const destination = path.join(root, 'objects', name, key, expected)
  if (fs.existsSync(destination)) {
    if (snapshot(destination) === expected) return destination
    fs.renameSync(destination, `${destination}.corrupt-${crypto.randomUUID()}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  try {
    fs.cpSync(directory, temporary, { recursive: true, errorOnExist: true, force: false })
    if (snapshot(directory) !== expected || snapshot(temporary) !== expected) throw new Error('Cache output changed while retaining it')
    fs.renameSync(temporary, destination)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true })
  }
  return destination
}

function retainFile(name, key, file, root = ROOT) {
  recordPath(name, key, root)
  const expected = snapshot(file)
  const destination = path.join(root, 'objects', name, key, expected)
  if (fs.existsSync(destination) && snapshot(destination) === expected) return destination
  const bytes = fs.readFileSync(file)
  if (u.hash(bytes) !== expected) throw new Error('Cache file changed while retaining it')
  atomicWrite(destination, bytes)
  return destination
}

module.exports = { ROOT, atomicWrite, snapshot, inspect, load, remember, retainDirectory, retainFile }
