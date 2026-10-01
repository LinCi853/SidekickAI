import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

interface RestoreRequest {
  version: 1
  token: string
  state: 'prepared' | 'installed' | 'rollback'
  digest: string
  mode?: 'full' | 'limited'
  composed?: boolean
}

export interface RestoreOutcome {
  restored: boolean
  backupPath?: string
  error?: string
}

function requestPath(root: string): string { return `${root}.restore.json` }

function readRequest(root: string): RestoreRequest | undefined {
  const file = requestPath(root)
  if (!fs.existsSync(file)) return undefined
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RestoreRequest
  if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.token)
    || value.mode !== undefined && !['full', 'limited'].includes(value.mode)
    || value.composed !== undefined && typeof value.composed !== 'boolean'
    || !['prepared', 'installed', 'rollback'].includes(value.state) || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('Invalid pending restore request.')
  return value
}

function writeRequest(root: string, request: RestoreRequest): void {
  const file = requestPath(root)
  const temporary = `${file}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, 'wx')
  try { fs.writeFileSync(descriptor, JSON.stringify(request)); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  try { fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}

/** A private staging tree is bound to its request before the application exits. */
function treeDigest(directory: string): string {
  const hash = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Restore staging must be a real directory.')
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      const relative = `${prefix}${name}`
      const information = fs.lstatSync(file)
      if (information.isSymbolicLink()) throw new Error('Restore staging contains a symbolic link.')
      if (information.isDirectory()) { hash.update(JSON.stringify([relative, 'directory'])); walk(file, `${relative}/`) }
      else if (information.isFile()) {
        hash.update(JSON.stringify([relative, information.size, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))
      } else throw new Error('Restore staging contains a special file.')
    }
  }
  walk(directory, '')
  return hash.digest('hex')
}

export function prepareRestoreDirectory(root: string): string {
  if (fs.existsSync(requestPath(root)) || fs.existsSync(`${root}.reset.json`)) throw new Error('An application data operation is already pending.')
  const directory = `${root}.restore-${randomUUID()}`
  fs.mkdirSync(directory)
  return directory
}

export function queuePreparedRestore(root: string, staged: string, mode: 'full' | 'limited' = 'full'): void {
  if (fs.existsSync(requestPath(root))) throw new Error('An application data restore is already pending.')
  const token = staged.slice(`${root}.restore-`.length)
  if (staged !== `${root}.restore-${token}` || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid restore staging path.')
  writeRequest(root, { version: 1, token, state: 'prepared', digest: treeDigest(staged), mode })
}

export function requestRestoreRollback(root: string): void {
  const request = readRequest(root)
  if (!request) throw new Error('Missing restore request.')
  writeRequest(root, { ...request, state: 'rollback' })
}

export function cancelPreparedRestore(root: string): void {
  if (readRequest(root)?.state !== 'prepared') throw new Error('The restore has already started.')
  fs.rmSync(requestPath(root))
}

function rollback(root: string, request: RestoreRequest): void {
  const backup = `${root}.bak-${request.token}`
  if (fs.existsSync(backup)) {
    if (fs.existsSync(root)) fs.renameSync(root, `${root}.failed-${request.token}`)
    fs.renameSync(backup, root)
  }
  if (!fs.existsSync(root)) throw new Error('Restore recovery requires the preserved data directory.')
  fs.rmSync(requestPath(root))
}

/** Runs synchronously before any application database or Chromium session is opened. */
export function applyPendingRestore(root: string, prepareLimited?: (root: string, staged: string) => void, prepareFull?: (root: string, staged: string) => void): RestoreOutcome {
  const request = readRequest(root)
  if (!request) return { restored: false }
  const staged = `${root}.restore-${request.token}`
  const backup = `${root}.bak-${request.token}`
  if (request.state === 'rollback') {
    rollback(root, request)
    return { restored: false, error: 'The application data restore failed and the previous data was recovered.' }
  }
  if (request.state === 'installed' || !fs.existsSync(staged) && fs.existsSync(backup) && fs.existsSync(root)) {
    if (!fs.existsSync(root) || !fs.existsSync(backup)) throw new Error('Restore recovery directories are missing.')
    writeRequest(root, { ...request, state: 'installed' })
    return { restored: true, backupPath: backup }
  }
  try {
    if (treeDigest(staged) !== request.digest) throw new Error('Restore staging integrity check failed.')
    if (!request.composed && (request.mode === 'limited' || prepareFull)) {
      const prepare = request.mode === 'limited' ? prepareLimited : prepareFull
      if (!prepare) throw new Error('Limited restore adapter is unavailable.')
      prepare(root, staged)
      request.composed = true
      request.digest = treeDigest(staged)
      writeRequest(root, request)
    }
    if (!fs.existsSync(backup)) fs.renameSync(root, backup)
    fs.renameSync(staged, root)
    writeRequest(root, { ...request, state: 'installed' })
    return { restored: true, backupPath: backup }
  } catch (error) {
    writeRequest(root, { ...request, state: 'rollback' })
    rollback(root, request)
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true })
    return { restored: false, error: `Application data restore was cancelled: ${(error as Error).message}` }
  }
}

export function finishPendingRestore(root: string): void {
  const request = readRequest(root)
  if (request?.state !== 'installed') throw new Error('Restore has not been installed.')
  fs.rmSync(path.join(root, 'manifest.json'), { force: true })
  fs.rmSync(requestPath(root))
}
