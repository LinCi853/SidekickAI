'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const esbuild = require('esbuild')
const { rootPackageVersion } = require('./sync-versions.cjs')
const { readContract } = require('./component-contract.cjs')
const { atomicWrite } = require('./build-cache.cjs')

const ROOT = path.resolve(__dirname, '..')

function generateManifest(root = ROOT, distribution = {}) {
  const entry = path.join(root, 'electron/shared/install-manifest-source.ts')
  const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(path.join(root, 'package.json')), module, module.exports)
  const { features, options } = module.exports.INSTALL_MANIFEST
  const presentation = JSON.parse(JSON.stringify({ features, options }))
  const contract = readContract(root)
  const edition = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8')).edition
  const online = edition === 'community'
  const targetArchitecture = online ? null : distribution.targetArchitecture || 'x64'
  const manifest = { schemaVersion: contract.setupProtocolVersion, edition, productVersion: rootPackageVersion(root),
    componentVersion: contract.componentVersion, uninstallProtocolVersion: contract.uninstallProtocolVersion,
    distributionProtocolVersion: contract.distributionProtocolVersion,
    distributionMode: online ? 'online' : 'offline', targetArchitecture,
    executableArchitecture: online ? 'x64' : targetArchitecture,
    supportedNativeArchitectures: online ? ['x64', 'arm64'] : [targetArchitecture],
    distributionProof: distribution.distributionProof || null, ...presentation }
  require('./setup-metadata.cjs').validateManifest(manifest, contract, edition, { requireProof: false })
  return manifest
}

function main() {
  const manifest = generateManifest()
  const output = path.join(ROOT, 'build/setup-metadata.json')
  atomicWrite(output, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[install-manifest] ${output}: ${manifest.features.length} features, ${manifest.options.length} options`)
  return manifest
}

module.exports = { generateManifest, main }
if (require.main === module) {
  try { main() } catch (error) { console.error(`[install-manifest] ${error.message}`); process.exitCode = 1 }
}
