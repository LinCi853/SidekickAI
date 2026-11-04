'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const toolkitApi = require('./distribution-toolkit.cjs')
const payloadApi = require('./application-payload.cjs')
const runtime = require('./application-runtime.cjs')
const { KEY_ID_PATTERN, KEY_ID_MESSAGE, isKeyId } = require('./key-id.cjs')
const u = require('./build-utils.cjs')
const MAX_RESULT_BYTES = 4 * 1024 * 1024
const MAX_APPLICATION_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_CONFIGURATION_BYTES = 32 * 1024
const CONFIGURATION_PATH = 'inputs/installation-configuration.json'
const PRODUCT_PATH = 'inputs/product-descriptor.json'
const PRODUCT_CONTRACT_PATH = 'packages/product-contract/manifest.json'
const PRODUCT_FIELDS = [
  'productId',
  'purposePrefix',
  'name',
  'displayName',
  'executable',
  'identityCarrier',
  'icon',
  'capabilities',
  'dataProbe',
  'appExportHook',
]
const EDITION_FIELDS = [
  'label',
  'packageName',
  'directory',
  'legacyDirectories',
  'registryKey',
  'dataDirectories',
  'legacyExecutable',
  'cloudResources',
  'packageKinds',
  'requiredFiles',
]
// Official identities derive their domain from the shared key id rule.
const OFFICIAL_AUTHORITY_PATTERN = new RegExp(
  '^official:' + KEY_ID_PATTERN.source.slice(1, -1) + '$',
)

