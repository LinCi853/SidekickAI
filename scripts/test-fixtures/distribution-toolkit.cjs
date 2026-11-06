'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire, wrap } = require('node:module')
const { runInThisContext } = require('node:vm')
const crc32 = require('buffer-crc32')
const u = require('../build-utils.cjs')
const payloadApi = require('../application-payload.cjs')
const { pe, createRuntime } = require('./application-runtime.cjs')

const TOOLKIT_VERSION = '0.1.7'
const EDITIONS = ['concept', 'community']
const ARCHITECTURES = ['x64', 'arm64']

function fixtureRoot(t) {
  const parent = path.resolve(__dirname, '../../build/test-fixtures')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'distribution-toolkit-'))
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== parent)
      throw new Error('Fixture cleanup leaves its owned directory')
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function zipBytes(entries) {
  const locals = [],
    centrals = []
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

// Mirrors the 0.1.15 toolkit: a fixed twenty-three-file layout with no toolkit manifest. Archive
// identity comes from the pinned reference; extracted content is bound to this inventory.
function toolkitFixture() {
  const entries = []
  const inventory = []
  const add = (name, bytes) => {
    entries.push({ name, bytes })
    inventory.push({ path: name, size: bytes.length, sha256: u.hash(bytes) })
  }
  add('bin/AppLifecycleToolkit.exe', pe('x64'))
  add('README.md', Buffer.from('Fixture toolkit readme\n'))
  add('sample/app.manifest.jsonc', Buffer.from('{\n  "comment": "fixture"\n}\n'))
  for (const edition of EDITIONS) {
    for (const arch of ARCHITECTURES) {
      for (const [kind, executable, manifestName] of [
        ['extractor', 'setup.exe', 'wizard-manifest.json'],
        ['uninstallers', 'uninstall.exe', 'uninstall-manifest.json'],
      ]) {
        const bytes = pe(arch)
        add(kind + '/' + edition + '/' + arch + '/' + executable, bytes)
        add(
          kind + '/' + edition + '/' + arch + '/' + manifestName,
          Buffer.from(
            JSON.stringify({
              protocolVersion: 3,
              uninstallProtocolVersion: 2,
              edition,
              arch,
              size: bytes.length,
              sha256: u.hash(bytes),
            }) + '\n',
          ),
        )
      }
      add(
        'uninstallers/' + edition + '/' + arch + '/product-edition.json',
        Buffer.from(JSON.stringify({ edition: edition }, null, 2) + '\n'),
      )
    }
  }
  return { version: TOOLKIT_VERSION, inventory, entries }
}

function writeToolkit(root, fixture = toolkitFixture()) {
  fs.mkdirSync(root, { recursive: true })
  const archive = path.join(root, 'toolkit.zip')
  fs.writeFileSync(archive, zipBytes(fixture.entries))
  const reference = {
    schemaVersion: 1,
    toolkitVersion: fixture.version,
    interfaceVersion: 1,
    archive: {
      url: pathToFileURL(archive).href,
      size: fs.statSync(archive).size,
      sha256: u.sha256(archive),
    },
  }
  return {
    archive,
    reference,
    inventory: fixture.inventory,
    toolkit: fixtureConsumer(reference, fixture.inventory),
  }
}

function fixtureConsumer(reference, inventory) {
  const filename = path.resolve(__dirname, '../distribution-toolkit.cjs')
  const load = createRequire(filename)
  const release = Object.freeze({
    toolkitVersion: reference.toolkitVersion,
    size: reference.archive.size,
    sha256: reference.archive.sha256,
  })
  const module = { exports: {} }
  const consumer = runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })
  consumer(
    module.exports,
    (name) => (name === './distribution-toolkit-release.cjs' ? release : load(name)),
    module,
    filename,
    path.dirname(filename),
  )
  return {
    ...module.exports,
    // Fixtures carry a synthetic archive, so every preparation pins the fixture's own layout.
    prepareToolkit: (root, options = {}) =>
      module.exports.prepareToolkit(root, {
        ...options,
        inventory: options.inventory || inventory,
      }),
  }
}

async function createPayloads(root, productVersion = '9.4.2') {
  const payloads = []
  for (const architecture of ARCHITECTURES) {
    const source = await createRuntime(path.join(root, 'applications'), architecture, {
      edition: 'concept',
      productVersion,
    })
    payloads.push(
      payloadApi.packApplicationPayload({
        source,
        output: path.join(root, 'payloads'),
        architecture,
        edition: 'concept',
        productVersion,
      }),
    )
  }
  return payloads
}

function keyIdFromArgs(args) {
  const index = args.indexOf('--key-file')
  if (index < 0) return 'self-built'
  const document = JSON.parse(fs.readFileSync(args[index + 1], 'utf8'))
  const keyId = document.adminKeys ? document.adminKeys[0]?.id : document.keyId
  if (!keyId) throw new Error('Fixture key file lacks an identity')
  return 'official:' + keyId
}

// Emulates the pinned 0.1.7 command line: build, verify-package-spec and assemble. Each
// successful step returns the JSON contract the workspace code parses from stdout.
function mockAssembler(hooks = {}) {
  const calls = []
  let lastDomain = 'self-built'
  const respond = (value) => ({ status: 0, stdout: JSON.stringify(value) + '\n', stderr: '' })
  const spawn = (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    const command = args[0]
    if (command === '--check') {
      const domain = hooks.domain || lastDomain
      return (
        hooks.check?.({ executable, args, domain, respond }) || {
          status: 0,
          stdout: 'package: ' + executable + '\ndomain: ' + domain + '\ncheck: ok\n',
          stderr: '',
        }
      )
    }
    const domain = hooks.domain || keyIdFromArgs(args)
    lastDomain = domain
    if (command === 'build') {
      const packageDir = args[args.indexOf('--out') + 1]
      fs.mkdirSync(packageDir, { recursive: true })
      fs.writeFileSync(
        path.join(packageDir, 'lifecycle-package.json'),
        JSON.stringify({
          schemaVersion: 1,
          edition: 'concept',
          form: 'offline',
          domain,
        }) + '\n',
      )
      return (
        hooks.build?.({ args, packageDir, domain, respond }) ||
        respond({ packageDir, domain, form: 'offline', built: true })
      )
    }
    if (command === 'verify-package-spec') {
      const packageDir = args[args.indexOf('--package-dir') + 1]
      return (
        hooks.verify?.({ args, packageDir, domain, respond }) ||
        respond({
          packageDir,
          domain,
          form: 'offline',
          checks: [{ id: 'package', ok: true }],
          configuration: {},
        })
      )
    }
    if (command === 'assemble') {
      const outFile = path.resolve(args[args.indexOf('--out') + 1])
      const architecture = args[args.indexOf('--arch') + 1]
      const bytes = pe(architecture)
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, bytes)
      return (
        hooks.assemble?.({ args, outFile, architecture, domain, bytes, respond }) ||
        respond({
          outFile,
          outputBytes: fs.statSync(outFile).size,
          outputSha256: u.sha256(outFile),
          domain,
          architectures: [architecture],
          edition: 'concept',
          form: 'offline',
        })
      )
    }
    throw new Error('Unexpected fixture assembler operation: ' + command)
  }
  return { calls, spawn }
}

module.exports = {
  TOOLKIT_VERSION,
  EDITIONS,
  ARCHITECTURES,
  fixtureRoot,
  zipBytes,
  toolkitFixture,
  writeToolkit,
  createPayloads,
  mockAssembler,
}
