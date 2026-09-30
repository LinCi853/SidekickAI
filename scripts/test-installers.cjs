const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { loadMsvcEnvironment } = require('./windows-toolchain.cjs')

if (process.platform !== 'win32') throw new Error('Native installer verification requires Windows.')
require('./gen-install-manifest.cjs').main()
const workspace = path.resolve(__dirname, '..')
const { environment } = loadMsvcEnvironment('x64')
const env = { ...process.env, ...environment }
delete env.SIDEKICK_SKIP_PROCESS_E2E
env.CARGO_TARGET_DIR = process.env.SIDEKICK_NATIVE_TEST_TARGET || path.join(workspace, 'build/cargo-targets/edition-maintenance')

function cargo(args) {
  const result = spawnSync('cargo', args, { cwd: workspace, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

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
  sha256: env.SIDEKICK_UNINSTALLER_SHA256, productVersion: require('../package.json').version, componentVersion: require('./component-contract.cjs').componentVersion() }, null, 2) + '\n')
cargo(['test', '--offline', '--jobs', '3', '--manifest-path', 'installer-shared/uninstall-host/Cargo.toml', '--lib'])
cargo(['test', '--offline', '--jobs', '3', '--manifest-path', 'installer-tauri/src-tauri/Cargo.toml', '--lib'])