function readProductContract(root) {
  const file = path.join(root, ...PRODUCT_CONTRACT_PATH.split('/'))
  u.assertFile(file)
  if (fs.statSync(file).size > MAX_APPLICATION_MANIFEST_BYTES)
    throw new Error('Product contract exceeds its size limit')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// The toolkit has its own product identity; only the fields that contract defines may be
// submitted. The projected descriptor is kept as evidence even though 0.1.7 consumes the
// manifest instead of a separate descriptor document.
function projectProduct(document, contract, edition) {
  const projected = { schemaVersion: document.schemaVersion }
  for (const field of PRODUCT_FIELDS) {
    if (!Object.hasOwn(contract, field)) continue
    projected[field] = Object.hasOwn(document, field)
      ? document[field]
      : structuredClone(contract[field])
  }
  // The public contract predates 0.1.7 and does not carry every lifecycle identity field;
  // these remain part of the product descriptor and are projected verbatim.
  for (const field of ['productId', 'identityCarrier', 'icon', 'executable', 'displayName']) {
    if (Object.hasOwn(document, field) && !Object.hasOwn(projected, field))
      projected[field] = structuredClone(document[field])
  }
  if (!contract.editions?.[edition] || !document.editions?.[edition])
    throw new Error('Product descriptor lacks the assembled edition')
  const editions = {}
  for (const [name, contractEdition] of Object.entries(contract.editions)) {
    const documentEdition = document.editions?.[name] || {}
    const projectedEdition = {}
    for (const field of EDITION_FIELDS) {
      if (Object.hasOwn(documentEdition, field)) projectedEdition[field] = documentEdition[field]
      else if (Object.hasOwn(contractEdition, field))
        projectedEdition[field] = structuredClone(contractEdition[field])
    }
    editions[name] = projectedEdition
  }
  projected.editions = editions
  return projected
}

function readProductDescriptor(root) {
  const file = path.join(root, 'contracts/distribution-product.json')
  if (!fs.existsSync(file)) return null
  u.assertFile(file)
  const raw = fs.readFileSync(file)
  if (!raw.length || raw.length > 32 * 1024)
    throw new Error('Product descriptor exceeds its size limit')
  const document = JSON.parse(raw.toString('utf8'))
  if (
    document.schemaVersion !== 1 ||
    document.productId !== 'sidekickai' ||
    !document.editions?.concept ||
    document.icon !== 'resources/product-icon.ico' ||
    (document.backupComponent !== undefined &&
      document.backupComponent !== 'resources/host-backup/component.json')
  )
    throw new Error('Invalid application distribution product')
  const descriptor = projectProduct(document, readProductContract(root), 'concept')
  return {
    document: descriptor,
    sha256: u.hash(runtime.canonicalJson(descriptor)),
    originalSha256: u.hash(raw),
    publisher: document.publisher,
  }
}

function assertProductUnchanged(product, root) {
  const current = readProductDescriptor(root)
  if (current?.originalSha256 !== product?.originalSha256)
    throw new Error('Product descriptor changed during assembly')
}

function readInstallationConfiguration(root) {
  const file = path.join(root, 'contracts/installation-configuration.json')
  if (!fs.existsSync(file)) return null
  u.assertFile(file)
  const raw = fs.readFileSync(file)
  if (raw.length > MAX_CONFIGURATION_BYTES)
    throw new Error('Installation configuration exceeds its size limit')
  const value = JSON.parse(raw.toString('utf8'))
  toolkitApi.fields(value, ['schemaVersion', 'edition', 'options'])
  if (
    value.schemaVersion !== 1 ||
    value.edition !== 'concept' ||
    !value.options ||
    Array.isArray(value.options) ||
    typeof value.options !== 'object' ||
    Object.entries(value.options).some(
      ([key, selected]) =>
        !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
        (typeof selected !== 'boolean' && (typeof selected !== 'string' || selected.length > 128)),
    )
  ) {
    throw new Error('Invalid installation configuration')
  }
  const bytes = Buffer.from(runtime.canonicalJson(value) + '\n')
  return {
    file,
    value,
    bytes,
    sha256: u.hash(bytes),
    originalSha256: u.hash(raw),
  }
}

function assertConfigurationUnchanged(configuration, root, product) {
  if (!configuration) return
  u.assertFile(configuration.file)
  if (u.sha256(configuration.file) !== configuration.originalSha256)
    throw new Error('Installation configuration changed during assembly')
  const current = readProductDescriptor(root)
  if (current?.originalSha256 !== product?.originalSha256)
    throw new Error('Product descriptor changed during assembly')
}

function parseOutput(stdout) {
  const text = (stdout || '').trim()
  if (!text) throw new Error('生命周期工具没有输出结果。')
  try {
    return JSON.parse(text)
  } catch {
    const last = text.split(/\r?\n/).at(-1)
    try {
      return JSON.parse(last)
    } catch {
      throw new Error('生命周期工具没有返回有效的 JSON 结果。')
    }
  }
}

function invoke(toolkit, args, options = {}) {
  toolkitApi.assertUnchanged(toolkit)
  const run = (options.spawn || spawnSync)(
    path.join(toolkit.directory, ...toolkit.executable.split('/')),
    args,
    {
      cwd: toolkit.directory,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout || 20 * 60 * 1000,
    },
  )
  toolkitApi.assertUnchanged(toolkit)
  if (run.error || run.status !== 0)
    throw new Error(
      '生命周期工具执行失败：' +
        (run.error?.message || run.stderr?.trim() || run.status || 'unknown'),
    )
  return parseOutput(run.stdout)
}

// A publication key set may hold several official keys for different publishers or product
// lines. Selection never assumes a literal id: an explicit keyId (caller option or the set's
// own designation) wins, a single usable key is accepted as-is, and otherwise one unique
// active key must exist. The selected id still forms the official:<keyId> domain.
function selectAdminKey(document, preferredKeyId) {
  const entries = Array.isArray(document.adminKeys) ? document.adminKeys : []
  const usable = entries.filter(
    (entry) =>
      entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.privateKey,
  )
  const requested =
    preferredKeyId ?? document.activeAdminKeyId ?? document.adminKeyId ?? document.keyId
  if (requested !== undefined) {
    if (!isKeyId(requested)) throw new Error(KEY_ID_MESSAGE)
    const matched = usable.find((entry) => entry.id === requested)
    if (!matched) throw new Error('官方密钥文件缺少 ' + requested + '。')
    return matched
  }
  if (usable.length === 1) return usable[0]
  const active = usable.filter((entry) => entry.active === true)
  if (usable.length > 1 && active.length === 1) return active[0]
  if (usable.length === 0) throw new Error('官方密钥文件不含可用的 admin 私钥。')
  throw new Error(
    '官方密钥文件包含多把 admin 钥，请指定 keyId。可用 id: ' +
      usable.map((entry) => entry.id).join(', '),
  )
}

function keyIdOf(value, preferredKeyId) {
  let document
  try {
    document = JSON.parse(fs.readFileSync(value, 'utf8'))
  } catch {
    throw new Error('官方密钥文件不是有效的 JSON。')
  }
  // The publication key set stores admin keys with JWK material; a toolkit key file stores
  // one key directly. Both are accepted without ever writing the material to build output.
  if (Array.isArray(document.adminKeys)) {
    const matched = selectAdminKey(document, preferredKeyId)
    return {
      keyId: matched.id,
      privateKey: matched.privateKey,
    }
  }
  if (
    document.schemaVersion !== 1 ||
    !document.privateKey ||
    typeof document.privateKey !== 'object'
  )
    throw new Error('官方密钥文件格式不受支持。')
  if (!isKeyId(document.keyId)) throw new Error(KEY_ID_MESSAGE)
  return { keyId: document.keyId, privateKey: document.privateKey }
}

function isOfficialAuthority(value) {
  return typeof value === 'string' && OFFICIAL_AUTHORITY_PATTERN.test(value)
}

function readSigningIdentity(keyFile, product, preferredKeyId) {
  if (!keyFile) return null
  const absolute = path.resolve(keyFile)
  u.assertFile(absolute)
  const selected = keyIdOf(absolute, preferredKeyId)
  let privateObject
  try {
    privateObject = crypto.createPrivateKey({
      key: selected.privateKey,
      format: 'jwk',
    })
  } catch {
    throw new Error('官方密钥文件缺少可用的私钥。')
  }
  const publicKey = crypto.createPublicKey(privateObject).export({ format: 'jwk' })
  const supported =
    (publicKey.kty === 'OKP' && publicKey.crv === 'Ed25519') ||
    (publicKey.kty === 'EC' && publicKey.crv === 'P-256')
  if (!supported || typeof publicKey.x !== 'string')
    throw new Error('官方密钥不是受支持的 Ed25519 或 P-256 公钥。')
  return {
    keyId: selected.keyId,
    privateKey: selected.privateKey,
    publicKey: {
      kty: publicKey.kty,
      crv: publicKey.crv,
      x: publicKey.x,
      ...(publicKey.y ? { y: publicKey.y } : {}),
    },
    fingerprint: u.hash(runtime.canonicalJson({ id: selected.keyId, publicKey: publicKey.x })),
    publisher: product?.publisher || 'LinCi853',
    authority: 'official:' + selected.keyId,
  }
}

function withKeyFile(identity, callback) {
  if (!identity) return callback(null)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekickai-toolkit-key-'))
  const file = path.join(directory, 'key.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      keyId: identity.keyId,
      publisher: identity.publisher,
      privateKey: identity.privateKey,
    }),
    { mode: 0o600, flag: 'wx' },
  )
  try {
    return callback(file)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function preflight({ root, toolkitOptions = {}, invokeOptions = {} }) {
  if ((toolkitOptions.platform || process.platform) !== 'win32')
    throw new Error('完整安装包构建需要 Windows 生命週期工具。')
  const toolkit = await toolkitApi.prepareToolkit(root, toolkitOptions)
  readInstallationConfiguration(root)
  readProductDescriptor(root)
  return toolkit
}

function inputIdentity(payloads, edition, productVersion) {
  if (!Array.isArray(payloads) || edition !== 'concept')
    throw new Error('Self-built assembly requires concept application payloads')
  const architectures = require('./application-packaging.cjs').validateArchitectures(
    payloads.map((value) => value.architecture),
  )
  const inputs = {},
    manifests = {},
    files = [],
    expected = new Map()
  for (const arch of architectures) {
    const matches = payloads.filter((value) => value.architecture === arch)
    if (matches.length !== 1)
      throw new Error('Self-built assembly requires one payload per architecture')
    const item = matches[0]
    u.assertFile(item.manifestPath)
    if (fs.statSync(item.manifestPath).size > MAX_APPLICATION_MANIFEST_BYTES)
      throw new Error('Application manifest exceeds its size limit')
    const manifestBytes = fs.readFileSync(item.manifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    payloadApi.verifyApplicationPayload(item.path, manifest)
    if (
      manifest.edition !== edition ||
      manifest.productVersion !== productVersion ||
      manifest.architecture !== arch
    )
      throw new Error('Assembly input identity does not match the application workspace')
    manifests[arch] = path.resolve(item.manifestPath)
    inputs[arch] = {
      manifestSha256: u.hash(manifestBytes),
      archiveSha256: manifest.archive.sha256,
    }
    files.push(path.resolve(item.manifestPath), path.resolve(item.path))
    expected.set(path.resolve(item.manifestPath), inputs[arch].manifestSha256)
    expected.set(path.resolve(item.path), inputs[arch].archiveSha256)
  }
  const base = path.dirname(files[0])
  const fingerprint = u.fingerprint(base, files)
  if (
    fingerprint.entries.some((file) => expected.get(path.resolve(base, file.path)) !== file.sha256)
  )
    throw new Error('Assembly inputs changed during validation')
  return { inputs, manifests, fingerprint, files }
}

function appManifest({ product, edition, productVersion, payload, payloadManifest, options }) {
  const contract = readProductContract(path.resolve(__dirname, '..'))
  const editionContract = contract.editions[edition]
  if (!editionContract) throw new Error('Product contract lacks the assembled edition')
  const descriptor = product.document
  const descriptorEdition = descriptor.editions?.[edition]
  if (!descriptorEdition) throw new Error('Product descriptor lacks the assembled edition')
  const licenseFile = path.join(__dirname, '..', 'LICENSE')
  const licenseBody = fs.existsSync(licenseFile) ? fs.readFileSync(licenseFile, 'utf8') : ''
  const installation = options.configuration
  const manifest = {
    schemaVersion: 1,
    app: {
      productId: descriptor.productId,
      edition,
      name: descriptor.displayName,
      publisher: product.publisher,
      icon: descriptor.icon,
      entry: descriptor.executable,
      identityCarrier: descriptor.identityCarrier,
      ...(descriptor.backupComponent ? { backupComponent: descriptor.backupComponent } : {}),
    },
    productVersion,
    payload: {
      packages: [
        {
          id: 'app-' + payload.architecture,
          architecture: payload.architecture,
          archive: payloadManifest.archive,
          files: payloadManifest.files,
          requiredFiles: descriptorEdition.requiredFiles,
        },
      ],
    },
    defaults: {
      directory: editionContract.directory,
      dataPolicy: 'keep',
      ...(installation ? { options: installation.options } : {}),
    },
  }
  if (options.contract.licenses?.length && licenseBody) {
    manifest.licenses = options.contract.licenses.map((license) => ({
      id: license.id,
      title: license.title,
      defaultOpen: license.defaultOpen,
      body: licenseBody,
    }))
  }
  if (options.contract.options?.length) {
    manifest.presentation = {
      features: (options.contract.features || []).map((feature) => ({
        id: feature.id,
        label: feature.label,
        description: feature.description,
      })),
      options: options.contract.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        ...(option.choices
          ? {
              choices: option.choices.map((choice) => ({
                value: choice.value,
                label: choice.label,
              })),
            }
          : {}),
      })),
    }
  }
  return manifest
}

