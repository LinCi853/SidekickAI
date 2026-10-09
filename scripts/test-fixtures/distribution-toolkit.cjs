'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const crc32 = require('buffer-crc32')
const u = require('../build-utils.cjs')
const payloadApi = require('../application-payload.cjs')
const { pe, createRuntime } = require('./application-runtime.cjs')

function fixtureRoot(t) {
  const parent = path.resolve(__dirname, '../../build/test-fixtures')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'distribution-toolkit-'))
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== parent) throw new Error('Fixture cleanup leaves its owned directory')
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function zipBytes(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const bytes = Buffer.from(entry.bytes)
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)
    const crc = crc32.unsigned(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, bytes)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((mode * 65536) | (entry.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + bytes.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function toolkitFixture() {
  const entries = []
  const files = []
  const add = (name, role, architecture, bytes) => {
    entries.push({ name, bytes })
    files.push({ path: name, role, architecture, size: bytes.length, sha256: u.hash(bytes) })
  }
  add('bin/SidekickDistribution.exe', 'assembler', 'x64', pe('x64'))
  for (const arch of ['x64', 'arm64']) {
    for (const role of ['wizard-template', 'uninstaller-template', 'recovery-template']) {
      add('templates/' + arch + '/' + role + '.exe', role, arch, pe(arch))
    }
    add('runtime/' + arch + '/backup-runtime.zip', 'backup-runtime', arch,
      zipBytes([{ name: 'node.exe', bytes: pe(arch) }, { name: 'restore.cjs', bytes: Buffer.from('fixture runtime') }]))
  }
  add('product-contract.json', 'product-contract', null, Buffer.from('{"fixture":true}\n'))
  add('LICENSE.txt', 'license', null, Buffer.from('Fixture license notice\n'))
  const placeholderKey = { crv: 'Ed25519', kty: 'OKP',
    x: Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex').toString('base64url') }
  const manifest = {
    schemaVersion: 1, kind: 'sidekick-distribution-toolkit', toolkitVersion: '1.2.0', interfaceVersion: 1,
    maintenanceComponentVersion: '1.1.0', recoveryComponentVersion: '1.0.0',
    placeholderTrust: { id: 'self-built-' + u.hash(JSON.stringify(placeholderKey)), publicKey: placeholderKey },
    host: { platform: 'windows', architecture: 'x64' }, assembler: 'bin/SidekickDistribution.exe',
    capabilities: [{ edition: 'concept', mode: 'offline', authority: 'self-built', architectures: ['x64', 'arm64'] }],
    files,
  }
  return { manifest, entries }
}

function writeToolkit(root, fixture = toolkitFixture()) {
  fs.mkdirSync(root, { recursive: true })
  const archive = path.join(root, 'toolkit.zip')
  const manifestEntries = fixture.manifest === null ? []
    : [{ name: 'toolkit-manifest.json', bytes: Buffer.from(JSON.stringify(fixture.manifest) + '\n') }]
  fs.writeFileSync(archive, zipBytes([...manifestEntries, ...fixture.entries]))
  const reference = {
    schemaVersion: 1, toolkitVersion: fixture.manifest?.toolkitVersion || '1.2.0', interfaceVersion: 1,
    archive: { url: pathToFileURL(archive).href, size: fs.statSync(archive).size, sha256: u.sha256(archive) },
  }
  return { archive, reference, manifest: fixture.manifest }
}

async function createPayloads(root, productVersion = '9.4.2') {
  const payloads = []
  for (const architecture of ['x64', 'arm64']) {
    const source = await createRuntime(path.join(root, 'applications'), architecture, { edition: 'concept', productVersion })
    payloads.push(payloadApi.packApplicationPayload({
      source, output: path.join(root, 'payloads'), architecture, edition: 'concept', productVersion,
    }))
  }
  return payloads
}

function assemblyResult(request, toolkit) {
  const manifests = Object.fromEntries(Object.entries(request.payloads).map(([arch, file]) =>
    [arch, JSON.parse(fs.readFileSync(file, 'utf8'))]))
  const publicKey = { crv: 'Ed25519', kty: 'OKP',
    x: Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url') }
  const publicIdentity = { id: 'self-built-' + u.hash(JSON.stringify(publicKey)), publicKey }
  const result = {
    schemaVersion: 1, interfaceVersion: 1, toolkitVersion: toolkit.reference.toolkitVersion,
    toolkitManifestSha256: u.sha256(path.join(toolkit.directory, 'toolkit-manifest.json')),
    edition: 'concept', mode: 'offline', authority: 'self-built', productVersion: manifests.x64.productVersion,
    issuerKeyId: publicIdentity.id, issuerFingerprint: u.hash(JSON.stringify(publicIdentity)), publicIdentity,
    inputs: Object.fromEntries(Object.entries(request.payloads).map(([arch, file]) => [arch, {
      manifestSha256: u.sha256(file), archiveSha256: manifests[arch].archive.sha256,
    }])),
    artifacts: [],
  }
  fs.mkdirSync(request.outputDirectory)
  for (const architecture of ['x64', 'arm64']) {
    const retained = path.join(request.outputDirectory, 'inputs', architecture)
    fs.mkdirSync(retained, { recursive: true })
    fs.copyFileSync(request.payloads[architecture], path.join(retained, 'application.manifest.json'))
    const archive = manifests[architecture].archive.file
    fs.copyFileSync(path.join(path.dirname(request.payloads[architecture]), archive), path.join(retained, archive))
    const name = 'SidekickAI-Setup-' + result.productVersion + '-' + architecture + '.exe'
    const bytes = pe(architecture)
    fs.writeFileSync(path.join(request.outputDirectory, name), bytes)
    result.artifacts.push({ path: name, role: 'offline-installer', architecture, size: bytes.length, sha256: u.hash(bytes) })
  }
  return result
}

function mockAssembler(toolkit, hooks = {}) {
  const calls = []
  let request
  const respond = value => ({ status: 0, stdout: JSON.stringify(value) + '\n', stderr: '' })
  const spawn = (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    if (args[0] === 'inspect') {
      const result = { interfaceVersion: 1, toolkitVersion: toolkit.reference.toolkitVersion,
        capabilities: structuredClone(toolkit.manifest.capabilities), verified: true }
      return hooks.inspect?.({ result, respond }) || respond(result)
    }
    if (args[0] === 'assemble') {
      request = JSON.parse(fs.readFileSync(args[2], 'utf8'))
      const result = assemblyResult(request, toolkit)
      const resultFile = path.join(request.outputDirectory, 'assembly-result.json')
      const response = { schemaVersion: 1, outputDirectory: request.outputDirectory, resultFile }
      const outcome = hooks.assemble?.({ request, result, resultFile, response, respond })
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
      return outcome || respond(response)
    }
    if (args[0] === 'verify') {
      const resultFile = args[4]
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      const verified = { ...result, verified: true }
      for (const name of ['schemaVersion', 'toolkitManifestSha256', 'publicIdentity']) delete verified[name]
      return hooks.verify?.({ request, result, resultFile, verified, respond }) || respond(verified)
    }
    throw new Error('Unexpected fixture assembler operation: ' + args[0])
  }
  return { calls, spawn }
}

module.exports = { fixtureRoot, zipBytes, toolkitFixture, writeToolkit, createPayloads, assemblyResult, mockAssembler }
