import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { windowsStartupHelper } from '../packages/desktop-common/windows-startup-helper'

const configuration = '<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><loadFromRemoteSources enabled="false"/></runtime></configuration>\n'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-startup-resource-'))
  fs.mkdirSync(path.join(root, 'windows'))
  for (const [name, bytes] of Object.entries({ 'SidekickStartup.exe': 'compiled', 'SidekickStartup.exe.config': configuration,
    'application-process.ps1': 'process-source' })) fs.writeFileSync(path.join(root, 'windows', name), bytes)
  fs.writeFileSync(path.join(root, 'windows/startup-helper.json'), JSON.stringify({ protocol: 1, runtime: 'net-framework-4', architecture: 'anycpu', executable: 'SidekickStartup.exe',
    sha256: sha('compiled'), configSha256: sha(configuration), scripts: { 'application-process.ps1': sha('process-source') } }))
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true }) })

describe('concept startup helper resource identity', () => {
  it.each(['session', 'inspect', 'inspect-image', 'inventory', 'prepare-session'])('binds the exact allowed %s request without a startup-task resource', operation => {
    const input = { operation, pid: process.pid, endpoint: 'pipe', server: process.pid }
    const task = windowsStartupHelper(root, input)
    expect(task.executable).toBe(path.join(root, 'windows/SidekickStartup.exe'))
    expect(JSON.parse(Buffer.from(task.args[0], 'base64').toString())).toEqual(input)
  })

  it.each(['SidekickStartup.exe', 'SidekickStartup.exe.config', 'application-process.ps1'])('refuses altered %s before execution', name => {
    fs.appendFileSync(path.join(root, 'windows', name), 'changed')
    expect(() => windowsStartupHelper(root, { operation: 'session', pid: process.pid })).toThrow('does not match')
  })

  it('refuses an incomplete installed resource set', () => {
    fs.unlinkSync(path.join(root, 'windows/SidekickStartup.exe'))
    expect(() => windowsStartupHelper(root, { operation: 'session', pid: process.pid })).toThrow()
  })

  it('refuses a linked resource', () => {
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isFile: () => true, isSymbolicLink: () => true, size: 1 } as fs.Stats)
    expect(() => windowsStartupHelper(root, { operation: 'inventory' })).toThrow('Invalid Windows startup helper resource')
  })

  it.each(['run', 'terminate', 'elevate', 'probe', 'enable', 'disable'])('rejects %s as an unsupported helper entry', operation => {
    expect(() => windowsStartupHelper(root, { operation })).toThrow('Unsupported Windows startup operation')
  })

  it('rejects an oversized request', () => {
    expect(() => windowsStartupHelper(root, { operation: 'inspect', pid: process.pid, value: 'a'.repeat(16384) })).toThrow('request is too large')
  })
})