function checkInstaller(file, expectedDomain, options = {}) {
  const run = (options.spawn || spawnSync)(file, ['--check'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180 * 1000,
  })
  const output = ((run.stdout || '') + '\n' + (run.stderr || '')).trim()
  if (run.error || run.status !== 0)
    throw new Error(
      '安装器自检失败：' +
        (run.error?.message || output.split(/\r?\n/).filter(Boolean).at(-1) || run.status),
    )
  if (!output.includes(expectedDomain))
    throw new Error('安装器自检未报告预期维护域 ' + expectedDomain)
  if (output.includes('PACKAGE_UNTRUSTED')) throw new Error('安装器自检报告 PACKAGE_UNTRUSTED')
  if (output.includes('[阻止]') || output.includes('阻塞'))
    throw new Error('安装器自检存在阻塞项：' + output)
  return { attempted: true, ok: true, domain: expectedDomain, exitCode: 0 }
}

function validateResult(result, toolkit, output, identity) {
  toolkitApi.fields(
    result,
    [
      'interfaceVersion',
      'toolkitVersion',
      'edition',
      'mode',
      'productVersion',
      'authority',
      'domain',
      'issuerKeyId',
      'issuerFingerprint',
      'inputs',
      'artifacts',
    ],
    [
      'schemaVersion',
      'publicIdentity',
      'installationConfigurationSha256',
      'productId',
      'productDescriptorSha256',
      'packages',
      'toolkit',
    ],
  )
  if (
    result.productId !== identity.productId ||
    result.productDescriptorSha256 !== identity.productDescriptorSha256
  ) {
    throw new Error('Assembled product descriptor does not match its requested identity')
  }
  if (
    result.interfaceVersion !== toolkitApi.INTERFACE_VERSION ||
    result.toolkitVersion !== toolkit.reference.toolkitVersion ||
    result.edition !== identity.edition ||
    result.mode !== 'offline' ||
    !(result.authority === 'self-built' || isOfficialAuthority(result.authority)) ||
    result.domain !== result.authority ||
    (result.issuerKeyId !== undefined && !isKeyId(result.issuerKeyId)) ||
    !toolkitApi.digest(result.issuerFingerprint) ||
    result.productVersion !== identity.productVersion ||
    runtime.canonicalJson(result.inputs) !== runtime.canonicalJson(identity.inputs)
  )
    throw new Error('Assembled installer identity does not match its requested inputs')
  if (
    result.installationConfigurationSha256 !== identity.installationConfigurationSha256 ||
    (result.installationConfigurationSha256 !== undefined &&
      !toolkitApi.digest(result.installationConfigurationSha256))
  ) {
    throw new Error('Assembled installation configuration does not match its requested defaults')
  }
  const architectures = require('./application-packaging.cjs').validateArchitectures(
    Object.keys(identity.inputs),
  )
  if (!Array.isArray(result.artifacts) || result.artifacts.length !== architectures.length)
    throw new Error('Assembly must produce the requested offline installers')
  const names = new Set()
  const installers = []
  for (const arch of architectures) {
    const matches = result.artifacts.filter(
      (file) => file.role === 'offline-installer' && file.architecture === arch,
    )
    if (matches.length !== 1)
      throw new Error('Assembly must produce one installer per architecture')
    const item = matches[0]
    toolkitApi.fields(item, ['path', 'role', 'architecture', 'size', 'sha256'], ['check'])
    runtime.validateRelativePath(item.path)
    if (
      path.isAbsolute(item.path) ||
      item.path.includes('/') ||
      !item.path.endsWith('.exe') ||
      names.has(item.path.toLowerCase()) ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      item.size > 2 * 1024 * 1024 * 1024 ||
      !toolkitApi.digest(item.sha256)
    )
      throw new Error('Invalid assembled installer inventory')
    names.add(item.path.toLowerCase())
    const file = path.join(output, ...item.path.split('/'))
    u.assertFile(file)
    if (
      fs.statSync(file).size !== item.size ||
      u.sha256(file) !== item.sha256 ||
      u.peInfo(fs.readFileSync(file)).arch !== arch
    ) {
      throw new Error('Assembled installer bytes do not match its result')
    }
    installers.push({
      architecture: arch,
      path: file,
      sha256: item.sha256,
      size: item.size,
      authority: result.authority,
    })
  }
  return installers
}

