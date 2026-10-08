import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const GUARD_ARGUMENT = '--backup-recovery-guardian'
const index = process.argv.indexOf(GUARD_ARGUMENT)
export const backupGuardianRequest = index >= 0 ? process.argv[index + 1] : undefined

interface Request {
  version: number
  executable: string
  parentPid: number
  source: string
  identity: { dev: string; ino: string }
  args: string[]
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

async function waitForRecovery(directory: string, pid: number): Promise<'ready' | 'stopped' | 'timeout'> {
  const resumed = path.join(directory, 'resumed')
  const deadline = Date.now() + 45_000
  while (!fs.existsSync(resumed) && alive(pid) && Date.now() < deadline) await delay(200)
  if (fs.existsSync(resumed)) return 'ready'
  if (!alive(pid)) return 'stopped'
  const temporary = path.join(directory, 'guardian-recovery.tmp')
  fs.writeFileSync(temporary, JSON.stringify({ state: 'recovery-required', pid,
    error: '应用恢复进程仍在运行，但未在等待时间内确认就绪。原资料和备份结果已保留，请检查该窗口。' }))
  fs.renameSync(temporary, path.join(directory, 'guardian-recovery.json'))
  return 'timeout'
}

export function initializeBackupGuardian(): void {
  if (!backupGuardianRequest) throw new Error('Backup guardian request is missing.')
  const directory = path.dirname(path.resolve(backupGuardianRequest))
  if (path.basename(backupGuardianRequest) !== 'request.bin'
    || !/^sidekick-backup-job-[A-Za-z0-9]+$/.test(path.basename(directory))
    || path.resolve(path.dirname(directory)).toLowerCase() !== path.resolve(app.getPath('temp')).toLowerCase()
    || fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(backupGuardianRequest).isSymbolicLink()) {
    throw new Error('Invalid backup guardian directory.')
  }
  const session = path.join(directory, 'guardian-session')
  fs.mkdirSync(session)
  app.setPath('userData', session)
  app.setPath('sessionData', session)
}

/** Restoration survives a snapshot worker crash without persisting its password. */
export async function runBackupGuardian(): Promise<number> {
  if (!process.send || !process.connected || !backupGuardianRequest) throw new Error('Backup guardian requires an inherited channel.')
  const request = await new Promise<Request>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backup guardian request timed out.')), 15_000)
    process.once('disconnect', () => { clearTimeout(timer); reject(new Error('Backup guardian channel closed.')) })
    process.once('message', value => { clearTimeout(timer); resolve(value as Request) })
    process.send!({ type: 'backup-ready' })
  })
  if (request.version !== 1 || request.executable !== process.execPath || !path.isAbsolute(request.source)
    || !Number.isSafeInteger(request.parentPid) || !Array.isArray(request.args)
    || request.args.some(value => typeof value !== 'string')) throw new Error('Invalid backup guardian request.')
  process.disconnect?.()
  const directory = path.dirname(backupGuardianRequest)
  fs.writeFileSync(path.join(directory, 'guardian.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  const childArgs = app.isPackaged ? [] : [process.argv[1] || app.getAppPath()]
  const child = spawn(process.execPath, [...childArgs, '--backup-snapshot-worker', backupGuardianRequest], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  child.once('message', message => {
    if ((message as { type?: string })?.type === 'backup-ready') child.send(request)
  })
  await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
  if (!fs.existsSync(path.join(directory, 'commit')) || fs.existsSync(path.join(directory, 'abort')) || alive(request.parentPid)) return 0
  const resumed = path.join(directory, 'resumed')
  if (fs.existsSync(resumed)) return 0
  const launchRecord = path.join(directory, 'resume-process.json')
  if (fs.existsSync(launchRecord)) {
    const launched = JSON.parse(fs.readFileSync(launchRecord, 'utf8')) as { pid: number }
    const outcome = await waitForRecovery(directory, launched.pid)
    if (outcome === 'ready') return 0
    if (outcome === 'timeout') return 1
  }
  const source = fs.lstatSync(request.source, { bigint: true })
  if (!source.isDirectory() || source.isSymbolicLink() || String(source.dev) !== request.identity.dev || String(source.ino) !== request.identity.ino) return 1
  const statusPath = path.join(directory, 'status.json')
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {}
  if (status.state !== 'complete') {
    const temporary = path.join(directory, 'guardian-status.tmp')
    fs.writeFileSync(temporary, JSON.stringify({ state: 'complete', success: false, error: '后台备份意外停止，原资料已保留。可在数据迁移中继续已保存的备份任务。' }))
    fs.renameSync(temporary, statusPath)
  }
  const env = { ...process.env }
  delete env.SIDEKICK_APPLICATION_INTENT
  delete env.SIDEKICK_APPLICATION_REQUEST_ID
  const replacement = spawn(process.execPath, [...request.args, '--backup-snapshot-result', backupGuardianRequest], {
    env, detached: true, windowsHide: true, stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => { replacement.once('spawn', resolve); replacement.once('error', reject) })
  replacement.unref()
  return await waitForRecovery(directory, replacement.pid!) === 'ready' ? 0 : 1
}
