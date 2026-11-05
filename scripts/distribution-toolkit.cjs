'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')
const archive = require('./application-archive.cjs')
const runtime = require('./application-runtime.cjs')
const u = require('./build-utils.cjs')
const TRUSTED_RELEASE = require('./distribution-toolkit-release.cjs')

const INTERFACE_VERSION = 1
const MAX_REFERENCE_BYTES = 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_FILES = 64
const EDITIONS = ['concept', 'community']
const ARCHITECTURES = ['x64', 'arm64']
const EXECUTABLE = 'bin/AppLifecycleToolkit.exe'
// Pinned toolkit 0.1.10 layout. The archive itself is pinned by size and SHA-256;
// this inventory keeps cache reuse honest without trusting extracted directories.
const INVENTORY = [
  [EXECUTABLE, 93672960, 'd0e7fb4cc7fddaf3162b3472c03bc69a0a0ad15e9d08efc1336733491f5ae021'],
  ['README.md', 21996, '076e606dae5c78f37fe21f68d95920e2c5fd621af7744c7694759ff00c989741'],
  [
    'sample/app.manifest.jsonc',
    986,
    '28ded50ffc6a016a3fcb59ad5f165e7862c0a2415e4e459415be5a2752df9303',
  ],
  [
    'extractor/concept/x64/setup.exe',
    13941248,
    'e6b95d19ca5083911885e0a7c719b0fd4340eeb4af9f0ec5f883b5850ee7111f',
  ],
  [
    'extractor/concept/x64/wizard-manifest.json',
    322,
    '33fdd2ad540b2af5030efdcbc6798cddd6dcba1e452f85c72a4837134effd77a',
  ],
  [
    'extractor/concept/arm64/setup.exe',
    12556800,
    'b9264867449dffe4bc893584ddc3946a0c89add3b357b51b460dda125cea3f13',
  ],
  [
    'extractor/concept/arm64/wizard-manifest.json',
    324,
    '10c99a5c48b1895f4625edf2889a27fcdf082add95ef46ad6ac0c95f4aee3667',
  ],
  [
    'extractor/community/x64/setup.exe',
    13963264,
    'd2049c4330c35a9006d1b9d882ca5febd80871c3e37ef708ed5344291c039308',
  ],
  [
    'extractor/community/x64/wizard-manifest.json',
    324,
    'e6b9b87b8afd0c00ef64554690acd9192606d3703503fa7ade1721ce80c88340',
  ],
  [
    'extractor/community/arm64/setup.exe',
    12577280,
    '0b1b3e0293618abe69c91a83c35364be2baa01bf7e962c65a23eef21b2317fdc',
  ],
  [
    'extractor/community/arm64/wizard-manifest.json',
    326,
    '4df34fed337b462f5031735d5da8d5a5e53287675e33f3b917e4ca8a530da424',
  ],
  [
    'uninstallers/concept/x64/uninstall.exe',
    9568768,
    '6eb6f671d8d0e3dc642e4bb5ec0a851136f9e2d5841ece8508ba94b7da133f6f',
  ],
  [
    'uninstallers/concept/x64/uninstall-manifest.json',
    321,
    '898d09b8dcaf4f438da91e6bb646b83f9acfadcd97d258372d404febb3aad695',
  ],
  [
    'uninstallers/concept/arm64/uninstall.exe',
    8623616,
    '70f3722dba9ec176d1cdaa218a3a2501100c7f22f746770fcf3e2aef48eaf4ab',
  ],
  [
    'uninstallers/concept/arm64/uninstall-manifest.json',
    323,
    '4c5e10fc177d17d4eec1102a667ff0230ac349fe107d2f39459525aa990874ab',
  ],
  [
    'uninstallers/community/x64/uninstall.exe',
    9568768,
    'c5321b359cf959951a128b156ee3128a0d91f32b6fcd7f56e33ac257a628ed69',
  ],
  [
    'uninstallers/community/x64/uninstall-manifest.json',
    323,
    'ba6c983a30f423fe0613ba497210421113f48d04b5b63c3905e5a347d62ee9f1',
  ],
  [
    'uninstallers/community/arm64/uninstall.exe',
    8623616,
    '512bdd1fe3a2dd99e1b1216384aefdcb45fc6a46f370e509d8706380adf2d1c6',
  ],
  [
    'uninstallers/community/arm64/uninstall-manifest.json',
    325,
    '3203646b1b85a6fa9eded69a1e686011fb3056676b6a20fe8630740921d4a68e',
  ],
].map(([filePath, size, sha256]) => ({ path: filePath, size, sha256 }))

