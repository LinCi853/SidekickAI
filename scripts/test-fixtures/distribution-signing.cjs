'use strict'

const crypto = require('node:crypto')
const distribution = require('../application-distribution.cjs')

function createSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const id = 'admin_fixture_' + crypto.randomBytes(12).toString('hex')
  return { id, privateKey, trust: [{ id, publicKey: publicKey.export({ format: 'jwk' }) }], source: 'isolated-fixture' }
}

function runtimePayload(edition = 'community', arch = 'x64') {
  const entry = (path, executableArchitecture = null) => ({ path, sizeBytes: 1,
    sha256: distribution.hash(Buffer.from(path)), executableArchitecture })
  return { protocolVersion: 1, productId: 'sidekickai', edition, componentId: 'backup-runtime', componentVersion: '1.0.0',
    nativeArchitecture: arch, archive: { sha256: 'a'.repeat(64), sizeBytes: 1 },
    files: [entry('node.exe', arch), entry('export.mjs'), entry('sidekick-backup.cjs')],
    exportProtocolVersion: 1, recoveryProtocolVersion: 1,
    entrypoints: { export: 'export.mjs', restore: 'sidekick-backup.cjs' } }
}

function bodyPayload({ edition = 'community', arch = 'x64', version = '0.1.5', archive = Buffer.from('application payload') } = {}) {
  const files = [
    { path: 'SidekickAI.exe', sizeBytes: 1, sha256: 'b'.repeat(64), executableArchitecture: arch },
    { path: 'maintenance/backup-runtime.zip', sizeBytes: 1, sha256: 'a'.repeat(64), executableArchitecture: null },
    { path: 'maintenance/runtime-proof.json', sizeBytes: 1, sha256: 'c'.repeat(64), executableArchitecture: null },
  ]
  return { protocolVersion: 1, productId: 'sidekickai', edition, productVersion: version, variant: 'installed',
    platform: 'windows', nativeArchitectures: [arch], maintenanceProtocolVersion: 1, recoveryProtocolVersion: 1,
    archive: { sha256: distribution.hash(archive), sizeBytes: archive.length, expandedBytes: 3, fileCount: 3 }, files,
    components: [{ componentId: 'backup-runtime', componentVersion: '1.0.0', nativeArchitecture: arch,
      archivePath: 'maintenance/backup-runtime.zip', proofPath: 'maintenance/runtime-proof.json',
      sha256: 'a'.repeat(64), sizeBytes: 1 }] }
}

module.exports = { createSigner, runtimePayload, bodyPayload }
