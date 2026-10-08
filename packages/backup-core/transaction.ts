import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { sha256FileSync } from './files.js'
import { assertOrdinaryPath, atomicJson, createPrivateDirectory, diskIdentity, identityMatches, type DiskIdentity } from './io.js'

interface RestoreRequest {
  version: 1
  token: string
  state: 'prepared' | 'installed' | 'rollback' | 'committed' | 'rolled-back'
  digest: string
  mode?: 'full' | 'limited'
  composed?: boolean
  sourceIdentity?: DiskIdentity
  stagedIdentity?: DiskIdentity
  backupDigest?: string
  failedDigest?: string
}
export interface RestoreOutcome { restored: boolean; backupPath?: string; error?: string }
function requestPath(root: string): string { return `${root}.restore.json` }
const validIdentity = (value: unknown): value is DiskIdentity => !!value && typeof value === 'object'
  && typeof (value as DiskIdentity).device === 'string' && typeof (value as DiskIdentity).inode === 'string'
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function readRequest(root: string): RestoreRequest | undefined {
  const file = requestPath(root)
  if (!fs.existsSync(file)) return undefined
  assertOrdinaryPath(file)
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RestoreRequest
  if (!value || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.token)
    || value.mode !== undefined && !['full', 'limited'].includes(value.mode)
    || value.composed !== undefined && typeof value.composed !== 'boolean'
    || value.sourceIdentity !== undefined && !validIdentity(value.sourceIdentity)
    || value.stagedIdentity !== undefined && !validIdentity(value.stagedIdentity)
    || value.backupDigest !== undefined && !validDigest(value.backupDigest)
    || value.failedDigest !== undefined && !validDigest(value.failedDigest)
    || !['prepared', 'installed', 'rollback', 'committed', 'rolled-back'].includes(value.state) || !validDigest(value.digest)) throw new Error('Invalid pending restore request.')
  return value
}
function writeRequest(root: string, request: RestoreRequest): void { atomicJson(requestPath(root), request) }

function treeDigest(directory: string): string {
  assertOrdinaryPath(directory, true)
  const hash = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), relative = `${prefix}${name}`, info = fs.lstatSync(file)
      if (info.isSymbolicLink()) throw new Error('Restore data contains a symbolic link.')
      if (info.isDirectory()) { hash.update(JSON.stringify([relative, 'directory'])); walk(file, `${relative}/`) }
      else if (info.isFile()) hash.update(JSON.stringify([relative, info.size, sha256FileSync(file)]))
      else throw new Error('Restore data contains a special file.')
    }
  }
  walk(directory, '')
  return hash.digest('hex')
}
function verifyTree(directory: string, identity: DiskIdentity | undefined, digest: string | undefined): void {
  assertOrdinaryPath(directory, true)
  if (!identity || !digest || !identityMatches(identity, diskIdentity(directory)) || treeDigest(directory) !== digest) {
    throw new Error('Application restore identity or integrity verification failed. Existing directories were preserved.')
  }
}
function removeVerifiedTree(directory: string, identity: DiskIdentity | undefined, digest: string | undefined): void {
  if (!fs.existsSync(directory)) return
  verifyTree(directory, identity, digest)
  fs.rmSync(directory, { recursive: true, maxRetries: 2, retryDelay: 50 })
}