function fields(value, required, optional = []) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Invalid distribution toolkit fields')
}

function validVersion(value) {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  )
}

function digest(value) {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
}

function location(value, allowLoopback = false) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('Invalid toolkit archive location')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Toolkit archive location must be an absolute URL')
  }
  if (url.username || url.password || url.hash)
    throw new Error('Toolkit archive location cannot contain credentials or a fragment')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'file:' &&
    !(allowLoopback && url.protocol === 'http:' && loopback)
  ) {
    throw new Error('Toolkit downloads require HTTPS or an explicitly selected local file')
  }
  if (url.protocol === 'file:' && url.hostname)
    throw new Error('Network file locations are not supported')
  return url
}

function validateReference(reference, options = {}) {
  fields(reference, ['schemaVersion', 'toolkitVersion', 'interfaceVersion', 'archive'])
  if (
    reference.schemaVersion !== 1 ||
    reference.interfaceVersion !== INTERFACE_VERSION ||
    !validVersion(reference.toolkitVersion)
  ) {
    throw new Error('Unsupported distribution toolkit reference')
  }
  fields(reference.archive, ['size', 'sha256'], ['url', 'path'])
  if (Object.hasOwn(reference.archive, 'url') === Object.hasOwn(reference.archive, 'path')) {
    throw new Error('Toolkit archive requires exactly one URL or project-relative path')
  }
  if (
    !Number.isSafeInteger(reference.archive.size) ||
    reference.archive.size < 1 ||
    reference.archive.size > MAX_ARCHIVE_BYTES ||
    !digest(reference.archive.sha256)
  )
    throw new Error('Invalid distribution toolkit archive identity')
  if (reference.toolkitVersion !== TRUSTED_RELEASE.toolkitVersion) {
    throw new Error(
      'Distribution toolkit version must match the trusted release ' +
        TRUSTED_RELEASE.toolkitVersion,
    )
  }
  if (reference.archive.size !== TRUSTED_RELEASE.size) {
    throw new Error(
      'Distribution toolkit archive size must match the trusted release (' +
        TRUSTED_RELEASE.size +
        ' bytes)',
    )
  }
  if (reference.archive.sha256 !== TRUSTED_RELEASE.sha256) {
    throw new Error(
      'Distribution toolkit archive SHA-256 must match the trusted release ' +
        TRUSTED_RELEASE.sha256,
    )
  }
  if (Object.hasOwn(reference.archive, 'path')) runtime.validateRelativePath(reference.archive.path)
  else location(reference.archive.url, options.allowLoopback)
  return reference
}

function readReference(root, options = {}) {
  const file = path.resolve(
    options.referenceFile ||
      options.env?.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE ||
      process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE ||
      path.join(root, 'contracts/distribution-toolkit.json'),
  )
  if (!fs.existsSync(file))
    throw new Error(
      '安装维护待组装包尚未配置；请提供发布清单 SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE。',
    )
  u.assertFile(file)
  if (fs.statSync(file).size > MAX_REFERENCE_BYTES)
    throw new Error('Distribution toolkit reference exceeds its size limit')
  const bytes = fs.readFileSync(file)
  let reference
  try {
    reference = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Cannot parse distribution toolkit reference')
  }
  return { file, sha256: u.hash(bytes), reference: validateReference(reference, options) }
}

function projectArchive(root, reference) {
  if (!root) throw new Error('Project-relative toolkit archives require a workspace root')
  root = path.resolve(root)
  const file = path.join(root, ...runtime.validateRelativePath(reference.archive.path).split('/'))
  for (let current = file; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error('Project toolkit archive cannot use filesystem links')
  }
  u.assertFile(file)
  if (
    fs.statSync(file).size !== reference.archive.size ||
    u.sha256(file) !== reference.archive.sha256
  ) {
    throw new Error('Project toolkit archive does not match its pinned size and SHA-256')
  }
  return file
}

