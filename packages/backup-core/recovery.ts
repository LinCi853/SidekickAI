import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { setBackupSourceRoot } from './context.js'
import { retrySourceSnapshot } from './export.js'
import type { ExportPreparation, ExportResult } from './export.js'
import type { BackupOptions } from './types.js'
import { GUARD_ARGUMENT } from './guardian.js'
import { createPrivateDirectory } from './io.js'

const WORKER_ARGUMENT = '--backup-snapshot-worker'
const RESULT_ARGUMENT = '--backup-snapshot-result'
const DEADLINE_MS = 45_000
export const backupWorkerRequest = argumentValue(WORKER_ARGUMENT)
const backupResultRequest = argumentValue(RESULT_ARGUMENT)

interface RecoveryRequest {
  version: 1
  executable: string
  parentPid: number
  source: string
  identity: { dev: string; ino: string }
  target: string
  options: BackupOptions
  encrypt?: { password: string }
  args: string[]
  windows: unknown
  tempRoot?: string
  cleanup?: boolean
}

export interface BackupRecoveryHost {
  source(): string
  export(target: string, options: BackupOptions, encrypt?: { password: string }, preparation?: ExportPreparation): Promise<ExportResult>
  quit(beforeQuit: () => Promise<void>): Promise<boolean>
  captureWindows(): unknown
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export function backupRestartArguments(args = process.argv.slice(1)): string[] {
  return args.filter((value, index) => ![WORKER_ARGUMENT, RESULT_ARGUMENT, GUARD_ARGUMENT].includes(value)
    && ![WORKER_ARGUMENT, RESULT_ARGUMENT, GUARD_ARGUMENT].includes(args[index - 1])
    && !['--sidekick-admin-task', '--sidekick-normal-handoff'].includes(value))
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

function directoryIdentity(root: string): RecoveryRequest['identity'] {
  const info = fs.lstatSync(root, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup source must be an ordinary directory.')
  return { dev: String(info.dev), ino: String(info.ino) }
}

function jobDirectory(file: string): string {
  const directory = path.dirname(path.resolve(file))
  if (!/^sidekick-backup-job-[A-Za-z0-9]+$/.test(path.basename(directory)) || path.basename(file) !== 'request.bin'
    || !samePath(path.dirname(directory), app.getPath('temp'))) throw new Error('Invalid backup recovery request location.')
  for (const entry of [directory, file]) if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Backup recovery request cannot be a link.')
  return directory
}

function writeStatus(directory: string, status: Record<string, unknown>): void {
  const scratch = path.join(directory, 'status.tmp')
  fs.writeFileSync(scratch, JSON.stringify(status))
  fs.renameSync(scratch, path.join(directory, 'status.json'))
}

async function until(check: () => boolean, timeout = DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待备份交接超时，原数据已保留。')
    await delay(100)
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

let exporting: Promise<ExportResult> | undefined
let recovering = !!backupResultRequest

/** A caller keeps one request while transient browser writes are handled automatically. */
export function runExclusiveBackup(run: () => Promise<ExportResult>): Promise<ExportResult> {
  if (exporting || recovering) return Promise.resolve({ success: false, error: '正在备份，请等待当前备份完成。' })
  const task = run()
  exporting = task
  void task.finally(() => { if (exporting === task) exporting = undefined }).catch(() => {})
  return task
}

export function exportWithRecovery(host: BackupRecoveryHost, target: string, options: BackupOptions, encrypt?: { password: string }, preparation?: ExportPreparation): Promise<ExportResult> {
  const run = async (): Promise<ExportResult> => {
    const first = await host.export(target, options, encrypt, preparation)
    if (first.success || !first.retryable) return first
    try { return await beginRecovery(host, target, options, encrypt, preparation) }
    catch (error) { return { success: false, error: (error as Error).message } }
  }
  return runExclusiveBackup(run)
}

async function beginRecovery(host: BackupRecoveryHost, target: string, options: BackupOptions, encrypt?: { password: string }, preparation?: ExportPreparation): Promise<ExportResult> {
  const source = path.resolve(host.source())
  const relativeTarget = path.relative(source, path.resolve(target))
  if (!relativeTarget || !relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== '..' && !path.isAbsolute(relativeTarget)) {
    throw new Error('请将备份保存到应用数据目录以外。')
  }
  const directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-backup-job-'))
  createPrivateDirectory(directory)
  const requestFile = path.join(directory, 'request.bin')
  let worker: ChildProcess | undefined
  try {
    const request: RecoveryRequest = {
      version: 1, executable: process.execPath, parentPid: process.pid, source, identity: directoryIdentity(source),
      target: path.resolve(target), options, encrypt, args: backupRestartArguments(), windows: host.captureWindows(),
      tempRoot: preparation?.tempRoot, cleanup: preparation?.cleanup === true,
    }
    const { encrypt: _secret, ...publicRequest } = request
    fs.writeFileSync(requestFile, JSON.stringify(publicRequest), { flag: 'wx', mode: 0o600 })
    const args = app.isPackaged ? [] : [process.argv[1] || app.getAppPath()]
    const child = spawn(process.execPath, [...args, GUARD_ARGUMENT, requestFile], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    worker = child
    let childError: Error | undefined
    child.once('error', error => { childError = error })
    child.once('message', message => {
      if ((message as { type?: string })?.type !== 'backup-ready') { childError = new Error('Invalid backup worker handshake.'); return }
      child.send(request, error => { if (error) childError = error })
    })
    child.unref()
    await until(() => {
      if (childError) throw childError
      if (fs.existsSync(path.join(directory, 'status.json'))) {
        const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'))
        if (status.error) throw new Error(status.error)
      }
      return fs.existsSync(path.join(directory, 'ready'))
    }, 15_000)
    const accepted = await host.quit(async () => {
      fs.writeFileSync(path.join(directory, 'commit'), 'ready', { flag: 'wx' })
    })
    if (!accepted) throw new Error('更改尚未全部保存，备份交接已取消，原应用保持打开。')
    return { success: false, error: '备份正在后台继续，完成后将显示结果。' }
  } catch (error) {
    try { fs.writeFileSync(path.join(directory, 'abort'), 'cancelled') } catch { }
    try {
      await until(() => !worker?.pid || worker.exitCode !== null || worker.signalCode !== null, 2_000)
      jobDirectory(requestFile)
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { }
    throw error
  }
}

/** Called before Chromium creates any sessions or application stores. */
export function initializeBackupWorker(): void {
  if (!backupWorkerRequest) throw new Error('Backup worker request is missing.')
  const directory = jobDirectory(backupWorkerRequest)
  const sessionRoot = path.join(directory, 'session')
  fs.mkdirSync(sessionRoot, { recursive: true })
  app.setPath('userData', sessionRoot)
  app.setPath('sessionData', sessionRoot)
}

export async function runBackupWorker(load: () => Promise<Pick<BackupRecoveryHost, 'export'>>): Promise<number> {
  if (!backupWorkerRequest) throw new Error('Backup worker request is missing.')
  const directory = jobDirectory(backupWorkerRequest)
  let request: RecoveryRequest | undefined
  let canResume = false
  let parentStopped = false
  let resumed = false
  let locked = false
  let resumeFailure: Error | undefined
  let reported = false
  const reportFailure = (title: string, message: string) => {
    if (reported) return
    reported = true
    dialog.showErrorBox(title, message)
  }
  const resume = async () => {
    if (!request || !canResume || resumed) return
    const current = directoryIdentity(request.source)
    if (current.dev !== request.identity.dev || current.ino !== request.identity.ino) throw new Error('原资料目录已变化，未自动打开替换后的资料。')
    if (locked) { app.releaseSingleInstanceLock(); locked = false }
    const env = { ...process.env }
    delete env.SIDEKICK_APPLICATION_INTENT
    delete env.SIDEKICK_APPLICATION_REQUEST_ID
    const child = spawn(process.execPath, [...request.args, RESULT_ARGUMENT, backupWorkerRequest], { env, detached: true, windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    fs.writeFileSync(path.join(directory, 'resume-process.json'), JSON.stringify({ pid: child.pid }), { flag: 'wx' })
    child.once('exit', code => { if (!fs.existsSync(path.join(directory, 'resumed'))) resumeFailure = new Error(`应用恢复进程未就绪便退出（${code}）。`) })
    child.unref()
    resumed = true
  }
  try {
    request = await new Promise<RecoveryRequest>((resolve, reject) => {
      if (!process.send || !process.connected) { reject(new Error('Backup worker requires an inherited private channel.')); return }
      const disconnected = () => { clearTimeout(timer); reject(new Error('Backup request channel closed.')) }
      const timer = setTimeout(() => { process.removeListener('disconnect', disconnected); reject(new Error('Backup request channel timed out.')) }, 15_000)
      process.once('disconnect', disconnected)
      process.once('message', message => {
        clearTimeout(timer)
        process.removeListener('disconnect', disconnected)
        resolve(message as RecoveryRequest)
        process.disconnect?.()
      })
      process.send({ type: 'backup-ready' })
    })
    if (request.version !== 1 || !samePath(request.executable, process.execPath) || !path.isAbsolute(request.source)
      || !path.isAbsolute(request.target) || !Number.isSafeInteger(request.parentPid) || request.parentPid <= 0
      || !Array.isArray(request.args) || request.args.some(value => typeof value !== 'string')
      || request.cleanup !== undefined && typeof request.cleanup !== 'boolean'
      || !request.options?.basicData) throw new Error('Invalid backup recovery request.')
    fs.writeFileSync(path.join(directory, 'ready'), JSON.stringify({ pid: process.pid }), { flag: 'wx' })
    await until(() => {
      if (fs.existsSync(path.join(directory, 'abort'))) throw new Error('备份交接已取消。')
      return fs.existsSync(path.join(directory, 'commit')) && !alive(request!.parentPid)
    })
    parentStopped = true
    const identity = directoryIdentity(request.source)
    if (identity.dev !== request.identity.dev || identity.ino !== request.identity.ino) throw new Error('备份源目录已被替换，未读取新目录。')
    canResume = true
    const instanceRoot = `${request.source}.instance`
    fs.mkdirSync(instanceRoot, { recursive: true })
    app.setPath('userData', instanceRoot)
    if (!app.requestSingleInstanceLock()) throw new Error('其他实例正在使用资料，原数据已保留。')
    locked = true
    app.setPath('userData', request.source)
    setBackupSourceRoot(request.source)
    writeStatus(directory, { state: 'snapshot' })
    const adapter = await load()
    const sourceRequest = request
    const result = await retrySourceSnapshot(() => adapter.export(sourceRequest.target, sourceRequest.options, sourceRequest.encrypt, {
        snapshot: true, expectedDataRoot: sourceRequest.source, tempRoot: sourceRequest.tempRoot, cleanup: sourceRequest.cleanup,
        onSnapshotReady: async () => { writeStatus(directory, { state: 'saving' }); await resume() },
      }))
    writeStatus(directory, { state: 'complete', ...result })
    return result.success ? 0 : 1
  } catch (error) {
    try { writeStatus(directory, { state: 'complete', success: false, error: (error as Error).message }) }
    catch { reportFailure('备份未完成', `无法保存备份结果，原资料未删除。\n${(error as Error).message}`) }
    if (parentStopped && !canResume) reportFailure('备份未完成', `资料目录无法安全核实，未自动打开其他资料。\n${(error as Error).message}`)
    return 1
  } finally {
    if (canResume && !resumed) {
      try { await resume() }
      catch (error) { reportFailure('应用恢复失败', `原数据已保留，请重新打开应用。\n${(error as Error).message}`) }
    }
    if (locked) app.releaseSingleInstanceLock()
    if (resumed) {
      try { await until(() => { if (resumeFailure) throw resumeFailure; return fs.existsSync(path.join(directory, 'resumed')) }) }
      catch (error) { reportFailure('应用恢复未完成', `备份结果已保留在临时记录中，请重新打开应用。\n${(error as Error).message}`) }
    }
    request = undefined
  }
}

/** The resumed application reports the original operation, including failures after restart. */
export async function finishBackupRecovery(restoreWindows: (state: unknown) => void | Promise<void>, source: () => string): Promise<void> {
  if (!backupResultRequest) return
  const argumentIndex = process.argv.indexOf(RESULT_ARGUMENT)
  if (argumentIndex >= 0) process.argv.splice(argumentIndex, 2)
  let directory: string | undefined
  let completed = false
  let workerPid: number | undefined
  try {
    directory = jobDirectory(backupResultRequest)
    const request = JSON.parse(fs.readFileSync(backupResultRequest, 'utf8')) as RecoveryRequest
    if (request.version !== 1 || !samePath(request.executable, process.execPath)) throw new Error('Invalid backup result request.')
    const current = directoryIdentity(source())
    if (!samePath(source(), request.source) || current.dev !== request.identity.dev || current.ino !== request.identity.ino) throw new Error('恢复的资料目录与备份来源不符。')
    fs.writeFileSync(path.join(directory, 'resumed'), 'ready', { flag: 'wx' })
    let windowError: string | undefined
    try { await restoreWindows(request.windows) } catch (error) { windowError = (error as Error).message }
    let result: ExportResult | undefined
    workerPid = JSON.parse(fs.readFileSync(path.join(directory, 'ready'), 'utf8')).pid as number
    await until(() => {
      if (fs.existsSync(path.join(directory!, 'status.json'))) {
        const status = JSON.parse(fs.readFileSync(path.join(directory!, 'status.json'), 'utf8'))
        if (status.state === 'complete') { result = status; return true }
      }
      if (!Number.isSafeInteger(workerPid) || workerPid! <= 0 || !alive(workerPid!)) throw new Error('后台备份进程未返回完成结果，原数据已保留。')
      return false
    }, Number.POSITIVE_INFINITY)
    completed = true
    await dialog.showMessageBox({ type: result?.success ? 'info' : 'error', title: result?.success ? '备份已保存' : '备份未完成',
      message: result?.success ? '备份已保存，并通过完整性校验。' : '备份未完成，原数据已保留。',
      detail: [result?.success ? request.target : result?.error, windowError ? `部分窗口或临时页面需重新打开：${windowError}` : undefined].filter(Boolean).join('\n'), buttons: ['确定'] })
  } catch (error) {
    if (!completed) dialog.showErrorBox('备份结果', (error as Error).message)
    else console.warn('[backup] Result dialog failed:', (error as Error).message)
  }
  finally {
    recovering = false
    if (completed && directory) {
      try {
        const guardianFile = path.join(directory, 'guardian.json')
        const guardianPid = fs.existsSync(guardianFile) ? JSON.parse(fs.readFileSync(guardianFile, 'utf8')).pid as number : undefined
        if (guardianPid !== undefined && (!Number.isSafeInteger(guardianPid) || guardianPid <= 0)) throw new Error('Invalid backup guardian identity.')
        await until(() => !!workerPid && !alive(workerPid) && (!guardianPid || !alive(guardianPid)), 5_000)
        jobDirectory(backupResultRequest)
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch { }
    }
  }
}
