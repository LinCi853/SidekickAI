import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportOfflineBackup } from './offline.js'
import { exportTreeDigest } from './files.js'
import { decryptFileStream, isSabkEncrypted } from './file-crypto.js'
import { readStreamingArchive } from './stream-archive.js'
import { safeBackupPath } from './format.js'
import {
  assertOrdinaryPath,
  checkDiskSpace,
  createPrivateDirectory,
  hashFile,
  isWithin,
  samePath,
} from './io.js'
import type { BackupEdition, BackupManifest, BackupOptions } from './types.js'

export const INPUT_LIMIT = 8 * 1024 * 1024
export const OUTPUT_LIMIT = 16 * 1024 * 1024
export const operations = ['describe', 'export', 'verify', 'decrypt', 'restore'] as const
export const formats = [
  { id: 'zip', extension: 'zip', encrypted: false, label: 'ZIP' },
  { id: 'sabackup', extension: 'sabackup', encrypted: true, label: '加密备份' },
]
export const options = [
  { id: 'basicData', label: '基础数据', required: true, default: true },
  { id: 'cookies', label: '登录状态', required: false, default: true },
  { id: 'indexedDB', label: '离线网页数据', required: false, default: true },
  { id: 'cache', label: '缓存', required: false, default: false },
]
export interface ComponentIdentity {
  productId: string
  edition: BackupEdition
  productVersion: string
  architecture: 'x64' | 'arm64'
}
export function componentMetadata(identity: ComponentIdentity) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    ...identity,
    executable: 'node.exe',
    arguments: ['backup-component.cjs'],
    operations,
    formats,
    options,
  }
}
interface Request extends Omit<ComponentIdentity, 'architecture'> {
  protocolVersion: 1
  requestId: string
  operation: (typeof operations)[number]
  sourceRoot?: string
  targetPath?: string
  inputPath?: string
  format?: string
  categories?: string[]
  tempRoot?: string
  jobId?: string
  password?: string
  exportReceipt?: Record<string, unknown>
}
export interface ComponentResponse {
  protocolVersion: 1
  requestId: string
  operation: string
  success: boolean
  status: 'completed' | 'failed'
  result?: unknown
  error?: {
    code: string
    reason: string
    nextStep: string
    retryable: boolean
  }
}
class ProtocolError extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason)
  }
}
function reject(reason: string): never {
  throw new ProtocolError('INPUT_INVALID', reason)
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('请求必须是 JSON 对象。')
  return raw as Record<string, unknown>
}
function text(value: unknown, label: string, max = 32768): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > max)
    reject(`${label} 无效。`)
  return value
}
function absolute(value: unknown, label: string): string {
  const result = text(value, label)
  if (!path.isAbsolute(result)) reject(`${label} 必须是绝对路径。`)
  return path.resolve(result)
}
const common = [
  'protocolVersion',
  'requestId',
  'operation',
  'productId',
  'edition',
  'productVersion',
]
const fields: Record<string, string[]> = {
  describe: [],
  export: ['sourceRoot', 'targetPath', 'format', 'categories', 'tempRoot', 'jobId', 'password'],
  verify: [
    'inputPath',
    'format',
    'categories',
    'sourceRoot',
    'tempRoot',
    'password',
    'exportReceipt',
  ],
  decrypt: ['inputPath', 'targetPath', 'tempRoot', 'password'],
  restore: ['inputPath', 'targetPath', 'tempRoot', 'password'],
}
function selection(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((id) => typeof id !== 'string' || !options.some((item) => item.id === id)) ||
    new Set(value).size !== value.length ||
    !value.includes('basicData')
  )
    reject('备份选项无效，必须包含基础数据。')
  return options.filter((item) => value.includes(item.id)).map((item) => item.id)
}
function parseRequest(raw: unknown, identity: ComponentIdentity): Request {
  const value = object(raw)
  if (value.protocolVersion !== 1) reject('不支持的备份协议版本。')
  text(value.requestId, 'requestId', 128)
  if (typeof value.operation !== 'string' || !Object.hasOwn(fields, value.operation))
    reject('不支持的备份操作。')
  if (
    Object.keys(value).some(
      (key) => ![...common, ...fields[value.operation as string]].includes(key),
    )
  )
    reject('请求包含未知字段。')
  if (
    value.productId !== identity.productId ||
    value.edition !== identity.edition ||
    value.productVersion !== identity.productVersion
  )
    reject('请求与备份组件的产品、版别或版本不匹配。')
  const request = value as unknown as Request
  for (const key of ['sourceRoot', 'targetPath', 'inputPath', 'tempRoot'] as const)
    if (value[key] !== undefined) absolute(value[key], key)
  if (value.password !== undefined) text(value.password, 'password', 65536)
  if (
    value.jobId !== undefined &&
    (typeof value.jobId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.jobId))
  )
    reject('jobId 无效。')
  if (value.categories !== undefined) selection(value.categories)
  if (value.format !== undefined && !formats.some((item) => item.id === value.format))
    reject('不支持的备份格式。')
  if (request.operation === 'export') {
    absolute(value.sourceRoot, 'sourceRoot')
    absolute(value.targetPath, 'targetPath')
    if (!value.format) reject('缺少备份格式。')
    if (value.format === 'sabackup' && !value.password) reject('加密备份需要密码。')
    if (value.format === 'zip' && value.password !== undefined) reject('ZIP 格式不能携带加密密码。')
  } else if (request.operation !== 'describe') {
    absolute(value.inputPath, 'inputPath')
    if (['decrypt', 'restore'].includes(request.operation)) absolute(value.targetPath, 'targetPath')
    if (value.exportReceipt !== undefined) object(value.exportReceipt)
  }
  return request
}
const proofKeys = [
  'filePath',
  'sourceRoot',
  'sourceEntries',
  'skippedFiles',
  'categories',
  'format',
  'strict',
  'treeAlgorithm',
  'treeSha256',
  'artifactSha256',
  'artifactSize',
  'entryCount',
  'validation',
]
function equalEntries(left: Record<string, unknown>, right: Record<string, string>): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([name, hash]) =>
        safeBackupPath(name) &&
        typeof hash === 'string' &&
        /^[a-f0-9]{64}$/.test(hash) &&
        right[name] === hash,
    )
  )
}
function validateProof(raw: unknown): Record<string, unknown> {
  const proof = object(raw)
  if (
    Object.keys(proof).length !== proofKeys.length ||
    proofKeys.some((key) => !Object.hasOwn(proof, key)) ||
    proof.strict !== true ||
    proof.validation !== 'strict-export-v1' ||
    proof.treeAlgorithm !== 'export-tree-digest-v1' ||
    !Array.isArray(proof.skippedFiles) ||
    proof.skippedFiles.length ||
    !/^[a-f0-9]{64}$/.test(String(proof.treeSha256)) ||
    !/^[a-f0-9]{64}$/.test(String(proof.artifactSha256)) ||
    !Number.isSafeInteger(proof.artifactSize) ||
    Number(proof.artifactSize) <= 0 ||
    !Number.isSafeInteger(proof.entryCount) ||
    Number(proof.entryCount) <= 0
  )
    reject('严格导出凭据无效。')
  absolute(proof.filePath, 'filePath')
  absolute(proof.sourceRoot, 'sourceRoot')
  selection(proof.categories)
  object(proof.sourceEntries)
  if (!formats.some((item) => item.id === proof.format)) reject('凭据备份格式无效。')
  return proof
}
function assertSource(root: string, identity: ComponentIdentity) {
  assertOrdinaryPath(root, true)
  const file = path.join(root, 'edition-identity.json')
  if (fs.existsSync(file)) {
    assertOrdinaryPath(file)
    if (fs.statSync(file).size > 65536) reject('资料身份文件过大。')
    const declared = JSON.parse(fs.readFileSync(file, 'utf8'))
    const expected = identity.edition === 'concept' ? 'sidekickai-opensource' : 'sidekick-ai'
    if (declared.schema !== 1 || declared.edition !== expected) reject('资料目录属于其他产品版别。')
  }
}
async function inspect(request: Request, identity: ComponentIdentity, extractTo?: string) {
  const file = absolute(request.inputPath, 'inputPath')
  assertOrdinaryPath(file)
  const before = await hashFile(file)
  const size = fs.statSync(file).size
  const encrypted = isSabkEncrypted(file)
  const format = encrypted ? 'sabackup' : 'zip'
  if (request.format !== undefined && request.format !== format) reject('备份格式与请求不匹配。')
  let directory: string | undefined
  try {
    let input = file
    if (encrypted) {
      if (!request.password) reject('加密备份需要密码。')
      const temporary = request.tempRoot ?? os.tmpdir()
      fs.mkdirSync(temporary, { recursive: true, mode: 0o700 })
      assertOrdinaryPath(temporary, true)
      directory = fs.mkdtempSync(path.join(temporary, 'host-backup-decrypt-'))
      createPrivateDirectory(directory)
      checkDiskSpace([{ path: directory, bytes: size, purpose: '备份解密' }])
      input = path.join(directory, 'archive.zip')
      if ((await decryptFileStream(file, input, request.password)) === null)
        throw new ProtocolError('BACKUP_INVALID', '密码错误或加密备份已损坏。')
    } else if (request.password !== undefined) reject('未加密备份不能携带密码。')
    const manifest = await readStreamingArchive(input, {
      allowLegacy: !request.exportReceipt,
      extractTo,
    })
    if (manifest.edition && manifest.edition !== identity.edition) reject('备份属于其他产品版别。')
    if (fs.statSync(file).size !== size || (await hashFile(file)) !== before)
      throw new ProtocolError('BACKUP_INVALID', '验证期间备份文件发生变化。')
    return {
      manifest,
      input,
      directory,
      result: {
        filePath: file,
        artifactSha256: before,
        artifactSize: size,
        entryCount: Object.keys(manifest.entries).length,
        format,
        validation: 'archive-v1',
      },
    }
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
async function bindProof(
  proof: Record<string, unknown>,
  manifest: BackupManifest,
  artifact: {
    filePath: string
    artifactSha256: string
    artifactSize: number
    entryCount: number
    format: string
  },
  request: Request,
  identity: ComponentIdentity,
) {
  const categories = selection(proof.categories)
  if (
    !samePath(String(proof.filePath), artifact.filePath) ||
    proof.artifactSha256 !== artifact.artifactSha256 ||
    proof.artifactSize !== artifact.artifactSize ||
    proof.entryCount !== artifact.entryCount ||
    proof.format !== artifact.format ||
    manifest.edition !== identity.edition ||
    manifest.appVersion !== identity.productVersion ||
    !equalEntries(object(proof.sourceEntries), manifest.entries) ||
    options.some(
      (item) => manifest.options[item.id as keyof BackupOptions] !== categories.includes(item.id),
    ) ||
    (request.categories !== undefined &&
      JSON.stringify(selection(request.categories)) !== JSON.stringify(categories)) ||
    (request.sourceRoot !== undefined && !samePath(request.sourceRoot, String(proof.sourceRoot)))
  )
    throw new ProtocolError('BACKUP_BINDING_INVALID', '备份与严格导出凭据不匹配。')
  const root = absolute(proof.sourceRoot, 'sourceRoot')
  assertSource(root, identity)
  if (exportTreeDigest(root) !== proof.treeSha256)
    throw new ProtocolError('SOURCE_CHANGED', '导出后源资料已变化，请重新导出。')
  for (const [name, hash] of Object.entries(manifest.entries)) {
    const source = path.resolve(root, name)
    if (!isWithin(root, source) || samePath(root, source) || !fs.existsSync(source))
      throw new ProtocolError('SOURCE_CHANGED', '源文件已变化，请重新导出。')
    assertOrdinaryPath(source)
    if ((await hashFile(source)) !== hash)
      throw new ProtocolError('SOURCE_CHANGED', '源文件与备份内容不匹配，请重新导出。')
  }
  if (exportTreeDigest(root) !== proof.treeSha256)
    throw new ProtocolError('SOURCE_CHANGED', '验证期间源资料已变化，请重新导出。')
}
async function execute(request: Request, identity: ComponentIdentity): Promise<unknown> {
  if (request.operation === 'describe') return componentMetadata(identity)
  if (request.operation === 'export') {
    const root = absolute(request.sourceRoot, 'sourceRoot')
    const target = absolute(request.targetPath, 'targetPath')
    assertSource(root, identity)
    if (
      isWithin(root, target) ||
      samePath(root, target) ||
      (request.tempRoot && (isWithin(root, request.tempRoot) || samePath(root, request.tempRoot)))
    )
      reject('备份目标和暂存目录必须位于源资料目录之外。')
    const categories = request.categories
      ? selection(request.categories)
      : options.filter((item) => item.default).map((item) => item.id)
    const result = await exportOfflineBackup({
      sourceRoot: root,
      targetPath: target,
      edition: identity.edition,
      version: identity.productVersion,
      options: Object.fromEntries(
        options.map((item) => [item.id, categories.includes(item.id)]),
      ) as unknown as BackupOptions,
      password: request.password,
      tempRoot: request.tempRoot,
      jobId: request.jobId,
      strict: true,
    })
    if (!result.success || !result.treeSha256 || !result.sourceEntries)
      throw new ProtocolError(
        'BACKUP_FAILED',
        '严格导出未完成，源资料与暂存任务已保留，请检查空间、权限和文件占用后重试。',
      )
    const proof = {
      filePath: target,
      sourceRoot: root,
      sourceEntries: result.sourceEntries,
      skippedFiles: [],
      categories,
      format: request.format!,
      strict: true,
      treeAlgorithm: 'export-tree-digest-v1',
      treeSha256: result.treeSha256,
      artifactSha256: await hashFile(target),
      artifactSize: fs.statSync(target).size,
      entryCount: Object.keys(result.sourceEntries).length,
      validation: 'strict-export-v1',
    }
    return execute(
      {
        ...request,
        operation: 'verify',
        inputPath: target,
        exportReceipt: proof,
      },
      identity,
    )
  }
  const proof =
    request.exportReceipt === undefined ? undefined : validateProof(request.exportReceipt)
  let staging: string | undefined
  if (request.operation === 'restore') {
    const target = absolute(request.targetPath, 'targetPath')
    if (fs.existsSync(target)) reject('恢复仅允许使用尚不存在的新目录。')
    assertOrdinaryPath(path.dirname(target), true)
    staging = fs.mkdtempSync(path.join(path.dirname(target), '.host-backup-restore-'))
    createPrivateDirectory(staging)
  }
  let inspected: Awaited<ReturnType<typeof inspect>> | undefined
  try {
    inspected = await inspect(request, identity, staging)
    if (proof) {
      await bindProof(proof, inspected.manifest, inspected.result, request, identity)
      return proof
    }
    if (request.operation === 'decrypt') {
      if (inspected.result.format !== 'sabackup') reject('输入不是加密备份。')
      const target = absolute(request.targetPath, 'targetPath')
      assertOrdinaryPath(path.dirname(target), true)
      checkDiskSpace([
        {
          path: path.dirname(target),
          bytes: fs.statSync(inspected.input).size,
          purpose: '解密目标',
        },
      ])
      fs.copyFileSync(inspected.input, target, fs.constants.COPYFILE_EXCL)
      return {
        ...inspected.result,
        targetPath: target,
        targetSha256: await hashFile(target),
        targetSize: fs.statSync(target).size,
      }
    }
    if (staging) {
      const target = absolute(request.targetPath, 'targetPath')
      if (fs.existsSync(target)) reject('恢复目标已存在。')
      fs.renameSync(staging, target)
      staging = undefined
      return { ...inspected.result, targetPath: target }
    }
    return inspected.result
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    if (inspected?.directory) fs.rmSync(inspected.directory, { recursive: true, force: true })
  }
}
function failure(requestId: string, operation: string, error: unknown): ComponentResponse {
  return {
    protocolVersion: 1,
    requestId,
    operation,
    success: false,
    status: 'failed',
    error: {
      code: error instanceof ProtocolError ? error.code : 'BACKUP_FAILED',
      reason: error instanceof ProtocolError ? error.message : '备份操作未完成，源资料已保留。',
      nextStep: '请检查请求、密码、目标空间和文件占用后重试。',
      retryable: false,
    },
  }
}
export function encodeResponse(response: ComponentResponse): string {
  const output = JSON.stringify(response)
  if (Buffer.byteLength(output) + 1 > OUTPUT_LIMIT)
    return JSON.stringify(
      failure(
        response.requestId,
        response.operation,
        new ProtocolError('OUTPUT_TOO_LARGE', '备份凭据超过协议大小限制，请缩小导出范围。'),
      ),
    )
  return output
}
export async function runBackupComponent(
  input: AsyncIterable<Uint8Array | string>,
  identity: ComponentIdentity,
): Promise<ComponentResponse> {
  let requestId = ''
  let operation = ''
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > INPUT_LIMIT) reject('请求超过 8 MiB 限制。')
      chunks.push(buffer)
    }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch {
      reject('请求不是有效的 UTF-8 JSON。')
    }
    const value = object(raw)
    if (typeof value.requestId === 'string' && Buffer.byteLength(value.requestId) <= 128)
      requestId = value.requestId
    if (typeof value.operation === 'string' && Buffer.byteLength(value.operation) <= 64)
      operation = value.operation
    const request = parseRequest(value, identity)
    const result = await execute(request, identity)
    return JSON.parse(
      encodeResponse({
        protocolVersion: 1,
        requestId,
        operation,
        success: true,
        status: 'completed',
        result,
      }),
    ) as ComponentResponse
  } catch (error) {
    return failure(requestId, operation, error)
  }
}
