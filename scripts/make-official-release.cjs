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
  if (architecture !== 'x64' && architecture !== 'arm64') throw new Error('Unsupported architecture: ' + architecture)
  const version = option('version', require('../package.json').version)
  const batch = required('batch')
  const keyFile = path.resolve(required('key-file'))
  utilities.assertFile(keyFile)
  const payloadDirectory = path.resolve(option('payload-dir', path.join(ROOT, 'build', 'official-payloads')))

  const output = path.join(ROOT, 'build', 'official-release-' + architecture)
  if (fs.existsSync(output)) throw new Error('Assembly workspace already exists: ' + output)
  const release = path.join(ROOT, 'release', version, batch)
  if (fs.existsSync(release)) throw new Error('Release batch already exists: ' + release)

  const name = 'SidekickAI-Application-' + version + '-' + architecture
  const payloads = [{
    architecture,
    path: path.join(payloadDirectory, name + '.zip'),
    manifestPath: path.join(payloadDirectory, name + '.manifest.json'),
  }]
  for (const payload of payloads) {
    utilities.assertFile(payload.path)
    utilities.assertFile(payload.manifestPath)
  }

  Object.assign(process.env, require('./local-build-config.cjs').localBuildEnvironment(ROOT))
  const before = build.captureInputs(ROOT)
  const assembled = await assembly.assemble({
    root: ROOT, output, payloads, edition: 'concept', productVersion: version, keyFile,
  })
  utilities.assertUnchanged(before, build.captureInputs(ROOT))
  console.log('[release] Assembled ' + assembled.installers.map(item => item.path).join(', '))

  const launch = probe.probeInstallers({ installers: assembled.installers })
  console.log('[release] Launch probe: ' + JSON.stringify(launch.results))
  utilities.assertUnchanged(before, build.captureInputs(ROOT))

  const collected = build.collectCandidates({
    mode: 'installer', edition: 'concept', version, architectures: [architecture],
    inputs: before, payloads, assembly: assembled, launch,
  }, output)
  assembly.verifyCollected(assembled, collected.directory, {}, collected)
  utilities.assertUnchanged(before, build.captureInputs(ROOT))
  console.log('[release] Collected: ' + collected.directory)

  fs.mkdirSync(path.dirname(release), { recursive: true })
  fs.cpSync(collected.directory, release, { recursive: true, errorOnExist: true, force: false })
  for (const file of utilities.listFiles(release, new Set())) {
    const relative = path.relative(release, file).replaceAll('\\', '/')
    const source = path.join(collected.directory, ...relative.split('/'))
    if (utilities.sha256(file) !== utilities.sha256(source))
      throw new Error('Archived release bytes changed during copy: ' + relative)
  }
  console.log('[release] Archived: ' + release)
  console.log('[release] Summary: ' + JSON.stringify({
    release,
    authority: assembled.result.authority,
    domain: assembled.result.domain,
    issuerKeyId: assembled.result.issuerKeyId,
    artifacts: collected.manifest.artifacts.map(item => ({
      file: item.file, role: item.role, architecture: item.architecture, size: item.size,
      sha256: item.sha256, launch: item.launch || null,
    })),
  }))
}

main().catch(error => {
  console.error('[release] ' + (error.stack || error))
  process.exitCode = 1
})
