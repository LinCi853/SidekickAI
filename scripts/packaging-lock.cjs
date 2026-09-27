'use strict'

// Cross-process packaging mutex.
//
// One lock file protects every entry point that writes shared build resources
// (release orchestration, the Tauri installer/Setup build, portable packing and
// the plugin build). The lock is held for the complete asynchronous lifetime of
// the protected work, not merely until the first promise is returned.
//
// Safety model
// ------------
// * The lock file names an owner by PID and a random token. Only a confirmed
//   dead owner is reclaimed; indeterminate contents fail closed.
// * Every lock-file creation AND every stale-lock deletion runs inside one
//   short critical section guarded by an exclusive gate file created with an
//   atomic `link`/`O_EXCL` operation. Because only one process can hold the
//   gate, two processes that observe the same dead owner can never interleave
//   "re-read then unlink": the winner deletes the stale file while it holds the
//   gate, and the loser can only re-inspect the lock after that deletion.
//   There is therefore no check/unlink race on the lock file between processes
//   that use this gate: acquisition and reclamation are both serialised by it.
// * The gate is held only across synchronous file operations, never across an
//   `await`, so it is never held for the duration of a build.
// * A gate abandoned by a crashed process is never reclaimed automatically -
//   reclaiming it would require the very compare-and-delete that the gate
//   exists to avoid. It fails closed with an explicit recovery instruction.
//
// Nested owners inside the same process inherit the lock instead of recreating
// it, while unrelated parallel work in the same process is rejected instead of
// deadlocking.
//
// The owner record is:
//   { "pid": 12345, "token": "3b241101-e2bb-4255-8caf-4136c566a962" }
// A child process that inherits `SIDEKICK_PACKAGE_OWNER` may re-enter the same
// lock without owning it, which is how build scripts call other build scripts.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')

const LOCK = path.resolve(__dirname, '../build/packaging.lock')
const DEFAULT_TIMEOUT_MS = 0
const RETRY_MS = 50
const GATE_RETRY_MS = 20
const GATE_TIMEOUT_MS = 10000
const GATE_SUFFIX = '.gate'
const OWNER_ENV = 'SIDEKICK_PACKAGE_OWNER'
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const ownership = new AsyncLocalStorage()
// Lock paths currently owned by this process, so a second concurrent branch in
// the same process is reported instead of deadlocking on its own lock file.
const held = new Map()
// Lock paths whose asynchronous acquisition is in flight. The reservation is
// taken synchronously, before the first await, so two unrelated branches in one
// process cannot both reach the OS-level lock.
const reserved = new Set()

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

function parseOwner(text) {
  const owner = JSON.parse(text)
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null
  if (typeof owner.token !== 'string' || !TOKEN_PATTERN.test(owner.token)) return null
  return { pid: owner.pid, token: owner.token }
}

function ownerIdentity(owner) {
  return `${owner.pid}:${owner.token}`
}

/**
 * Inspect an owner record without touching it. `state` is 'absent', 'owned',
 * 'dead' or 'indeterminate'; only 'dead' is safe to reclaim, and only while the
 * caller holds the gate.
 */
function readOwnerFile(file) {
  let stat
  try { stat = fs.statSync(file, { throwIfNoEntry: false, bigint: true }) } catch { return { state: 'indeterminate', reason: 'cannot inspect the lock file' } }
  if (!stat) return { state: 'absent' }
  if (!stat.isFile()) return { state: 'indeterminate', reason: 'the lock path is not a regular file' }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return { state: 'indeterminate', reason: 'cannot read the lock file' } }
  if (!text.trim()) return { state: 'indeterminate', reason: 'the lock file is empty' }
  let owner
  try { owner = parseOwner(text) } catch { return { state: 'indeterminate', reason: 'the lock file is not valid JSON' } }
  if (!owner) return { state: 'indeterminate', reason: 'the lock file has no valid owner record' }
  return { state: alive(owner.pid) ? 'owned' : 'dead', owner }
}

const readLock = readOwnerFile

/**
 * Atomically publish `contents` at `file`. A hard link is used because it both
 * fails with EEXIST when the target exists and makes the complete contents
 * visible in the same operation, so no reader can ever observe a half-written
 * owner. Filesystems without hard links fall back to an exclusive create plus
 * write; that window is invisible to the gate-serialised readers below.
 */
function createExclusive(file, contents) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, contents, { flag: 'wx' })
  try {
    try {
      fs.linkSync(temporary, file)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error
    }
    let descriptor
    try { descriptor = fs.openSync(file, 'wx') } catch (error) { if (error.code === 'EEXIST') return false; throw error }
    try { fs.writeFileSync(descriptor, contents) } finally { fs.closeSync(descriptor) }
    return true
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}

/** Remove a file only while it still names exactly this pid/token owner. */
function releaseOwnerFile(file, owner) {
  try {
    const state = readOwnerFile(file)
    if (state.state === 'owned' && state.owner.pid === owner.pid && state.owner.token === owner.token) fs.unlinkSync(file)
  } catch (error) {
    // Lock bookkeeping is secondary: never replace the error from the protected
    // work, and never delete a file whose ownership can no longer be proven.
    console.warn(`[packaging-lock] Could not release ${file}: ${error.message}`)
  }
}

