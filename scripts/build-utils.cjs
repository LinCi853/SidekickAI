'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MACHINES = { x64: 0x8664, arm64: 0xaa64 }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sha256 = file => hash(fs.readFileSync(file))

function assertFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Missing or invalid regular file: ${file}`)
}

function peInfo(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid DOS header')
  const offset = bytes.readUInt32LE(0x3c)
  if (offset > bytes.length - 24 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid PE header')
  const machine = bytes.readUInt16LE(offset + 4)
  const arch = Object.keys(MACHINES).find(key => MACHINES[key] === machine)
  if (!arch) throw new Error(`Unsupported PE machine: 0x${machine.toString(16)}`)
  const sections = bytes.readUInt16LE(offset + 6)
  const optionalSize = bytes.readUInt16LE(offset + 20)
  const optional = offset + 24
  if (sections === 0 || optionalSize < 112 || optional + optionalSize + sections * 40 > bytes.length) throw new Error('Truncated PE sections')
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Expected PE32+ executable')
  let imageEnd = bytes.readUInt32LE(optional + 60)
  for (let i = 0; i < sections; i++) {
    const section = optional + optionalSize + i * 40
    const size = bytes.readUInt32LE(section + 16)
    const start = bytes.readUInt32LE(section + 20)
    if (start + size > bytes.length) throw new Error('PE section outside file')
    imageEnd = Math.max(imageEnd, start + size)
  }
  // Authenticode certificate tables use file offsets rather than RVAs.
  let certificate = null
  if (optionalSize >= 152 && bytes.readUInt32LE(optional + 108) > 4) {
    const start = bytes.readUInt32LE(optional + 144)
    const size = bytes.readUInt32LE(optional + 148)
    if (size) {
      if (start < imageEnd || start + size > bytes.length) throw new Error('Invalid PE certificate range')
      certificate = { start, size }
    }
  }
  return { arch, machine, imageEnd, certificate, size: bytes.length }
}

function listFiles(root, ignored = new Set(['node_modules', 'target', 'dist', 'gen', '.git'])) {
  const files = []
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Input links are not accepted: ${file}`)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push(file)
      else throw new Error(`Unsupported input: ${file}`)
    }
  }
  visit(root)
  return files
}

function fingerprint(root, inputs) {
  const files = [...new Set(inputs.flatMap(file => fs.statSync(file).isDirectory() ? listFiles(file) : [file]))].sort()
  const entries = files.map(file => ({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: sha256(file) }))
  return { fingerprint: hash(JSON.stringify(entries)), entries }
}

function assertUnchanged(before, after) {
  if (before.fingerprint !== after.fingerprint) throw new Error('Build inputs changed during the build; artifact is not a current-input deliverable')
}

function uniqueOutput(root) {
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'verification-'))
}

module.exports = { MACHINES, hash, sha256, assertFile, peInfo, listFiles, fingerprint, assertUnchanged, uniqueOutput }
