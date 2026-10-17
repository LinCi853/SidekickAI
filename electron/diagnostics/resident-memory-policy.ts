const MiB = 1024 * 1024
const GiB = 1024 * MiB
export interface ResidentProcess { pid: number; creationTime: number; type: string; workingSetBytes: number; privateBytes: number; cpuPercent: number; lastActivityAt?: number; protected?: boolean }
export interface ResidentSample { now: number; totalPhysicalBytes: number; availablePhysicalBytes: number; lastActivityAt: number; protected: boolean; workingSetBudgetBytes?: number; processes: ResidentProcess[] }
export interface ResidentCandidate { pid: number; creationTime: number; maxBytes: number; idleMs: number; reason: 'startup' | 'low-memory' | 'idle' }
export interface ResidentResult { beforeBytes: number; afterBytes: number; durationMs: number }
interface History { successes: number; lastAttempt: number; cooldown: number; afterBytes: number; beforeBytes: number; strikes: number; reboundObserved: boolean; completed: boolean }
const MAX_COOLDOWN_MS = 15 * 60000
// Percent of one CPU core. Quiet browser-process housekeeping was measured at
// ~0.6%; a 0.5% cutoff excluded it indefinitely despite long application idle.
// Recent input, loading and protected tasks remain independent requirements.
const MAX_IDLE_CPU_PERCENT = 1
const key = (p: { pid: number; creationTime: number }) => String(p.pid) + ':' + p.creationTime
export function createResidentMemoryPolicy() {
  const history = new Map<string, History>()
  let startedAt: number | undefined
  return {
    select(sample: ResidentSample): ResidentCandidate | null {
      if (![sample.now, sample.lastActivityAt, sample.totalPhysicalBytes, sample.availablePhysicalBytes].every(Number.isFinite) || sample.totalPhysicalBytes <= 0 || sample.availablePhysicalBytes < 0) return null
      startedAt ??= sample.now
      const alive = new Set(sample.processes.map(key))
      for (const id of history.keys()) if (!alive.has(id)) history.delete(id)
      const lowMemory = sample.totalPhysicalBytes <= 8 * GiB || sample.availablePhysicalBytes < Math.max(GiB, sample.totalPhysicalBytes * 0.15)
      const startup = sample.now - startedAt < 120000
      const idleMs = lowMemory ? 15000 : startup ? 20000 : 30000
      if (sample.protected) return null
      const candidates: ResidentProcess[] = []
      for (const p of sample.processes) {
        if (p.protected) continue
        const activityAt = p.lastActivityAt ?? sample.lastActivityAt
        if (!Number.isFinite(activityAt) || sample.now - activityAt < idleMs) continue
        if (!Number.isInteger(p.pid) || p.pid <= 0 || !Number.isFinite(p.creationTime) || p.creationTime <= 0 || !Number.isFinite(p.workingSetBytes) || !Number.isFinite(p.cpuPercent) || p.cpuPercent > MAX_IDLE_CPU_PERCENT || p.cpuPercent < 0) continue
        const h = history.get(key(p))
        if (h?.completed && !h.reboundObserved && sample.now - h.lastAttempt < 30000 && p.workingSetBytes > Math.max(h.afterBytes + 32 * MiB, h.beforeBytes * 0.8)) {
          h.reboundObserved = true
          h.strikes += 1
          h.cooldown = Math.min(MAX_COOLDOWN_MS, 60000 * 2 ** h.strikes)
          // Assess each reclaim once; subsequent samples must not count the same rebound.
        }
        if (h && sample.now - h.lastAttempt < h.cooldown) continue
        if (p.workingSetBytes > 32 * MiB) candidates.push(p)
      }
      const p = candidates.sort((a, b) => b.workingSetBytes - a.workingSetBytes)[0]
      if (!p) return null
      const candidate: ResidentCandidate = { pid: p.pid, creationTime: p.creationTime, maxBytes: Math.max(48 * MiB, Math.floor(p.workingSetBytes * 0.45)), idleMs, reason: lowMemory ? 'low-memory' : startup ? 'startup' : 'idle' }
      const previous = history.get(key(p))
      const budget = sample.workingSetBudgetBytes ?? 256 * MiB
      const withinBudget = Number.isFinite(budget) && budget > 0 && sample.processes.reduce((total, process) => total + process.workingSetBytes, 0) <= budget
      // A reservation is short: a native skip (new input, process exit, etc.)
      // must not consume the minutes-long cooldown of a successful reclaim.
      const strikes = Math.max(0, (previous?.strikes ?? 0) - (previous?.completed && !previous.reboundObserved ? 1 : 0))
      history.set(key(p), { successes: withinBudget ? previous?.successes ?? 0 : 0, lastAttempt: sample.now, cooldown: 30000, afterBytes: p.workingSetBytes, beforeBytes: p.workingSetBytes, strikes, reboundObserved: false, completed: false })
      return candidate
    },
    recordResult(candidate: ResidentCandidate, result: ResidentResult, now: number) {
      const h = history.get(key(candidate))
      if (!h || ![result.beforeBytes, result.afterBytes, result.durationMs, now].every(Number.isFinite) || result.beforeBytes < 0 || result.afterBytes < 0 || result.durationMs < 0) return
      h.completed = true
      h.reboundObserved = false
      h.lastAttempt = now
      h.beforeBytes = result.beforeBytes
      h.afterBytes = result.afterBytes
      const saved = result.beforeBytes - result.afterBytes
      if (saved >= 8 * MiB) {
        h.successes += 1
        // A 10–20 ms native call is not evidence of an input stall. Increase
        // spacing gradually; never permanently retire a PID after one call.
        h.cooldown = Math.min(MAX_COOLDOWN_MS, 60000 * 2 ** Math.min(4, h.successes - 1))
      } else {
        h.cooldown = MAX_COOLDOWN_MS
      }
      if (result.durationMs > 100) h.cooldown = Math.max(h.cooldown, 120000)
    },
  }
}
