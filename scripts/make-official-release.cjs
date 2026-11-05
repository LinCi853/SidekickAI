'use strict'

// Assemble one official concept offline installer from the verified application payload,
// run the first-screen probe, collect a candidate and archive it under release/<version>/<batch>.
// Usage: node scripts/make-official-release.cjs --key-file <absolute.json> --batch <name>
//        [--arch x64|arm64] [--version <product version>] [--payload-dir <directory>]
// The key file is read-only input: its private key never enters logs or product evidence.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const build = require('./build-distribution.cjs')
const assembly = require('./assemble-application.cjs')
const probe = require('./installer-launch-smoke.cjs')
const utilities = require('./build-utils.cjs')
// A concept batch ships two products only: the portable archive and the offline installer.
// Application payloads and retained assembly inputs are build intermediates.
const DELIVERABLE_ROLES = new Set(['portable', 'offline-installer'])
const INTERMEDIATE_ROLES = new Set([
  'application-payload',
  'application-payload-manifest',
  'assembly-input',
  'installer-assembly-result',
])

function option(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index < 0 ? fallback : process.argv[index + 1]
}

function required(name) {
  const value = option(name)
  if (!value) throw new Error('Missing required option --' + name)
  return value
}

async function main() {
  const architecture = option('arch', 'x64')
  if (architecture !== 'x64' && architecture !== 'arm64')
    throw new Error('Unsupported architecture: ' + architecture)
  const version = option('version', require('../package.json').version)
  const batch = required('batch')
  const keyFile = path.resolve(required('key-file'))
  utilities.assertFile(keyFile)
  const payloadDirectory = path.resolve(
    option('payload-dir', path.join(ROOT, 'build', 'official-payloads')),
  )

  const output = path.join(ROOT, 'build', 'official-release-' + architecture)
  if (fs.existsSync(output)) throw new Error('Assembly workspace already exists: ' + output)
  const release = path.join(ROOT, 'release', version, batch)
  if (fs.existsSync(release)) throw new Error('Release batch already exists: ' + release)

  const name = 'SidekickAI-Application-' + version + '-' + architecture
  const payloads = [
    {
      architecture,
      path: path.join(payloadDirectory, name + '.zip'),
      manifestPath: path.join(payloadDirectory, name + '.manifest.json'),
    },
  ]
  for (const payload of payloads) {
    utilities.assertFile(payload.path)
    utilities.assertFile(payload.manifestPath)
  }

  Object.assign(process.env, require('./local-build-config.cjs').localBuildEnvironment(ROOT))
  const before = build.captureInputs(ROOT)
  const assembled = await assembly.assemble({
    root: ROOT,
    output,
    payloads,
    edition: 'concept',
    productVersion: version,
    keyFile,
  })
  utilities.assertUnchanged(before, build.captureInputs(ROOT))
  console.log('[release] Assembled ' + assembled.installers.map((item) => item.path).join(', '))

  const launch = probe.probeInstallers({ installers: assembled.installers })
  console.log('[release] Launch probe: ' + JSON.stringify(launch.results))
  utilities.assertUnchanged(before, build.captureInputs(ROOT))

  const collected = build.collectCandidates(
    {
      mode: 'installer',
      edition: 'concept',
      version,
      architectures: [architecture],
      inputs: before,
      payloads,
      assembly: assembled,
      launch,
    },
    output,
  )
  assembly.verifyCollected(assembled, collected.directory, {}, collected)
  utilities.assertUnchanged(before, build.captureInputs(ROOT))
  console.log('[release] Collected: ' + collected.directory)

  const deliverables = collected.manifest.artifacts.filter((item) => {
    if (DELIVERABLE_ROLES.has(item.role)) return true
    if (!INTERMEDIATE_ROLES.has(item.role))
      throw new Error('Unexpected release artifact role: ' + item.role)
    return false
  })
  const manifest = { ...collected.manifest, artifacts: deliverables }
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
  const checksumBytes = deliverables.map((item) => item.sha256 + '  ' + item.file).join('\n') + '\n'
  fs.mkdirSync(release, { recursive: true })
  for (const item of deliverables) {
    const relative = item.file.split('/')
    const target = path.join(release, ...relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(collected.directory, ...relative), target, fs.constants.COPYFILE_EXCL)
  }
  fs.writeFileSync(path.join(release, 'release-manifest.json'), manifestBytes, { flag: 'wx' })
  fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), checksumBytes, { flag: 'wx' })
  const expected = new Map([
    ...deliverables.map((item) => [item.file, item.sha256]),
    ['release-manifest.json', utilities.hash(manifestBytes)],
    ['SHA256SUMS.txt', utilities.hash(checksumBytes)],
  ])
  const archived = utilities.listFiles(release, new Set())
  if (
    archived.length !== expected.size ||
    archived.some((file) => {
      const relative = path.relative(release, file).replaceAll('\\', '/')
      return expected.get(relative) !== utilities.sha256(file)
    })
  )
    throw new Error('Archived release does not match its deliverables')
  console.log('[release] Archived: ' + release)
  console.log(
    '[release] Summary: ' +
      JSON.stringify({
        release,
        authority: assembled.result.authority,
        domain: assembled.result.domain,
        issuerKeyId: assembled.result.issuerKeyId,
        artifacts: deliverables.map((item) => ({
          file: item.file,
          role: item.role,
          architecture: item.architecture,
          size: item.size,
          sha256: item.sha256,
          launch: item.launch || null,
        })),
      }),
  )
}

main().catch((error) => {
  console.error('[release] ' + (error.stack || error))
  process.exitCode = 1
})