export function prepareRestoreDirectory(root: string): string {
  if (fs.existsSync(requestPath(root)) || fs.existsSync(`${root}.reset.json`)) throw new Error('An application data operation is already pending.')
  const directory = `${root}.restore-${randomUUID()}`
  createPrivateDirectory(directory)
  return directory
}
export function queuePreparedRestore(root: string, staged: string, mode: 'full' | 'limited' = 'full'): void {
  if (fs.existsSync(requestPath(root))) throw new Error('An application data restore is already pending.')
  const token = staged.slice(`${root}.restore-`.length)
  if (staged !== `${root}.restore-${token}` || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid restore staging path.')
  assertOrdinaryPath(root, true)
  writeRequest(root, { version: 1, token, state: 'prepared', digest: treeDigest(staged), mode,
    sourceIdentity: diskIdentity(root), stagedIdentity: diskIdentity(staged) })
}
export function cancelPreparedRestore(root: string): void {
  if (readRequest(root)?.state !== 'prepared') throw new Error('The restore has already started.')
  fs.rmSync(requestPath(root))
}
export function requestRestoreRollback(root: string): void {
  const request = readRequest(root)
  if (!request || request.state !== 'installed') throw new Error('Restore cannot be rolled back in its current state.')
  assertOrdinaryPath(root, true)
  if (!request.stagedIdentity || !identityMatches(request.stagedIdentity, diskIdentity(root))) throw new Error('Installed restore directory identity changed.')
  writeRequest(root, { ...request, state: 'rollback', failedDigest: treeDigest(root) })
}

/** Cleanup cannot reverse a committed restore or a completed rollback. */
function cleanup(root: string, request: RestoreRequest): void {
  const verifyActive = () => {
    assertOrdinaryPath(root, true)
    const activeIdentity = request.state === 'committed' ? request.stagedIdentity : request.sourceIdentity
    if (!activeIdentity || !identityMatches(activeIdentity, diskIdentity(root))) throw new Error('Application data identity changed before restore cleanup.')
  }
  try {
    verifyActive()
    try {
      if (request.state === 'committed') {
        const manifest = path.join(root, 'manifest.json')
        if (fs.existsSync(manifest)) { assertOrdinaryPath(manifest); fs.unlinkSync(manifest) }
        removeVerifiedTree(`${root}.bak-${request.token}`, request.sourceIdentity, request.backupDigest)
      } else {
        removeVerifiedTree(`${root}.failed-${request.token}`, request.stagedIdentity, request.failedDigest)
        removeVerifiedTree(`${root}.restore-${request.token}`, request.stagedIdentity, request.digest)
      }
    } catch (error) { console.warn('[backup] Temporary restore data could not be removed:', error) }
    verifyActive()
    const current = readRequest(root)
    if (current?.token !== request.token || current.state !== request.state) throw new Error('Restore request changed before completion.')
    fs.rmSync(requestPath(root))
  } catch (error) { console.warn('[backup] Completed restore request could not be removed:', error) }
}
function rollback(root: string, request: RestoreRequest): void {
  const backup = `${root}.bak-${request.token}`, failed = `${root}.failed-${request.token}`
  if (fs.existsSync(backup)) {
    verifyTree(backup, request.sourceIdentity, request.backupDigest)
    if (fs.existsSync(root)) {
      assertOrdinaryPath(root, true)
      if (!request.stagedIdentity || !identityMatches(request.stagedIdentity, diskIdentity(root))) throw new Error('Installed restore directory identity changed.')
      if (fs.existsSync(failed)) throw new Error('Restore recovery destination already exists.')
      if (request.failedDigest) verifyTree(root, request.stagedIdentity, request.failedDigest)
      else { request.failedDigest = treeDigest(root); writeRequest(root, request) }
      fs.renameSync(root, failed)
    }
    fs.renameSync(backup, root)
  } else {
    assertOrdinaryPath(root, true)
    if (!request.sourceIdentity || !identityMatches(request.sourceIdentity, diskIdentity(root))) throw new Error('The original application data required for rollback is missing.')
  }
  request.state = 'rolled-back'
  writeRequest(root, request)
  cleanup(root, request)
}

/** Runs before any database or Chromium session captures the application data root. */
export function applyPendingRestore(root: string, prepareLimited?: (root: string, staged: string) => void, prepareFull?: (root: string, staged: string) => void): RestoreOutcome {
  const request = readRequest(root)
  if (!request) return { restored: false }
  const staged = `${root}.restore-${request.token}`, backup = `${root}.bak-${request.token}`
  if (request.state === 'committed' || request.state === 'rolled-back') { cleanup(root, request); return { restored: false } }
  if (request.state === 'rollback') {
    rollback(root, request)
    return { restored: false, error: '导入失败，已恢复原资料。' }
  }
  if (request.state === 'installed' || !fs.existsSync(staged) && fs.existsSync(backup) && fs.existsSync(root)) {
    assertOrdinaryPath(root, true)
    if (!request.stagedIdentity || !identityMatches(request.stagedIdentity, diskIdentity(root))) throw new Error('Installed restore directory identity changed.')
    verifyTree(backup, request.sourceIdentity, request.backupDigest)
    writeRequest(root, { ...request, state: 'installed' })
    return { restored: true, backupPath: backup }
  }
  try {
    if (!fs.existsSync(backup)) {
      assertOrdinaryPath(root, true)
      if (!request.sourceIdentity || !identityMatches(request.sourceIdentity, diskIdentity(root))) throw new Error('Application data identity changed after restore was confirmed.')
    } else verifyTree(backup, request.sourceIdentity, request.backupDigest)
    verifyTree(staged, request.stagedIdentity, request.digest)
    if (!request.composed && (request.mode === 'limited' || prepareFull)) {
      const prepare = request.mode === 'limited' ? prepareLimited : prepareFull
      if (!prepare) throw new Error('Limited restore adapter is unavailable.')
      prepare(root, staged)
      request.composed = true
      request.digest = treeDigest(staged)
      request.stagedIdentity = diskIdentity(staged)
      writeRequest(root, request)
    }
    if (!fs.existsSync(backup)) {
      request.backupDigest = treeDigest(root)
      writeRequest(root, request)
      fs.renameSync(root, backup)
    }
    fs.renameSync(staged, root)
    writeRequest(root, { ...request, state: 'installed' })
    return { restored: true, backupPath: backup }
  } catch (error) {
    if (fs.existsSync(backup)) {
      request.state = 'rollback'; writeRequest(root, request); rollback(root, request)
    } else {
      request.state = 'rolled-back'; writeRequest(root, request); cleanup(root, request)
    }
    return { restored: false, error: `导入未完成：${(error as Error).message}` }
  }
}
export function finishPendingRestore(root: string): void {
  const request = readRequest(root)
  if (request?.state !== 'installed') throw new Error('Restore has not been installed.')
  assertOrdinaryPath(root, true)
  if (!request.stagedIdentity || !identityMatches(request.stagedIdentity, diskIdentity(root))) throw new Error('Installed restore directory identity changed.')
  request.state = 'committed'
  writeRequest(root, request)
  cleanup(root, request)
}