function retainedInputs(directory, input) {
  const files = []
  if (input.productDescriptorSha256 !== undefined) {
    const file = path.join(directory, ...PRODUCT_PATH.split('/'))
    u.assertFile(file)
    const bytes = fs.readFileSync(file)
    if (bytes.length > 32 * 1024)
      throw new Error('Retained product descriptor exceeds its size limit')
    const document = JSON.parse(bytes.toString('utf8'))
    if (
      document.productId !== input.productId ||
      u.hash(runtime.canonicalJson(document)) !== input.productDescriptorSha256 ||
      !bytes.equals(Buffer.from(runtime.canonicalJson(document) + '\n'))
    )
      throw new Error('Retained product descriptor differs from the request')
    files.push({
      path: PRODUCT_PATH,
      file,
      architecture: null,
      size: bytes.length,
      sha256: u.hash(bytes),
    })
  }
  for (const arch of require('./application-packaging.cjs').validateArchitectures(
    Object.keys(input.inputs),
  )) {
    const manifestPath = 'inputs/' + arch + '/application.manifest.json'
    const manifestFile = path.join(directory, ...manifestPath.split('/'))
    u.assertFile(manifestFile)
    if (fs.statSync(manifestFile).size > MAX_APPLICATION_MANIFEST_BYTES)
      throw new Error('Retained application manifest exceeds its size limit')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    payloadApi.validateManifest(manifest)
    const archivePath = 'inputs/' + arch + '/' + manifest.archive.file
    for (const [relative, sha256] of [
      [manifestPath, input.inputs[arch].manifestSha256],
      [archivePath, input.inputs[arch].archiveSha256],
    ]) {
      const file = path.join(directory, ...relative.split('/'))
      u.assertFile(file)
      if (u.sha256(file) !== sha256)
        throw new Error('Retained assembly inputs do not match the original payloads')
      files.push({
        path: relative,
        file,
        architecture: arch,
        size: fs.statSync(file).size,
        sha256,
      })
    }
  }
  if (input.installationConfigurationSha256 !== undefined) {
    const file = path.join(directory, ...CONFIGURATION_PATH.split('/'))
    u.assertFile(file)
    if (
      fs.statSync(file).size > MAX_CONFIGURATION_BYTES ||
      u.sha256(file) !== input.installationConfigurationSha256
    ) {
      throw new Error('Retained installation configuration does not match its requested defaults')
    }
    files.push({
      path: CONFIGURATION_PATH,
      file,
      architecture: null,
      size: fs.statSync(file).size,
      sha256: input.installationConfigurationSha256,
    })
  }
  return files
}

