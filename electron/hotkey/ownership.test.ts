import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { once } from 'node:events'
import ts from 'typescript'
import { canonicalHotkey, HotkeyOwnership } from '../../packages/desktop-common/hotkey-ownership'

let namespace: string
const owners: HotkeyOwnership[] = []
const children: ChildProcess[] = []
let directory: string | undefined
beforeEach(() => { namespace = `ownership-test-${process.pid}-${Math.random()}` })
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.close()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  if (directory) { fs.rmSync(directory, { recursive: true, force: true }); directory = undefined }
  vi.restoreAllMocks()
})
function owner(scope = namespace) {
  const value = new HotkeyOwnership(scope)
  owners.push(value)
  return value
}

describe('kernel-owned shortcut leases', () => {
  it('normalizes aliases and modifier ordering', () => {
    expect(canonicalHotkey('Shift+Ctrl+Option+Return')).toBe(canonicalHotkey('Alt+Control+Shift+Enter'))
    expect(canonicalHotkey('Win+Spacebar')).toBe(canonicalHotkey('Super+Space'))
    expect(canonicalHotkey('Alt+Minus')).toBe(canonicalHotkey('Option+-'))
  })
  it('keeps a lease until its final owned reference is released', () => {
    const first = owner(), other = owner()
    const a = first.acquire('Alt+Space', 'application')!, b = first.retain('Option+Spacebar')!
    expect(a.active && b.active).toBe(true)
    expect(first.acquire('Alt+Space', 'different-binding')).toBeNull()
    a.release()
    expect(other.acquire('Alt+Space', 'peer')).toBeNull()
    b.release()
    const next = other.acquire('Alt+Space', 'peer')!
    expect(next.active).toBe(true)
    a.release(); b.release()
    expect(next.active).toBe(true)
  })
  it('isolates interactive namespaces', () => {
    const a = owner().acquire('Alt+Q', 'application')!
    const b = owner(`${namespace}-other-session`).acquire('Alt+Q', 'application')!
    expect(a.active && b.active).toBe(true)
  })
  it('does not let an asynchronous bind error dispose a later acquired claim', async () => {
    const first = owner(), second = owner()
    const initial = first.acquire('Alt+Q', 'first')!
    expect(second.acquire('Alt+Q', 'second')).toBeNull()
    initial.release()
    const next = second.acquire('Alt+Q', 'second')!
    await new Promise(resolve => setImmediate(resolve))
    expect(next.active).toBe(true)
  })
  it('invalidates callbacks and releases the endpoint after a listener error', () => {
    const create = vi.spyOn(net, 'createServer')
    const first = owner(), second = owner()
    const lease = first.acquire('Alt+Q', 'first')!
    const server = create.mock.results.at(-1)!.value as net.Server
    server.emit('error', new Error('Listener fixture failure'))
    expect(lease.active).toBe(false)
    expect(second.acquire('Alt+Q', 'second')?.active).toBe(true)
  })
  it('arbitrates separate Windows processes and releases the endpoint after process termination', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-hotkey-process-'))
    const source = fs.readFileSync(path.resolve('packages/desktop-common/hotkey-ownership.ts'), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const childFile = path.join(directory, 'owner.cjs')
    fs.writeFileSync(childFile, compiled + '\nconst owner = new exports.HotkeyOwnership(process.argv[2]); const lease = owner.acquire("Alt+Q", "child"); process.on("message", () => {}); process.send({active: !!lease?.active});\n')
    const options: ForkOptions & { windowsHide: boolean } = { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }
    const child = fork(childFile, [namespace], options)
    children.push(child)
    const [result] = await once(child, 'message')
    expect(result).toEqual({ active: true })
    const peer = owner()
    expect(peer.acquire('Option+Q', 'parent')).toBeNull()
    const exited = once(child, 'exit')
    child.kill()
    await exited
    expect(peer.acquire('Option+Q', 'parent')?.active).toBe(true)
  })
})
