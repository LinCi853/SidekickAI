'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MACHINES = { x64: 0x8664, arm64: 0xaa64 }
const MAGIC = Buffer.from('SKPAYLD1')
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
  // Authenticode is a file-offset directory, not an RVA. No arbitrary overlay is accepted.
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

function footerInfo(bytes) {
  if (bytes.length < 28) return null
  const offset = bytes.length - 28
  if (!bytes.subarray(offset, offset + 8).equals(MAGIC)) return null
  if (bytes.readUInt32LE(offset + 24) !== 28) throw new Error('Invalid Setup footer length')
  const payload = Number(bytes.readBigUInt64LE(offset + 8))
  const sevenz = Number(bytes.readBigUInt64LE(offset + 16))
  const wizard = bytes.length - 28 - payload - sevenz
  if (!Number.isSafeInteger(payload) || !Number.isSafeInteger(sevenz) || payload <= 0 || sevenz <= 0 || wizard <= 0) throw new Error('Invalid Setup footer ranges')
  return { wizard, payload, sevenz, footer: 28 }
}

function hasAsarArchive(bytes) {
  // ASAR starts with Chromium pickle lengths and a JSON filesystem tree. Identity
  // scanning strings such as resources/app.asar do not constitute embedded data.
  const prefix = Buffer.from([4, 0, 0, 0])
  let at = bytes.indexOf(prefix)
  while (at >= 0 && at + 16 <= bytes.length) {
    const header = bytes.readUInt32LE(at + 4)
    const pickle = bytes.readUInt32LE(at + 8)
    const length = bytes.readUInt32LE(at + 12)
    if (length > 10 && length < 64 * 1024 * 1024 && pickle + 4 === header && length + 4 <= pickle && at + 16 + length <= bytes.length) {
      try {
        const value = JSON.parse(bytes.toString('utf8', at + 16, at + 16 + length))
        if (value && typeof value.files === 'object') return true
      } catch {}
    }
    at = bytes.indexOf(prefix, at + 1)
  }
  return false
}

function assertStandaloneBinary(file, arch) {
  assertFile(file)
  const bytes = fs.readFileSync(file)
  const info = peInfo(bytes)
  if (arch && info.arch !== arch) throw new Error(`ARCH_MISMATCH: expected ${arch}, got ${info.arch}: ${file}`)
  if (footerInfo(bytes)) throw new Error(`Standalone contains Setup payload footer: ${file}`)
  for (const name of ['payload.7z', '7zr.exe']) {
    if (bytes.includes(Buffer.from(name)) || bytes.includes(Buffer.from(name, 'utf16le'))) throw new Error(`Standalone contains installer payload dependency: ${name}`)
  }
  if (bytes.includes(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) || hasAsarArchive(bytes)) throw new Error('Standalone contains archive data')
  const overlayEnd = info.certificate ? info.certificate.start + info.certificate.size : info.imageEnd
  const gap = info.certificate ? bytes.subarray(info.imageEnd, info.certificate.start) : Buffer.alloc(0)
  if (overlayEnd !== bytes.length || gap.length > 7 || gap.some(byte => byte !== 0)) throw new Error('Standalone contains unexplained PE overlay')
  return { ...info, sha256: hash(bytes) }
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

function verifyArtifact(file, manifest, arch, version) {
  const info = assertStandaloneBinary(file, arch)
  if (manifest.edition !== require('../product-edition.json').edition || manifest.protocolVersion !== 1 || manifest.arch !== arch || manifest.version !== version || !/^[a-f0-9]{64}$/.test(manifest.inputFingerprint || '') || manifest.sha256 !== info.sha256 || manifest.size !== info.size) throw new Error('Uninstaller manifest does not match current artifact bytes/version/architecture')
  return info
}

function stageUninstaller(file, manifest, directory, arch, version) {
  verifyArtifact(file, manifest, arch, version)
  const destination = path.join(directory, 'uninstall.exe')
  fs.copyFileSync(file, destination)
  fs.writeFileSync(path.join(directory, 'uninstall-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  verifyArtifact(destination, manifest, arch, version)
}

function uniqueOutput(root) {
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'verification-'))
}

function assertDependencyBoundary(depfile) {
  assertFile(depfile)
  const text = fs.readFileSync(depfile, 'utf8').replaceAll('\\', '/')
  if (/installer-tauri\/src-tauri\/src\/(?:engine|manifest|encrypt|elevate)\.rs|(?:^|\s)\S*payload\.7z|7zr\.exe/.test(text)) throw new Error(`Standalone links installer implementation or payload: ${depfile}`)
  return { depfile, sha256: sha256(depfile) }
}

module.exports = { MACHINES, hash, sha256, assertFile, peInfo, footerInfo, hasAsarArchive, assertStandaloneBinary, fingerprint, assertUnchanged, verifyArtifact, stageUninstaller, uniqueOutput, listFiles, assertDependencyBoundary }