async function download(reference, destination, options = {}) {
  const url = Object.hasOwn(reference.archive, 'path')
    ? pathToFileURL(projectArchive(options.root, reference))
    : location(reference.archive.url, options.allowLoopback)
  let input
  if (url.protocol === 'file:') {
    const source = fileURLToPath(url)
    u.assertFile(source)
    input = fs.createReadStream(source)
  } else {
    const response = await (options.fetch || fetch)(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5 * 60 * 1000),
    })
    if (!response.ok || !response.body)
      throw new Error('Distribution toolkit download failed: HTTP ' + response.status)
    location(response.url || url.href, options.allowLoopback)
    input = Readable.fromWeb(response.body)
  }
  let written = 0
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length
      callback(
        written > reference.archive.size
          ? new Error('Toolkit download exceeds its declared size')
          : null,
        chunk,
      )
    },
  })
  await pipeline(input, limit, fs.createWriteStream(destination, { flags: 'wx' }))
  if (written !== reference.archive.size || u.sha256(destination) !== reference.archive.sha256)
    throw new Error('Toolkit archive does not match its pinned size and SHA-256')
}

async function extract(file, directory) {
  fs.mkdirSync(directory)
  const zip = await yauzl.openPromise(file, {
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  })
  try {
    for await (const entry of zip.eachEntry()) {
      const isDirectory = entry.fileName.endsWith('/')
      runtime.validateRelativePath(isDirectory ? entry.fileName.slice(0, -1) : entry.fileName)
      const target = path.join(directory, ...entry.fileName.split('/'))
      if (isDirectory) {
        fs.mkdirSync(target, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await pipeline(
        await zip.openReadStreamPromise(entry),
        fs.createWriteStream(target, { flags: 'wx' }),
      )
    }
  } finally {
    await archive.closeArchive(zip)
  }
}

function verifyDirectory(directory, inventory = INVENTORY) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
    throw new Error('Toolkit root must be a regular directory')
  const files = u.listFiles(directory, new Set())
  const actual = files.map((file) => path.relative(directory, file).replaceAll('\\', '/')).sort()
  const expected = inventory.map((file) => file.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Extracted toolkit contains missing or unexpected files')
  for (const file of inventory) {
    const target = path.join(directory, ...file.path.split('/'))
    u.assertFile(target)
    if (fs.statSync(target).size !== file.size || u.sha256(target) !== file.sha256)
      throw new Error('Extracted toolkit file does not match its pinned identity: ' + file.path)
  }
  for (const file of inventory.filter((entry) => entry.path.endsWith('.exe'))) {
    const expectedArch = file.path.split('/').includes('arm64') ? 'arm64' : 'x64'
    if (
      u.peInfo(fs.readFileSync(path.join(directory, ...file.path.split('/')))).arch !== expectedArch
    )
      throw new Error('Distribution toolkit native architecture does not match its inventory')
  }
  verifyComponentManifests(directory)
  return u.fingerprint(directory, files)
}

function verifyComponentManifests(directory) {
  for (const edition of EDITIONS) {
    for (const arch of ARCHITECTURES) {
      for (const [kind, file, manifestFile] of [
        ['extractor', 'setup.exe', 'wizard-manifest.json'],
        ['uninstallers', 'uninstall.exe', 'uninstall-manifest.json'],
      ]) {
        const manifestPath = path.join(directory, kind, edition, arch, manifestFile)
        const executablePath = path.join(directory, kind, edition, arch, file)
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        if (
          manifest.protocolVersion !== 3 ||
          manifest.uninstallProtocolVersion !== 2 ||
          manifest.edition !== edition ||
          manifest.arch !== arch ||
          manifest.size !== fs.statSync(executablePath).size ||
          manifest.sha256 !== u.sha256(executablePath)
        ) {
          throw new Error(
            'Distribution toolkit component manifest does not match its executable: ' +
              kind +
              '/' +
              edition +
              '/' +
              arch,
          )
        }
      }
    }
  }
}

async function prepareToolkit(root, options = {}) {
  // `inventory` is a test seam: fixtures pin their own synthetic 0.1.7-shaped archive so the
  // same layout and component checks run without redistributing the real 70 MB toolkit.
  // Production callers never set it, so the published INVENTORY above stays authoritative.
  const inventory = options.inventory || INVENTORY
  const selected = options.reference
    ? { reference: validateReference(options.reference, options), file: null }
    : readReference(root, options)
  const reference = selected.reference
  const projectRoot = Object.hasOwn(reference.archive, 'path') ? path.resolve(root) : null
  if (projectRoot) projectArchive(projectRoot, reference)
  const parent = path.join(root, 'build/component-cache/lifecycle-toolkit')
  fs.mkdirSync(parent, { recursive: true })
  const destination = path.join(parent, reference.archive.sha256)
  let directory = destination
  const reused = fs.existsSync(destination)
  if (!reused) {
    directory = fs.mkdtempSync(path.join(parent, 'download-'))
    console.log('[toolkit] Preparing pinned lifecycle toolkit ' + reference.toolkitVersion)
    await download(reference, path.join(directory, 'archive.zip'), { ...options, root })
  }
  const zip = path.join(directory, 'archive.zip')
  u.assertFile(zip)
  if (
    fs.statSync(zip).size !== reference.archive.size ||
    u.sha256(zip) !== reference.archive.sha256
  )
    throw new Error('Cached toolkit does not match its pinned archive')
  const toolkitDirectory = path.join(directory, 'toolkit')
  if (!reused) await extract(zip, toolkitDirectory)
  const inputs = verifyDirectory(toolkitDirectory, inventory)
  if (!reused) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(directory, destination)
        break
      } catch (error) {
        if (
          attempt >= 7 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
          fs.existsSync(destination)
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
  }
  const toolkit = {
    reference,
    referenceFile: selected.file,
    referenceSha256: selected.sha256,
    projectRoot,
    directory: path.join(destination, 'toolkit'),
    archive: path.join(destination, 'archive.zip'),
    files: inventory,
    inputs,
    reused,
    version: reference.toolkitVersion,
    executable: EXECUTABLE,
  }
  assertUnchanged(toolkit)
  return toolkit
}

function componentPath(toolkit, kind, edition, arch) {
  if (!EDITIONS.includes(edition) || !ARCHITECTURES.includes(arch))
    throw new Error('Unsupported lifecycle component edition or architecture')
  const tree = kind === 'extractor' ? 'extractor' : kind === 'uninstaller' ? 'uninstallers' : null
  if (!tree) throw new Error('Unsupported lifecycle component kind')
  const file = kind === 'extractor' ? 'setup.exe' : 'uninstall.exe'
  const target = path.join(toolkit.directory, tree, edition, arch, file)
  u.assertFile(target)
  return target
}

function assertUnchanged(toolkit) {
  if (toolkit.projectRoot) projectArchive(toolkit.projectRoot, toolkit.reference)
  if (toolkit.referenceFile) {
    u.assertFile(toolkit.referenceFile)
    if (u.sha256(toolkit.referenceFile) !== toolkit.referenceSha256)
      throw new Error('Distribution toolkit reference changed during assembly')
  }
  u.assertFile(toolkit.archive)
  if (
    fs.statSync(toolkit.archive).size !== toolkit.reference.archive.size ||
    u.sha256(toolkit.archive) !== toolkit.reference.archive.sha256
  ) {
    throw new Error('Distribution toolkit archive changed during assembly')
  }
  u.assertUnchanged(toolkit.inputs, verifyDirectory(toolkit.directory, toolkit.files))
}

module.exports = {
  INTERFACE_VERSION,
  INVENTORY,
  MAX_FILES,
  MAX_REFERENCE_BYTES,
  fields,
  validVersion,
  digest,
  validateReference,
  readReference,
  verifyDirectory,
  prepareToolkit,
  componentPath,
  assertUnchanged,
}
