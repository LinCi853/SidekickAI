import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { windowsStartupHelper } from './windows-startup-helper'

const execute = promisify(execFile)
function operationError(error: unknown): Error {
  const output = (error as { stdout?: string }).stdout
  if (output) {
    try {
      const value = JSON.parse(output) as { error?: string; message?: string }
      const failure = new Error(value.message || 'Application process operation failed') as NodeJS.ErrnoException
      failure.code = value.error === 'access-denied' ? 'EACCES' : value.error === 'timeout' ? 'ETIMEDOUT' : value.error === 'unavailable' ? 'ENOENT' : value.error === 'authorization-cancelled' ? 'ECANCELED' : 'EIDENTITY'
      return failure
    } catch {}
  }
  return error as Error
}
export function applicationProcessScript(resourcesPath?: string): string {
  const script = path.join(resourcesPath ?? path.join(process.cwd(), 'resources'), 'windows/application-process.ps1')
  if (!fs.existsSync(script)) throw new Error('Application process support is unavailable')
  return script
}
function command(action: string, input: object, resourcesPath?: string) {
  const native = resourcesPath && ['inspect', 'inspect-image', 'inventory', 'session'].includes(action)
    ? windowsStartupHelper(resourcesPath, { ...input, operation: action }) : undefined
  return { executable: native?.executable ?? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: native?.args ?? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', applicationProcessScript(resourcesPath)],
    options: { windowsHide: true, timeout: action === 'terminate' ? 12000 : 7000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SIDEKICK_PROCESS_ACTION: action, SIDEKICK_PROCESS_INPUT: JSON.stringify(input), SIDEKICK_PROCESS_CALLER_PID: String(process.pid), LIB: '', LIBPATH: '' } } }
}
export async function applicationProcessOperation<T>(action: string, input: object, resourcesPath?: string): Promise<T> {
  const task = command(action, input, resourcesPath)
  try { const result = await execute(task.executable, task.args, task.options); return JSON.parse(result.stdout.trim() || 'null') as T }
  catch (error) {
    const failure = operationError(error) as NodeJS.ErrnoException
    if (failure.code !== 'EACCES' || action === 'elevate') throw failure
    const elevated = command('elevate', { action, input }, resourcesPath)
    try { const result = await execute(elevated.executable, elevated.args, { ...elevated.options, timeout: 120000 }); return JSON.parse(result.stdout.trim() || 'null') as T }
    catch (error) { throw operationError(error) }
  }
}
export function applicationProcessOperationSync<T>(action: string, input: object, resourcesPath?: string): T {
  const task = command(action, input, resourcesPath)
  try { return JSON.parse(execFileSync(task.executable, task.args, { ...task.options, encoding: 'utf8' }).trim() || 'null') as T }
  catch (error) { throw operationError(error) }
}

/** The edition endpoint remains restricted to the current account across integrity levels. */
export async function prepareEditionSession(endpoint: string, resourcesPath?: string): Promise<void> {
  if (process.platform !== 'win32' || process.env.SIDEKICK_TEST_SESSION) return
  if (resourcesPath) {
    const task = windowsStartupHelper(resourcesPath, { operation: 'prepare-session', endpoint, server: process.pid })
    await execute(task.executable, task.args, { windowsHide: true, timeout: 10000 })
    return
  }
  const script = path.join(resourcesPath || path.join(process.cwd(), 'resources'), 'windows/startup-task.ps1')
  if (fs.existsSync(script)) {
    await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Request', Buffer.from(JSON.stringify({ operation: 'prepare-session', endpoint, server: process.pid })).toString('base64')],
      { windowsHide: true, timeout: 10000, env: { ...process.env, LIB: '', LIBPATH: '' } })
    return
  }
  await applicationProcessOperation('prepare', { endpoint, server: process.pid }, resourcesPath)
}
