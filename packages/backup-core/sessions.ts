import { app, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { cookieSetDetails, safeBackupPath } from './format.js'
import { assertOrdinaryPath, createPrivateDirectory } from './io.js'
import { captureBackupDrafts } from './sensitive-drafts.js'
import { validateSensitiveDrafts } from './sensitive-drafts-format.js'
import type { BackupOptions, CookieSnapshot, SensitiveDraftTransport } from './types.js'

const HELPER_ARGUMENT = '--backup-cookie-snapshot'
const helperIndex = process.argv.indexOf(HELPER_ARGUMENT)
export const cookieHelperRequestPath = helperIndex < 0 ? undefined : process.argv[helperIndex + 1]
interface HelperRequest { root: string; resultPath: string; expected: Record<string, string[]>; drafts?: boolean; cookies?: boolean }

function readHelperRequest(): HelperRequest {
  if (!cookieHelperRequestPath) throw new Error('Cookie snapshot request is missing.')
  assertOrdinaryPath(cookieHelperRequestPath)
  const request = JSON.parse(fs.readFileSync(cookieHelperRequestPath, 'utf8')) as HelperRequest
  const directory = path.dirname(path.resolve(cookieHelperRequestPath))
  if (!path.basename(directory).startsWith('sidekick-cookie-copy-') || path.resolve(request.root) !== path.join(directory, 'sessions')
    || path.resolve(request.resultPath) !== path.join(directory, 'result.json') || !request.expected || typeof request.expected !== 'object') throw new Error('Invalid isolated cookie snapshot request.')
  for (const relative of Object.keys(request.expected)) if (relative !== '' && (!/^Partitions\/[^/]+$/.test(relative) || !safeBackupPath(relative))) throw new Error('Invalid isolated cookie snapshot path.')
  assertOrdinaryPath(request.root, true)
  return request
}

export function initializeCookieHelper(): string {
  const request = readHelperRequest()
  app.setPath('userData', request.root)
  app.setPath('sessionData', request.root)
  return request.root
}

function sessionPaths(root: string): string[] {
  const result = ['']
  const directory = path.join(root, 'Partitions')
  if (!fs.existsSync(directory)) return result
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Session storage must not be a filesystem link.')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Session storage must not contain filesystem links.')
    if (entry.isDirectory()) result.push(`Partitions/${entry.name}`)
  }
  return result
}

export async function captureBackupSessions(root: string, options: BackupOptions): Promise<CookieSnapshot[] | undefined> {
  if (!options.cookies && !options.indexedDB && !options.cache) return undefined
  const snapshots: CookieSnapshot[] = []
  for (const relative of sessionPaths(root)) {
    if (relative && !safeBackupPath(relative)) throw new Error('Invalid backup session directory.')
    const target = relative ? session.fromPartition(`persist:${path.posix.basename(relative)}`) : session.defaultSession
    target.flushStorageData()
    await target.cookies.flushStore()
    if (options.cookies) snapshots.push({ path: relative, cookies: await target.cookies.get({}) })
  }
  return options.cookies ? snapshots : undefined
}

export async function restoreBackupCookies(_root: string, snapshots: CookieSnapshot[] | undefined): Promise<void> {
  for (const snapshot of snapshots ?? []) {
    const target = snapshot.path ? session.fromPartition(`persist:${path.posix.basename(snapshot.path)}`) : session.defaultSession
    for (const cookie of snapshot.cookies) {
      if (!cookie.session && cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000) continue
      await target.cookies.set(cookieSetDetails(cookie))
    }
    await target.cookies.flushStore()
  }
}

function cookieIdentity(domain: string, name: string, cookiePath: string): string { return JSON.stringify([domain, name, cookiePath]) }

export async function runCookieSnapshotHelper(): Promise<number> {
  const request = readHelperRequest()
  try {
    const snapshots = request.cookies === false ? [] : await captureBackupSessions(request.root, { basicData: true, cookies: true, indexedDB: false, cache: false }) ?? []
    const sensitiveDrafts = request.drafts ? captureBackupDrafts(request.root) : undefined
    for (const [relative, expected] of Object.entries(request.expected)) {
      const observed = new Set((snapshots.find(item => item.path === relative)?.cookies ?? []).map(cookie => cookieIdentity(cookie.domain!, cookie.name, cookie.path!)))
      if (expected.some(key => !observed.has(key))) throw new Error('无法从隔离副本完整读取登录凭据，原数据未删除。')
    }
    fs.writeFileSync(request.resultPath, JSON.stringify({ ok: true, snapshots, sensitiveDrafts }), { flag: 'wx' })
    return 0
  } catch (error) {
    fs.writeFileSync(request.resultPath, JSON.stringify({ ok: false, error: (error as Error).message }), { flag: 'wx' })
    return 1
  }
}

