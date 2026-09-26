const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const installer = path.join(root, 'installer-tauri')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const arch = process.argv.includes('--arm64') ? 'arm64' : 'x64'
const archiveDirectory = arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
const appDirectory = path.join(root, 'dist', archiveDirectory)
const cargoTarget = path.join(root, 'build/cargo-targets/installer')
const sevenz = 'C:/Program Files/7-Zip/7z.exe'
const extractor = path.join(root, 'build/tools/7zr.exe')
const outputIndex = process.argv.indexOf('--output-dir')
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output-dir requires a directory')
const outputDirectory = outputIndex < 0 ? path.join(root, 'release', pkg.version, 'installer') : path.resolve(process.argv[outputIndex + 1])
const output = path.join(outputDirectory, 'SidekickAI-OpenSource-Setup-' + pkg.version + '-' + arch + '.exe')
const hash = value => createHash('sha256').update(value).digest()

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw result.error || new Error('Build command failed: ' + command)
}

function manifest() {
  if (!fs.existsSync(path.join(appDirectory, 'SidekickAI-OpenSource.exe'))) throw new Error('Build the matching open-source application first')
  if (fs.existsSync(path.join(appDirectory, 'portable.txt')) || fs.existsSync(path.join(appDirectory, 'data'))) throw new Error('An installer cannot include portable data')
  const asar = require('@electron/asar')
  const packaged = JSON.parse(asar.extractFile(path.join(appDirectory, 'resources/app.asar'), 'package.json').toString())
  if (packaged.name !== pkg.name || packaged.version !== pkg.version || packaged.editionSessionProtocol !== 1) throw new Error('The packaged application identity is stale or incorrect')
  const files = {}
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('The application contains a filesystem link')
      if (entry.isDirectory()) collect(file)
      else {
        const relative = path.relative(appDirectory, file).split(path.sep).join('/')
        if (relative !== 'sidekick-open-source-payload.json') files[relative] = hash(fs.readFileSync(file)).toString('hex')
      }
    }
  }
  collect(appDirectory)
  fs.writeFileSync(path.join(appDirectory, 'sidekick-open-source-payload.json'), JSON.stringify({ schema: 1, edition: pkg.name, version: pkg.version, arch, files }, null, 2))
}

function main() {
  if (pkg.name !== 'sidekickai-opensource') throw new Error('This builder only produces the open-source installer')
  if (arch !== 'x64' || process.arch !== 'x64' || process.platform !== 'win32') throw new Error('This installer builder requires Windows x64; ARM64 needs a native build and validation')
  if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing artifact: ' + output)
  for (const binary of [sevenz, extractor]) if (!fs.existsSync(binary)) throw new Error('Missing archive tool: ' + binary)
  manifest()
  run(process.execPath, [path.join(root, 'scripts/gen-install-manifest.cjs')], root)
  run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(installer, 'tsconfig.json')], root)
  run(process.execPath, [path.join(installer, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle', '--', '--offline', '--jobs', '2'], installer, { CARGO_TARGET_DIR: cargoTarget, TAURI_ENV_PLATFORM: 'windows' })
  const buildDirectory = fs.mkdtempSync(path.join(root, 'build/opensource-installer-'))
  const payload = path.join(buildDirectory, 'payload.7z')
  run(sevenz, ['a', '-t7z', '-mx=7', '-md=64m', '-ms=on', '-y', payload, archiveDirectory], path.join(root, 'dist'))
  const wizard = fs.readFileSync(path.join(cargoTarget, 'release/sidekickai-installer.exe'))
  const archive = fs.readFileSync(payload)
  const unpacker = fs.readFileSync(extractor)
  const footer = Buffer.alloc(92)
  footer.write('SKOSPK01', 0, 'ascii')
  footer.writeBigUInt64LE(BigInt(archive.length), 8)
  footer.writeBigUInt64LE(BigInt(unpacker.length), 16)
  hash(archive).copy(footer, 24)
  hash(unpacker).copy(footer, 56)
  footer.writeUInt32LE(92, 88)
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(output, Buffer.concat([wizard, archive, unpacker, footer]), { flag: 'wx' })
  fs.writeFileSync(output + '.sha256', hash(fs.readFileSync(output)).toString('hex') + '  ' + path.basename(output) + '\n', { flag: 'wx' })
  console.log('Open-source installer: ' + output)
}

try { main() } catch (error) { console.error(error); process.exitCode = 1 }