async function assemble({
  root,
  output,
  payloads,
  edition,
  productVersion,
  toolkit,
  toolkitOptions = {},
  invokeOptions = {},
  keyFile,
  keyId,
}) {
  toolkit ||= await preflight({ root, toolkitOptions, invokeOptions })
  const configuration = readInstallationConfiguration(root)
  const product = readProductDescriptor(root)
  if (!product) throw new Error('Installer assembly requires the concept product descriptor')
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, 'contracts/installation-contract.json'), 'utf8'),
  )
  const input = inputIdentity(payloads, edition, productVersion)
  const source = {
    edition,
    productVersion,
    inputs: input.inputs,
    productId: product.document.productId,
    productDescriptorSha256: product.sha256,
    ...(configuration ? { installationConfigurationSha256: configuration.sha256 } : {}),
  }
  const signing = readSigningIdentity(keyFile, product.document, keyId)
  const directory = path.resolve(output, 'installers')
  if (fs.existsSync(directory)) throw new Error('Installer assembly output already exists')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const manifestsDirectory = path.resolve(output, 'manifests')
  fs.mkdirSync(manifestsDirectory, { recursive: true })
  const expectedDomain = signing ? signing.authority : 'self-built'
  const toolkitRuns = { verify: [], assemble: [] }
  const artifacts = []
  const packages = {}
  const started = Date.now()
  try {
    for (const arch of require('./application-packaging.cjs').validateArchitectures(
      Object.keys(input.inputs),
    )) {
      const payload = payloads.find((entry) => entry.architecture === arch)
      const manifest = JSON.parse(fs.readFileSync(input.manifests[arch], 'utf8'))
      const applicationManifest = appManifest({
        product,
        edition,
        productVersion,
        payload,
        payloadManifest: manifest,
        options: { contract, configuration: configuration?.value },
      })
      const manifestFile = path.join(manifestsDirectory, arch + '.app.manifest.json')
      fs.writeFileSync(manifestFile, JSON.stringify(applicationManifest, null, 2) + '\n', {
        flag: 'wx',
      })
      const packageDirectory = path.resolve(output, 'packages', arch)
      if (fs.existsSync(packageDirectory))
        throw new Error('Installer package output already exists')
      withKeyFile(signing, (key) => {
        const args = [
          'build',
          '--manifest',
          manifestFile,
          '--payload-dir',
          path.dirname(path.resolve(payload.path)),
          '--out',
          packageDirectory,
          '--edition',
          edition,
          '--form',
          'offline',
        ]
        if (key) args.push('--key-file', key)
        console.log('[assembly] Building ' + arch + ' lifecycle package (' + expectedDomain + ')')
        const built = invoke(toolkit, args, invokeOptions)
        const verified = invoke(
          toolkit,
          [
            'verify-package-spec',
            '--package-dir',
            packageDirectory,
            ...(key ? ['--key-file', key] : []),
          ],
          invokeOptions,
        )
        if (verified.domain !== expectedDomain)
          throw new Error(
            'Package spec reported ' + verified.domain + ' instead of ' + expectedDomain,
          )
        toolkitRuns.verify.push({
          architecture: arch,
          domain: verified.domain,
          checks: verified.checks,
        })
        const setup = path.join(directory, installerName(productVersion, arch, expectedDomain))
        const assembled = invoke(
          toolkit,
          [
            'assemble',
            '--package-dir',
            packageDirectory,
            '--edition',
            edition,
            '--arch',
            arch,
            '--out',
            setup,
            ...(key ? ['--key-file', key] : []),
          ],
          invokeOptions,
        )
        if (
          path.resolve(assembled.outFile) !== setup ||
          assembled.domain !== expectedDomain ||
          !Array.isArray(assembled.architectures) ||
          !assembled.architectures.includes(arch)
        )
          throw new Error('Lifecycle assembly returned an unexpected installer identity')
        toolkitRuns.assemble.push({
          architecture: arch,
          domain: assembled.domain,
          outFile: setup,
        })
        u.assertFile(setup)
        if (
          fs.statSync(setup).size !== assembled.outputBytes ||
          u.sha256(setup) !== assembled.outputSha256
        )
          throw new Error('Lifecycle assembly output does not match its report')
        const hostArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
        const check =
          arch === hostArchitecture
            ? checkInstaller(setup, expectedDomain, invokeOptions)
            : {
                attempted: false,
                ok: false,
                domain: expectedDomain,
                reason: 'architecture-mismatch',
              }
        packages[arch] = {
          packageSha256: u.sha256(path.join(packageDirectory, 'lifecycle-package.json')),
          specDomain: verified.domain,
          buildOutput: built,
          manifestSha256: u.hash(fs.readFileSync(manifestFile)),
        }
        artifacts.push({
          path: path.basename(setup),
          role: 'offline-installer',
          architecture: arch,
          size: assembled.outputBytes,
          sha256: assembled.outputSha256,
          check,
        })
      })
    }
    assertProductUnchanged(product, root)
    assertConfigurationUnchanged(configuration, root, product)
    const result = {
      schemaVersion: 1,
      interfaceVersion: toolkitApi.INTERFACE_VERSION,
      toolkitVersion: toolkit.reference.toolkitVersion,
      edition,
      mode: 'offline',
      productVersion,
      authority: expectedDomain,
      domain: expectedDomain,
      issuerKeyId: signing?.keyId || 'self-built',
      issuerFingerprint:
        signing?.fingerprint ||
        u.hash(
          runtime.canonicalJson({
            id: 'self-built',
            productId: product.document.productId,
          }),
        ),
      ...(signing
        ? {
            publicIdentity: { id: signing.keyId, publicKey: signing.publicKey },
          }
        : {}),
      productId: product.document.productId,
      productDescriptorSha256: product.sha256,
      ...(configuration ? { installationConfigurationSha256: configuration.sha256 } : {}),
      inputs: input.inputs,
      packages,
      toolkit: {
        toolkitVersion: toolkit.reference.toolkitVersion,
        interfaceVersion: toolkitApi.INTERFACE_VERSION,
        inventorySha256: toolkit.inputs.fingerprint,
        extractor: Object.fromEntries(
          Object.keys(input.inputs).map((arch) => [
            arch,
            extractorEvidence(toolkit, edition, arch),
          ]),
        ),
        verifications: toolkitRuns.verify,
        assemblies: toolkitRuns.assemble,
        durationMs: Date.now() - started,
      },
      artifacts,
    }
    validateResult(result, toolkit, directory, source)
    const resultFile = path.join(directory, 'assembly-result.json')
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
    })
    const resultBytes = fs.readFileSync(resultFile)
    if (resultBytes.length > MAX_RESULT_BYTES)
      throw new Error('Assembly result exceeds its size limit')
    // Retained inputs are copied from their source workspace to the assembly output.
    for (const [relative, content] of [
      [PRODUCT_PATH, Buffer.from(runtime.canonicalJson(product.document) + '\n')],
      ...Object.keys(input.inputs).flatMap((arch) => [
        ['inputs/' + arch + '/application.manifest.json', fs.readFileSync(input.manifests[arch])],
        [
          'inputs/' +
            arch +
            '/' +
            JSON.parse(fs.readFileSync(input.manifests[arch], 'utf8')).archive.file,
          fs.readFileSync(payloads.find((entry) => entry.architecture === arch).path),
        ],
      ]),
      ...(configuration ? [[CONFIGURATION_PATH, configuration.bytes]] : []),
    ]) {
      const target = path.join(directory, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, { flag: 'wx' })
    }
    const retained = retainedInputs(directory, source)
    u.assertUnchanged(input.fingerprint, u.fingerprint(path.dirname(input.files[0]), input.files))
    assertProductUnchanged(product, root)
    assertConfigurationUnchanged(configuration, root, product)
    return {
      installers: validateResult(result, toolkit, directory, source),
      retainedInputs: retained,
      preparedToolkit: toolkit,
      result,
      resultFile,
      resultSha256: u.hash(resultBytes),
      toolkit: {
        toolkitVersion: toolkit.reference.toolkitVersion,
        interfaceVersion: toolkitApi.INTERFACE_VERSION,
        ...(toolkit.reference.archive.path
          ? { archivePath: toolkit.reference.archive.path }
          : { archiveUrl: toolkit.reference.archive.url }),
        archiveSize: toolkit.reference.archive.size,
        archiveSha256: toolkit.reference.archive.sha256,
        inventorySha256: toolkit.inputs.fingerprint,
        referenceSha256: toolkit.referenceSha256 || null,
        inputs: toolkit.inputs,
        authority: expectedDomain,
        issuerKeyId: signing?.keyId || 'self-built',
      },
    }
  } finally {
    // the temporary signing key is removed by withKeyFile; nothing else is persisted
  }
}

