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
// Pinned toolkit 0.1.13 layout. The archive itself is pinned by size and SHA-256;
// this inventory keeps cache reuse honest without trusting extracted directories.
// Each uninstaller is a triple: executable, manifest and edition selection.
const INVENTORY = [
  [
    'bin/AppLifecycleToolkit.exe',
    93675008,
    '9f2185226b39f1ed26bcb985e97dbad49d33a5263ddcca5d53a633ef277c854b',
  ],
  ['README.md', 28614, '4ef392655f99794c5c5033f69fec4abb168f11315e32e4c51359c4c67835e176'],
  [
    'sample/app.manifest.jsonc',
    986,
    '28ded50ffc6a016a3fcb59ad5f165e7862c0a2415e4e459415be5a2752df9303',
  ],
  [
    'extractor/concept/x64/setup.exe',
    13964288,
    'bb1b12be6451afac44131dac1e7be147a0ab7d4aeede7cb875cce4d50fe9291b',
  ],
  [
    'extractor/concept/x64/wizard-manifest.json',
    322,
    '2baa553757f8d246a7035b99d44c2ca6946c6077cc996ce438a9e6d13299e223',
  ],
  [
    'extractor/concept/arm64/setup.exe',
    12578304,
    '542da43528d5579f8720e34fb7149f9c80f034e6461c436f55d5276e204e464f',
  ],
  [
    'extractor/concept/arm64/wizard-manifest.json',
    324,
    '2c2ead540f0d024072cadb2adb8030cf729b8fce9c79c51e8413ec3740e8e0c9',
  ],
  [
    'extractor/community/x64/setup.exe',
    13972480,
    '5ca792c9e770fb7d02b82915ade5d4ebb706e57ce118f973bdcf1b67420b71ef',
  ],
  [
    'extractor/community/x64/wizard-manifest.json',
    324,
    '6442d32c405e4e6a03a4f59b9000e8e085c456e6c09510b927f6865a079f0c67',
  ],
  [
    'extractor/community/arm64/setup.exe',
    12586496,
    '2506d61290b72fe459543f7e338aed57ba5a3c692758e5ab203b106b1abe43fc',
  ],
  [
    'extractor/community/arm64/wizard-manifest.json',
    326,
    'b8db208a11bbb82726ca29058c1e4006911bb94e8e0d0de69aa00bdba0dd0406',
  ],
  [
    'uninstallers/concept/x64/uninstall.exe',
    9576960,
    '03a68f760a12332bce046190d2da98ea9830bb47a81df193ac3802434d23349b',
  ],
  [
    'uninstallers/concept/x64/uninstall-manifest.json',
    321,
    '52284fdf85e6196617f5c76ddb7b6db802302f2aeceef7407fb05d5cdbdf3922',
  ],
  [
    'uninstallers/concept/x64/product-edition.json',
    27,
    'a40d9494581dc4f530367d14a8de28de1f459dfd945c510cb188df42f6e6c752',
  ],
  [
    'uninstallers/concept/arm64/uninstall.exe',
    8637440,
    '0bfd1138afebb3eb427ce798c8a083098c97d33d6a6f527d27226dc942048f0f',
  ],
  [
    'uninstallers/concept/arm64/uninstall-manifest.json',
    323,
    'e4b2bf081a0fe705db13aead02fa9a43dab5f6a054eededadfbb6d9d6dedfef8',
  ],
  [
    'uninstallers/concept/arm64/product-edition.json',
    27,
    'a40d9494581dc4f530367d14a8de28de1f459dfd945c510cb188df42f6e6c752',
  ],
  [
    'uninstallers/community/x64/uninstall.exe',
    9576960,
    '2af4b7f0450356ead214a560a97266ca9ac663454c363eaf9060f1aabb8ae908',
  ],
  [
    'uninstallers/community/x64/uninstall-manifest.json',
    323,
    '20abc29ee8fa21019636d2bf66c225c2afbe3af2c71c734073bd75512df0d9ab',
  ],
  [
    'uninstallers/community/x64/product-edition.json',
    29,
    'd71fd200816f188f80853192e8261c3df04ef476e018d94a0e6bf5e8f61d2189',
  ],
  [
    'uninstallers/community/arm64/uninstall.exe',
    8637440,
    'd42011925cc1031dd20b729e9dfe4a872865a1800800d80eebda12948b112f68',
  ],
  [
    'uninstallers/community/arm64/uninstall-manifest.json',
    325,
    '23068ad405025a6ae189c8507f343b2b84d7c8f3ff96c9a354b0c09092695c38',
  ],
  [
    'uninstallers/community/arm64/product-edition.json',
    29,
    'd71fd200816f188f80853192e8261c3df04ef476e018d94a0e6bf5e8f61d2189',
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
