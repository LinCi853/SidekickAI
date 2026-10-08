const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPrivateKey, createPublicKey } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { loadMsvcEnvironment } = require('./windows-toolchain.cjs')
const { cloudBuildEnvironment } = require('./oxy-build-config.cjs')

function nativeTestEnvironment(base, toolchain = {}, { testTrust = false } = {}) {
  const cloud = cloudBuildEnvironment({ ...base, ...toolchain })
  const env = { ...base, ...toolchain, ...cloud }
  if (!testTrust) return env
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x63),
  ]), type: 'pkcs8', format: 'der' })
  const fixture = { id: 'maintenance-test-publisher', publicKey: createPublicKey(privateKey).export({ format: 'jwk' }) }
  const keys = JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON)
  const existing = keys.find(key => key.id === fixture.id)
  if (existing && existing.publicKey.x !== fixture.publicKey.x) throw new Error('The isolated maintenance test identity conflicts with configured public trust')
  if (!existing) keys.push(fixture)
  if (keys.length > 16) throw new Error('Isolated maintenance test trust exceeds the supported key limit')
  env.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON = JSON.stringify(keys)
  return env
}

function main({ testTrust = false } = {}) {
  if (!testTrust) throw new Error('Native installer verification requires explicitly isolated test trust.')

  if (process.platform !== 'win32') throw new Error('Native installer verification requires Windows.')
  require('./gen-install-manifest.cjs').main()
  const workspace = path.resolve(__dirname, '..')
  const { environment } = loadMsvcEnvironment('x64')
  const env = nativeTestEnvironment(process.env, environment, { testTrust })
  delete env.SIDEKICK_SKIP_PROCESS_E2E
  env.CARGO_TARGET_DIR = process.env.SIDEKICK_NATIVE_TEST_TARGET || path.join(workspace, 'build/cargo-targets/edition-maintenance')
  const fixtureParent = path.join(workspace, 'build/native-test-jobs')
  fs.mkdirSync(fixtureParent, { recursive: true })
  env.SIDEKICK_BACKUP_JOB_ROOT = fs.mkdtempSync(path.join(fixtureParent, 'run-'))

  function cargo(args) {
    const result = spawnSync('cargo', args, { cwd: workspace, env, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }

  const runtime = spawnSync(process.execPath, [path.join(workspace, 'scripts/build-backup-runtime.cjs'), 'x64'], { cwd: workspace, env, stdio: 'inherit', windowsHide: true })
  if (runtime.error) throw runtime.error
  if (runtime.status !== 0) process.exit(runtime.status ?? 1)
  env.SIDEKICK_REQUIRE_BACKUP_RUNTIME = '1'

  cargo(['build', '--offline', '--jobs', '3', '--manifest-path', 'uninstaller-tauri/src-tauri/Cargo.toml'])
  const rawArtifact = path.join(env.CARGO_TARGET_DIR, 'debug/sidekickai-uninstaller.exe')
  const bytes = fs.readFileSync(rawArtifact)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const artifact = path.join(workspace, 'build/native-test-artifacts', digest, 'sidekickai-uninstaller.exe')
  fs.mkdirSync(path.dirname(artifact), { recursive: true })
  if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, bytes, { flag: 'wx' })
  if (createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') !== digest) throw new Error('Retained test artifact digest mismatch')
  env.SIDEKICK_UNINSTALLER_ARTIFACT = artifact
  env.SIDEKICK_UNINSTALLER_SHA256 = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
  fs.writeFileSync(path.join(workspace, 'build/native-test-evidence.json'), JSON.stringify({ edition: require('../product-edition.json').edition, artifact,
    sha256: env.SIDEKICK_UNINSTALLER_SHA256, productVersion: require('../package.json').version,
    componentVersion: require('./component-contract.cjs').componentVersion(), testTrust, testTrustKeyId: 'maintenance-test-publisher' }, null, 2) + '\n')
  cargo(['test', '--offline', '--jobs', '3', '--manifest-path', 'installer-shared/uninstall-host/Cargo.toml', '--lib', '--', '--test-threads=1'])
  cargo(['test', '--offline', '--jobs', '3', '--manifest-path', 'installer-tauri/src-tauri/Cargo.toml', '--lib', '--', '--test-threads=1'])
  if (path.dirname(path.resolve(env.SIDEKICK_BACKUP_JOB_ROOT)) !== fixtureParent) throw new Error('Invalid native test staging directory')
  fs.rmSync(env.SIDEKICK_BACKUP_JOB_ROOT, { recursive: true, force: true })
}

module.exports = { nativeTestEnvironment, main }
if (require.main === module) main({ testTrust: true })