function extractorEvidence(toolkit, edition, arch) {
  const file = toolkitApi.componentPath(toolkit, 'extractor', edition, arch)
  return {
    path: path.relative(toolkit.directory, file).replaceAll('\\', '/'),
    size: fs.statSync(file).size,
    sha256: u.sha256(file),
  }
}

function installerName(productVersion, arch, domain) {
  return (
    'SidekickAI-Setup-' +
    productVersion +
    '-' +
    arch +
    '-' +
    (domain.startsWith('official:') ? 'official' : 'self-built') +
    '.exe'
  )
}

function verifyCollected(assembled, directory, options = {}, collection = null) {
  const resultFile = path.join(directory, 'assembly-result.json')
  if (u.sha256(resultFile) !== assembled.resultSha256)
    throw new Error('Collected assembly result does not match its verified source')
  const snapshot = () => u.fingerprint(directory, u.listFiles(directory, new Set()))
  const before = snapshot()
  if (collection?.collectionFingerprint) u.assertUnchanged(collection.collectionFingerprint, before)
  const source = {
    edition: assembled.result.edition,
    productVersion: assembled.result.productVersion,
    inputs: assembled.result.inputs,
    ...(assembled.result.productDescriptorSha256 !== undefined
      ? {
          productId: assembled.result.productId,
          productDescriptorSha256: assembled.result.productDescriptorSha256,
        }
      : {}),
    ...(assembled.result.installationConfigurationSha256 !== undefined
      ? {
          installationConfigurationSha256: assembled.result.installationConfigurationSha256,
        }
      : {}),
  }
  const installers = validateResult(assembled.result, assembled.preparedToolkit, directory, source)
  for (const installer of installers)
    checkInstaller(installer.path, assembled.result.domain, options)
  retainedInputs(directory, source)
  if (u.sha256(resultFile) !== assembled.resultSha256)
    throw new Error('Collected installer verification does not match its original result')
  u.assertUnchanged(before, snapshot())
  return assembled.result
}

module.exports = {
  invoke,
  preflight,
  inputIdentity,
  validateResult,
  retainedInputs,
  assemble,
  verifyCollected,
  checkInstaller,
  installerName,
  isOfficialAuthority,
}
