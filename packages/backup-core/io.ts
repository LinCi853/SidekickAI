import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const COPY_CHUNK_BYTES = 4 * 1024 * 1024
export const STREAM_BUFFER_BYTES = 256 * 1024
export const MAX_BACKUP_ENTRIES = 100_000
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
export const MAX_BACKUP_BYTES = Number.MAX_SAFE_INTEGER

export class BackupCancelledError extends Error {
  constructor() { super('备份已暂停并保留进度。'); this.name = 'BackupCancelledError' }
}
export class BackupWaitingError extends Error {
  constructor(public readonly reason: string, message: string) { super(message); this.name = 'BackupWaitingError' }
}
export interface DiskIdentity { device: string; inode: string }
export interface SpaceRequirement { path: string; bytes: number; purpose: string }
export interface SpaceCheck { path: string; device: string; availableBytes: number; requiredBytes: number; purposes: string[] }

export function checkAbort(signal?: AbortSignal, cancelled?: () => boolean): void {
  if (signal?.aborted || cancelled?.()) throw new BackupCancelledError()
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function assertOrdinaryPath(candidate: string, directory = false): fs.Stats {
  const resolved = path.resolve(candidate)
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean)
  let current = path.parse(resolved).root
  for (const part of parts) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Backup paths cannot traverse a symbolic link or junction: ${current}`)
  }
  const info = fs.lstatSync(resolved)
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`Backup path has an unsupported type: ${resolved}`)
  return info
}

export function diskIdentity(candidate: string): DiskIdentity {
  const info = fs.statSync(candidate, { bigint: true })
  return { device: String(info.dev), inode: String(info.ino) }
}

export function identityMatches(left: DiskIdentity, right: DiskIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

const WHOAMI_EXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
const ICACLS_EXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')

let userSid: string | undefined
function recordCurrentUser(account: string): string {
  userSid = account.match(/S-1-5-[0-9-]+/)?.[0]
  if (!userSid) throw new Error('Cannot identify the current account for private backup staging.')
  return userSid
}
function currentUserSid(): string {
  if (!userSid) {
    const account = execFileSync(WHOAMI_EXE, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    return recordCurrentUser(account)
  }
  return userSid
}

// icacls /save 会把受托人 SID 规范化为 SDDL 别名（内置管理员 RID-500 → LA、本地系统
// S-1-5-18 → SY 等），写回形式随账户类型与系统版本而变。因此不靠主机名推断账户身份，
// 而是在探测目录上执行与私有暂存目录完全相同的授权，把 icacls 实际写回的受托人形式
// 缓存为校验基准，保证创建与校验自洽。
let userTrustees: readonly string[] | undefined
function currentUserTrustees(): readonly string[] {
  if (!userTrustees) {
    const sid = currentUserSid()
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-acl-'))
    try {
      const probe = path.join(scratch, 'probe')
      const aclFile = path.join(scratch, 'probe.txt')
      fs.mkdirSync(probe)
      execFileSync(ICACLS_EXE, [probe, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' })
      execFileSync(ICACLS_EXE, [probe, '/save', aclFile, '/q'], { windowsHide: true, stdio: 'ignore' })
      const lines = fs.readFileSync(aclFile, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      const sddl = lines[1] ?? ''
      const prefix = sddl.slice(0, sddl.indexOf('('))
      const rules = [...sddl.matchAll(/\(([^()]*)\)/g)]
      if (lines.length !== 2 || !/^D:(?:P|AI|AR)*$/.test(prefix) || !prefix.includes('P') || !rules.length
        || prefix + rules.map(rule => rule[0]).join('') !== sddl) throw new Error('Cannot calibrate the private ACL trustee form for backup staging.')
      const trustees = rules.map(rule => rule[1].split(';')).filter(fields => fields.length === 6 && ['A', 'D'].includes(fields[0])).map(fields => fields[5])
      if (trustees.length !== rules.length) throw new Error('Cannot calibrate the private ACL trustee form for backup staging.')
      userTrustees = trustees
    } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
  }
  return userTrustees
}

function assertPrivateAcl(contents: string, trustees: readonly string[]): void {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const sddl = lines[1] ?? ''
  const prefix = sddl.slice(0, sddl.indexOf('('))
  const rules = [...sddl.matchAll(/\(([^()]*)\)/g)]
  if (lines.length !== 2 || !/^D:(?:P|AI|AR)*$/.test(prefix) || !prefix.includes('P') || !rules.length
    || prefix + rules.map(rule => rule[0]).join('') !== sddl
    || rules.some(rule => { const fields = rule[1].split(';'); return fields.length !== 6 || !['A', 'D'].includes(fields[0]) || !trustees.includes(fields[5]) })) {
    throw new Error('Backup staging ACL is not private to the current account and SYSTEM.')
  }
}

export function assertPrivateDirectory(directory: string): void {
  const info = assertOrdinaryPath(directory, true)
  if (process.platform !== 'win32') {
    if ((info.mode & 0o077) !== 0) throw new Error('Backup staging directory permits access by other accounts.')
    return
  }
  const trustees = currentUserTrustees()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-acl-'))
  try {
    const aclFile = path.join(scratch, 'access.txt')
    execFileSync(ICACLS_EXE, [directory, '/save', aclFile, '/q'], { windowsHide: true, stdio: 'ignore' })
    assertPrivateAcl(fs.readFileSync(aclFile, 'utf16le'), trustees)
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

export function createPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertOrdinaryPath(directory, true)
  if (process.platform === 'win32') {
    execFileSync(ICACLS_EXE, [directory, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' })
  } else fs.chmodSync(directory, 0o700)
  assertPrivateDirectory(directory)
}

export function flushFile(file: string): void {
  const descriptor = fs.openSync(file, 'r+')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

export function atomicJson(file: string, value: unknown): void {
  const scratch = `${file}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(scratch, 'wx', 0o600)
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  try {
    const deadline = performance.now() + 400
    const waiting = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(scratch, file); break }
      catch (error) {
        const remaining = deadline - performance.now()
        if (process.platform !== 'win32' || remaining <= 0
          || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        Atomics.wait(waiting, 0, 0, Math.min(25 * (attempt + 1), 100, remaining))
      }
    }
  }
  finally { if (fs.existsSync(scratch)) fs.unlinkSync(scratch) }
  if (process.platform !== 'win32') {
    const parent = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  }
}