/**
 * Run `action` while holding the short-lived exclusive gate for `lock`.
 * `action` must be synchronous: the gate exists to serialise compare-and-delete
 * sequences, and holding it across an await would reintroduce interleaving.
 */
async function withGate(lock, action) {
  const gate = `${lock}${GATE_SUFFIX}`
  const owner = { pid: process.pid, token: crypto.randomUUID() }
  const deadline = Date.now() + GATE_TIMEOUT_MS
  for (;;) {
    if (createExclusive(gate, JSON.stringify(owner))) {
      try { return action() } finally { releaseOwnerFile(gate, owner) }
    }
    const state = readOwnerFile(gate)
    if (state.state === 'absent') continue
    if (state.state === 'indeterminate') throw new Error(`Packaging lock gate needs manual recovery: ${gate} (${state.reason})`)
    if (!alive(state.owner.pid)) {
      throw new Error(`Packaging lock gate was abandoned by stopped process PID ${state.owner.pid} and is never reclaimed automatically; confirm no packaging process is running and remove ${gate}`)
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the packaging lock gate: ${gate}`)
    await new Promise(resolve => setTimeout(resolve, GATE_RETRY_MS))
  }
}

/**
 * One acquisition attempt. MUST run under the gate: the stale-lock deletion is
 * only race-free because no other process can create a new lock between the
 * read and the unlink.
 */
function acquireAttempt(lock) {
  const owner = { pid: process.pid, token: crypto.randomUUID() }
  if (createExclusive(lock, JSON.stringify(owner))) return { acquired: true, owner }
  const state = readLock(lock)
  if (state.state === 'absent') return { retry: true }
  if (state.state === 'indeterminate') return { fail: `Packaging lock needs inspection and was not reclaimed: ${lock} (${state.reason})` }
  if (state.state === 'dead') {
    try { fs.unlinkSync(lock) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { retry: true }
  }
  return { busy: state.owner.pid }
}

async function acquire(lock, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Packaging lock timeout must be a nonnegative number of milliseconds')
  const deadline = Date.now() + timeoutMs
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  for (;;) {
    const outcome = await withGate(lock, () => acquireAttempt(lock))
    if (outcome.acquired) return outcome.owner
    if (outcome.fail) throw new Error(outcome.fail)
    if (outcome.retry) continue
    if (Date.now() >= deadline) throw new Error(`Another packaging process is active (PID ${outcome.busy}): ${lock}`)
    await new Promise(resolve => setTimeout(resolve, RETRY_MS))
  }
}

/** Owner identity inherited from an ancestor process, but only while it is current. */
function inheritedOwner(lock) {
  const value = process.env[OWNER_ENV]
  if (typeof value !== 'string' || !value.includes(':')) return null
  const separator = value.lastIndexOf(':')
  const pid = Number(value.slice(0, separator))
  const token = value.slice(separator + 1)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !TOKEN_PATTERN.test(token)) return null
  const state = readLock(lock)
  if (state.state === 'owned' && state.owner.pid === pid && state.owner.token === token) return { pid, token }
  return null
}

/** Release the lock only while this process still owns exactly these bytes. */
function release(lock, owner) {
  releaseOwnerFile(lock, owner)
}

/**
 * Run `work` while holding the packaging lock. The lock is held until the
 * returned promise settles. An inherited owner or an already-owning async
 * context runs the work directly; unrelated concurrent work is rejected.
 */
function withPackagingLock(work, options) {
  const settings = typeof options === 'string' || options === undefined ? { lock: options } : options || {}
  const lock = path.resolve(settings.lock || LOCK)
  const run = async () => {
    const context = ownership.getStore()
    if (context && context.held.has(lock)) return work()
    if (held.has(lock) || reserved.has(lock)) throw new Error(`Packaging is already running in this process and cannot be started twice in parallel: ${lock}`)
    reserved.add(lock)
    const previousOwner = process.env[OWNER_ENV]
    try {
      const inherited = inheritedOwner(lock)
      if (inherited) {
        held.set(lock, inherited)
        const nested = new Map(context ? context.held : [[lock, inherited]])
        nested.set(lock, inherited)
        try {
          return await ownership.run({ held: nested }, () => work())
        } finally {
          held.delete(lock)
          if (previousOwner === undefined) delete process.env[OWNER_ENV]
          else process.env[OWNER_ENV] = previousOwner
        }
      }
      const owner = await acquire(lock, settings.timeoutMs)
      held.set(lock, owner)
      const nested = new Map(context ? context.held : [])
      nested.set(lock, owner)
      process.env[OWNER_ENV] = ownerIdentity(owner)
      try {
        return await ownership.run({ held: nested }, () => work())
      } finally {
        held.delete(lock)
        release(lock, owner)
        if (previousOwner === undefined) delete process.env[OWNER_ENV]
        else process.env[OWNER_ENV] = previousOwner
      }
    } finally {
      reserved.delete(lock)
    }
  }
  return run()
}

/** Introspection for diagnostics and tests: which lock does this context hold? */
function lockOwnership(lock = LOCK) {
  const resolved = path.resolve(lock)
  const context = ownership.getStore()
  const owner = (context && context.held.get(resolved)) || held.get(resolved)
  return { held: Boolean(owner), owner: owner || null, token: owner ? owner.token : null }
}

module.exports = { withPackagingLock, lockOwnership, OWNER_ENV, GATE_SUFFIX }