/** Chromium opens only a disposable cookie copy; the source-bound archive retains every original byte. */
export async function captureOfflineCookies(files: Array<{ archivePath: string; data?: Buffer; sourcePath?: string }>): Promise<CookieSnapshot[]> {
  return (await captureOfflineSensitiveData(files, undefined, true, false)).snapshots
}

export async function captureOfflineSensitiveData(files: Array<{ archivePath: string; data?: Buffer; sourcePath?: string }>, sourceRoot?: string, cookies = true, drafts = true): Promise<{ snapshots: CookieSnapshot[]; sensitiveDrafts?: SensitiveDraftTransport }> {
  const selected = files.filter(file => file.archivePath === 'Local State'
    || drafts && /^settings\.db(?:-wal|-shm|-journal)?$/.test(file.archivePath)
    || cookies && /(^|\/)(?:Network\/)?Cookies(?:-wal|-shm|-journal)?$/.test(file.archivePath))
  if (drafts && !selected.some(file => file.archivePath === 'settings.db')) throw new Error('Sensitive draft capture requires a stable settings database.')
  if (!drafts && !selected.some(file => /(^|\/)(?:Network\/)?Cookies$/.test(file.archivePath))) return { snapshots: [] }
  if (sourceRoot && !selected.some(file => file.archivePath === 'Local State') && fs.existsSync(path.join(sourceRoot, 'Local State'))) {
    const sourcePath = path.join(sourceRoot, 'Local State')
    assertOrdinaryPath(sourcePath)
    selected.push({ archivePath: 'Local State', sourcePath })
  }
  const directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-cookie-copy-'))
  createPrivateDirectory(directory)
  const root = path.join(directory, 'sessions')
  fs.mkdirSync(root)
  try {
    for (const file of selected) {
      if (!safeBackupPath(file.archivePath)) throw new Error('Invalid isolated cookie source path.')
      const target = path.join(root, file.archivePath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (file.sourcePath) { assertOrdinaryPath(file.sourcePath); fs.copyFileSync(file.sourcePath, target, fs.constants.COPYFILE_EXCL) }
      else if (file.data) fs.writeFileSync(target, file.data, { flag: 'wx' })
      else throw new Error('Missing isolated cookie source.')
    }
    const expected: Record<string, string[]> = {}
    for (const relative of sessionPaths(root)) {
      const base = path.join(root, relative)
      const file = ['Network/Cookies', 'Cookies'].map(name => path.join(base, name)).find(name => fs.existsSync(name))
      if (!file) continue
      const db = new Database(file, { fileMustExist: true })
      try {
        const rows = db.prepare('SELECT host_key,name,path,expires_utc,has_expires FROM cookies').all() as Array<{ host_key: string; name: string; path: string; expires_utc: number; has_expires: number }>
        const now = (Date.now() + 11_644_473_600_000) * 1000
        expected[relative] = rows.filter(row => !row.has_expires || row.expires_utc > now).map(row => cookieIdentity(row.host_key, row.name, row.path))
      } finally { db.close() }
    }
    const requestPath = path.join(directory, 'request.json')
    const resultPath = path.join(directory, 'result.json')
    fs.writeFileSync(requestPath, JSON.stringify({ root, resultPath, expected, cookies, drafts }), { flag: 'wx' })
    const args = app.isPackaged ? [] : [process.argv[1] || app.getAppPath()]
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SIDEKICK_DATA_DIR
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [...args, HELPER_ARGUMENT, requestPath, '--disable-gpu', '--disable-crashpad'], { env, windowsHide: true, stdio: 'ignore' })
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; child.kill() }, 25_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', status => { clearTimeout(timeout); timedOut ? reject(new Error('隔离敏感资料读取超时，原数据未删除。')) : resolve(status ?? 1) })
    })
    if (!fs.existsSync(resultPath)) throw new Error('隔离登录凭据读取未返回结果，原数据未删除。')
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    if (code !== 0 || !result.ok || !Array.isArray(result.snapshots)) throw new Error(result.error ?? '隔离登录凭据读取失败，原数据未删除。')
    for (const snapshot of result.snapshots as CookieSnapshot[]) for (const cookie of snapshot.cookies) cookieSetDetails(cookie)
    if (drafts) validateSensitiveDrafts(result.sensitiveDrafts)
    return { snapshots: result.snapshots, sensitiveDrafts: result.sensitiveDrafts }
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