export async function hashFile(file: string, signal?: AbortSignal, cancelled?: () => boolean): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file, { highWaterMark: STREAM_BUFFER_BYTES })
  for await (const data of stream) { checkAbort(signal, cancelled); hash.update(data) }
  return hash.digest('hex')
}

export async function retryIo<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal)
    try { return await operation() }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 2 || !['EBUSY', 'EACCES', 'EPERM', 'EAGAIN', 'ETXTBSY'].includes(code ?? '')) throw error
      await delay(100 * 2 ** attempt, undefined, { signal })
    }
  }
}

export function nearestExistingDirectory(candidate: string): string {
  let current = path.resolve(candidate)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new BackupWaitingError('device-unavailable', `目标设备不可用：${candidate}`)
    current = parent
  }
  assertOrdinaryPath(current, true)
  return current
}

export function checkDiskSpace(requirements: SpaceRequirement[], reserveBytes = 32 * 1024 * 1024): SpaceCheck[] {
  const volumes = new Map<string, SpaceCheck>()
  for (const requirement of requirements) {
    if (!Number.isSafeInteger(requirement.bytes) || requirement.bytes < 0) throw new Error('Backup size exceeds the supported integer range.')
    const root = nearestExistingDirectory(requirement.path)
    const identity = diskIdentity(root)
    const space = fs.statfsSync(root, { bigint: true })
    const available = Number(space.bavail * space.bsize)
    const volume = volumes.get(identity.device) ?? { path: root, device: identity.device, availableBytes: Math.min(available, MAX_BACKUP_BYTES), requiredBytes: reserveBytes, purposes: [] }
    volume.requiredBytes += requirement.bytes
    if (!Number.isSafeInteger(volume.requiredBytes)) throw new Error('Backup space budget exceeds the supported integer range.')
    volume.purposes.push(requirement.purpose)
    volumes.set(identity.device, volume)
  }
  for (const volume of volumes.values()) if (volume.availableBytes < volume.requiredBytes) {
    throw new BackupWaitingError('space', `磁盘空间不足：${volume.path}，还需 ${volume.requiredBytes - volume.availableBytes} 字节（${volume.purposes.join('、')}）。`)
  }
  return [...volumes.values()]
}

export async function copyFileVerified(source: string, target: string, options: { signal?: AbortSignal; cancelled?: () => boolean; onBytes?: (bytes: number) => void } = {}): Promise<{ size: number; sha256: string }> {
  assertOrdinaryPath(source)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const descriptor = await fs.promises.open(target, 'w', 0o600)
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const value of fs.createReadStream(source, { highWaterMark: STREAM_BUFFER_BYTES })) {
      checkAbort(options.signal, options.cancelled)
      const bytes = value as Buffer
      let offset = 0
      while (offset < bytes.length) { const written = await descriptor.write(bytes, offset, bytes.length - offset, size + offset); if (!written.bytesWritten) throw new Error('Backup snapshot write made no progress.'); offset += written.bytesWritten }
      size += bytes.length
      hash.update(bytes)
      options.onBytes?.(size)
    }
    await descriptor.sync()
  } finally { await descriptor.close() }
  const sha256 = hash.digest('hex')
  if (await hashFile(target, options.signal, options.cancelled) !== sha256) throw new Error('Backup snapshot verification failed.')
  return { size, sha256 }
}
