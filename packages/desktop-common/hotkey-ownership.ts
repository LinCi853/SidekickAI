import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export interface HotkeyLease {
  readonly key: string
  readonly active: boolean
  release(): void
}

export function canonicalHotkey(accelerator: string): string {
  const aliases: Record<string, string> = {
    ctrl: 'control', option: 'alt', cmd: 'super', command: 'super', meta: 'super', win: 'super', windows: 'super',
    commandorcontrol: process.platform === 'darwin' ? 'super' : 'control',
    cmdorctrl: process.platform === 'darwin' ? 'super' : 'control',
    esc: 'escape', return: 'enter', spacebar: 'space',
    arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    minus: '-', equal: '=', comma: ',', period: '.', slash: '/', semicolon: ';', quote: "'",
    backtick: '`', backquote: '`', bracketleft: '[', bracketright: ']', backslash: '\\',
  }
  if (!accelerator || accelerator.length > 128) throw new Error('Invalid shortcut accelerator')
  const tokens = accelerator.toLowerCase().split('+').map(token => aliases[token.trim()] || token.trim())
  const modifiers = ['control', 'alt', 'shift', 'super']
  const keys = tokens.filter(token => !modifiers.includes(token))
  if (keys.length !== 1 || !keys[0]) throw new Error('A shortcut requires exactly one key')
  return [...modifiers.filter(modifier => tokens.includes(modifier)), keys[0]].join('+')
}

let interactiveNamespace: string | undefined
function defaultNamespace(): string {
  if (process.env.SIDEKICK_TEST_SESSION) return `test:${process.env.SIDEKICK_TEST_SESSION}`
  if (interactiveNamespace) return interactiveNamespace
  let session = process.env.XDG_SESSION_ID || process.env.DISPLAY || 'desktop'
  if (process.platform === 'win32') {
    session = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    if (!/^\d+$/.test(session)) throw new Error('Cannot identify the interactive session')
  }
  interactiveNamespace = `${os.homedir().toLowerCase()}|${session}`
  return interactiveNamespace
}

export function hotkeyOwnershipEndpoint(accelerator: string, namespace = defaultNamespace()): string {
  const hash = createHash('sha256').update(`${namespace}|${canonicalHotkey(accelerator)}`).digest('hex').slice(0, 32)
  return process.platform === 'win32' ? `\\\\.\\pipe\\sidekick-hotkey-${hash}` : path.join(os.tmpdir(), `sidekick-hotkey-${hash}.sock`)
}

interface Claim {
  owner: string
  server: net.Server
  references: number
  active: boolean
}

/** A kernel-owned endpoint arbitrates both OS registrations and hook fallbacks. */
export class HotkeyOwnership {
  private readonly claims = new Map<string, Claim>()

  constructor(private readonly namespace?: string) {}

  acquire(accelerator: string, owner: string): HotkeyLease | null {
    const key = canonicalHotkey(accelerator)
    let claim = this.claims.get(key)
    if (claim) {
      if (claim.owner !== owner || !claim.active || !claim.server.listening) return null
    } else {
      const server = net.createServer(socket => socket.destroy())
      const record: Claim = { owner, server, references: 0, active: false }
      server.on('error', () => this.releaseClaim(key, record))
      try {
        server.listen({ path: hotkeyOwnershipEndpoint(key, this.namespace), exclusive: true })
        // Named-pipe binding is synchronous; failures emit an error on the next tick.
        if (!server.listening) { server.close(() => {}); return null }
        server.unref()
      } catch {
        server.close(() => {})
        return null
      }
      record.active = true
      this.claims.set(key, record)
      claim = record
    }
    claim.references += 1
    const record = claim
    let released = false
    return {
      key,
      get active() { return !released && record.active && record.server.listening },
      release: () => {
        if (released) return
        released = true
        record.references -= 1
        if (record.references === 0) this.releaseClaim(key, record)
      },
    }
  }

  private releaseClaim(key: string, claim: Claim): void {
    claim.active = false
    if (this.claims.get(key) === claim) this.claims.delete(key)
    claim.server.close(() => {})
  }

  retain(accelerator: string): HotkeyLease | null {
    const claim = this.claims.get(canonicalHotkey(accelerator))
    return claim ? this.acquire(accelerator, claim.owner) : null
  }

  close(): void {
    for (const [key, claim] of this.claims) this.releaseClaim(key, claim)
  }
}
