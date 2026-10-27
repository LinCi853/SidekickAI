import { app, BrowserWindow, webContents, type WebContents } from 'electron'
import { trimWorkingSet, markForegroundActivity } from '../platform/window/win32-foreground.js'
import { createResidentMemoryPolicy } from './resident-memory-policy.js'
import { backgroundWindowForProcess } from './resident-process-ownership.js'

const POLL_MS = 5000
// A standard window normally has five Electron processes. Cover them in the
// same idle opportunity; the time budget and per-call activity checks still
// end a batch as soon as the application becomes active.
const MAX_RECLAIMS_PER_TICK = 8
const RECLAIM_BATCH_MS = 150
const MiB = 1024 * 1024

/** 全后台裁剪的本地空闲下限（全后台 30/60 秒后触发，窗口保持挂载） */
const ALL_BACKGROUND_TRIM_IDLE_MS = 15_000

type BackgroundTrimmer = { backgroundTrim: () => Promise<void> }
let activeTrimmer: BackgroundTrimmer | null = null

/**
 * 全部窗口进入后台后的一次性轻释放：仅工作集裁剪，不关窗、不卸页、不打断
 * 出声/下载/录制（保护与本地空闲复查照常）。低内存开关不决定是否执行，
 * 只影响触发时长（见 shared/background-policy.allBackgroundTrimDelayMs）。
 */
export function trimBackgroundWorkingSets(): void {
  void activeTrimmer?.backgroundTrim()
}

function workingSetBudgetBytes(): number {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  const browsers = windows.filter((window) => {
    try {
      return new URL(window.webContents.getURL()).searchParams.get('mode') === 'browser'
    } catch {
      return false
    }
  }).length
  // Leave room for the native bridge and processes outside getAppMetrics.
  // Ten browser windows may use GiB; a fixed single-window target would keep
  // clearing them every minute even when comfortably inside their own budget.
  return (256 + Math.max(0, windows.length - browsers - 1) * 80 + browsers * 450) * MiB
}

export function createResidentMemoryMonitor(
  isProtected: () => boolean,
  readEnabled: () => boolean = () => true,
) {
  const enabled = process.env.SIDEKICK_RESIDENT_RECLAIM !== '0'
  const policy = createResidentMemoryPolicy()
  let stopped = false
  let running = false
  let lastActivityAt = Date.now()
  const contentActivity = new WeakMap<WebContents, number>()
  const windowActivity = new WeakMap<BrowserWindow, number>()
  const playingMedia = new WeakMap<WebContents, number>()
  const samples: unknown[] = []
  const actions: unknown[] = []
  const cpuSamples = new Map<string, { at: number; seconds: number }>()
  const cleanups = new Set<() => void>()
  const activity = () => {
    lastActivityAt = Date.now()
    markForegroundActivity()
  }
  const localActivityAt = (pid: number, window: BrowserWindow): number => {
    let at = windowActivity.get(window) ?? Date.now()
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.getOSProcessId() === pid)
        at = Math.max(at, contentActivity.get(contents) ?? Date.now())
    }
    return at
  }
  const attachContents = (contents: WebContents) => {
    // Muted video can be playing while isCurrentlyAudible() is false. Count
    // players so pausing one does not release another player's protection.
    const onMediaStarted = () => {
      playingMedia.set(contents, (playingMedia.get(contents) ?? 0) + 1)
    }
    const onMediaPaused = () => {
      playingMedia.set(contents, Math.max(0, (playingMedia.get(contents) ?? 0) - 1))
    }
    const onRendererGone = () => {
      playingMedia.delete(contents)
    }
    const onActivity = () => {
      const now = Date.now()
      contentActivity.set(contents, now)
      // Scrolling an unfocused guest also protects its shell and sibling
      // renderers. Local idle belongs to the whole window, not just one frame.
      try {
        const owner = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)
        if (owner && !owner.isDestroyed()) windowActivity.set(owner, now)
      } catch {
        /* A disappearing or unknown owner keeps global protection. */
      }
      activity()
    }
    contentActivity.set(contents, Date.now())
    contents.on('input-event', onActivity)
    contents.on('before-input-event', onActivity)
    contents.on('did-start-loading', onActivity)
    contents.on('media-started-playing', onMediaStarted)
    contents.on('media-paused', onMediaPaused)
    contents.on('render-process-gone', onRendererGone)
    const cleanup = () => {
      if (!contents.isDestroyed()) {
        contents.off('input-event', onActivity)
        contents.off('before-input-event', onActivity)
        contents.off('did-start-loading', onActivity)
        contents.off('media-started-playing', onMediaStarted)
        contents.off('media-paused', onMediaPaused)
        contents.off('render-process-gone', onRendererGone)
        contents.off('destroyed', onDestroyed)
      }
    }
    const onDestroyed = () => {
      cleanups.delete(cleanup)
    }
    contents.once('destroyed', onDestroyed)
    cleanups.add(cleanup)
  }
  for (const contents of webContents.getAllWebContents()) attachContents(contents)
  const onContents = (_event: Electron.Event, contents: WebContents) => attachContents(contents)
  app.on('web-contents-created', onContents)
  cleanups.add(() => app.off('web-contents-created', onContents))
  const attachWindow = (window: BrowserWindow) => {
    const onActivity = () => {
      windowActivity.set(window, Date.now())
      activity()
    }
    windowActivity.set(window, Date.now())
    window.on('focus', onActivity)
    window.on('show', onActivity)
    window.on('restore', onActivity)
    window.on('resize', onActivity)
    window.on('move', onActivity)
    const cleanup = () => {
      window.off('focus', onActivity)
      window.off('show', onActivity)
      window.off('restore', onActivity)
      window.off('resize', onActivity)
      window.off('move', onActivity)
      window.off('closed', onClosed)
    }
    const onClosed = () => {
      cleanups.delete(cleanup)
    }
    window.once('closed', onClosed)
    cleanups.add(cleanup)
  }
  for (const window of BrowserWindow.getAllWindows()) attachWindow(window)
  const onWindow = (_event: Electron.Event, window: BrowserWindow) => attachWindow(window)
  app.on('browser-window-created', onWindow)
  cleanups.add(() => app.off('browser-window-created', onWindow))

  const readContentProtection = () =>
    webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed())
      .map((c) => {
        let windowId: number | null = null
        try {
          const owner = BrowserWindow.fromWebContents(c.hostWebContents ?? c)
          if (owner && !owner.isDestroyed()) windowId = owner.id
        } catch {
          /* Unknown ownership keeps shared protection. */
        }
        return {
          id: c.id,
          pid: c.getOSProcessId(),
          guest: c.getType() === 'webview',
          windowId,
          loading: c.isLoading(),
          audible: c.isCurrentlyAudible(),
          captured: c.isBeingCaptured(),
          playingMedia: playingMedia.get(c) ?? 0,
        }
      })
  const protectsProcess = (
    contents: ReturnType<typeof readContentProtection>,
    pid: number,
    background: BrowserWindow | null,
  ) => {
    const matches = contents.filter((c) => c.pid === pid)
    const guestOnly = matches.length > 0 && matches.every((c) => c.guest)
    return contents.some(
      (c) =>
        (c.loading || c.audible || c.captured || c.playingMedia > 0) &&
        // Shared GPU/services and a window's shell still participate in media
        // and loading. A separate guest renderer does not; its own protection,
        // whole-window input idle and CPU checks remain mandatory. Unknown or
        // mixed ownership is never given that exemption.
        (!background ||
          c.windowId === null ||
          (c.windowId === background.id && (!guestOnly || !c.guest || c.pid === pid))),
    )
  }

  const tick = async () => {
    if (!enabled || !readEnabled() || stopped || running || process.platform !== 'win32') return
    running = true
    try {
      const now = Date.now()
      const system = process.getSystemMemoryInfo()
      const metrics = app.getAppMetrics()
      const protection = { application: isProtected(), contents: readContentProtection() }
      // getAppMetrics percentCPUUsage is relative to ANY previous caller. Other
      // monitors and IPC can reset that interval; use our own cumulative deltas.
      const alive = new Set<string>()
      const processes = metrics.map((m) => {
        const id = m.pid + ':' + m.creationTime
        alive.add(id)
        const previous = cpuSamples.get(id)
        const seconds = m.cpu.cumulativeCPUUsage ?? Number.NaN
        const cpuPercent =
          previous && now > previous.at && seconds >= previous.seconds
            ? ((seconds - previous.seconds) * 100000) / (now - previous.at)
            : Number.POSITIVE_INFINITY
        if (Number.isFinite(seconds)) cpuSamples.set(id, { at: now, seconds })
        const background = m.type === 'Tab' ? backgroundWindowForProcess(m.pid) : null
        return {
          pid: m.pid,
          creationTime: m.creationTime,
          type: m.type,
          workingSetBytes: m.memory.workingSetSize * 1024,
          privateBytes: (m.memory.privateBytes ?? 0) * 1024,
          cpuPercent,
          protected: protectsProcess(protection.contents, m.pid, background),
          ...(background ? { lastActivityAt: localActivityAt(m.pid, background) } : {}),
        }
      })
      for (const id of cpuSamples.keys()) if (!alive.has(id)) cpuSamples.delete(id)
      const sample = {
        now,
        totalPhysicalBytes: system.total * 1024,
        availablePhysicalBytes: system.free * 1024,
        lastActivityAt,
        protected: protection.application,
        protection,
        workingSetBudgetBytes: workingSetBudgetBytes(),
        processes,
      }
      samples.push(sample)
      if (samples.length > 60) samples.shift()
      // Clear a small idle batch, as an empty-working-set operation normally
      // covers several processes. Five seconds between every PID used to leave
      // most of the application resident before the next user interaction.
      // Native calls remain serial and every PID gets fresh activity checks.
      const batchSample = { ...sample, processes: processes.map((p) => ({ ...p })) }
      for (let count = 0; count < MAX_RECLAIMS_PER_TICK; count += 1) {
        batchSample.now = Date.now()
        const candidate = policy.select(batchSample)
        if (!candidate || stopped || !readEnabled() || isProtected()) return
        const targetType = metrics.find((metric) => metric.pid === candidate.pid)?.type
        const background = targetType === 'Tab' ? backgroundWindowForProcess(candidate.pid) : null
        if (protectsProcess(readContentProtection(), candidate.pid, background)) continue
        const activeAt = background ? localActivityAt(candidate.pid, background) : lastActivityAt
        if (Date.now() - activeAt < candidate.idleMs) return
        const result = await trimWorkingSet(
          candidate.pid,
          candidate.creationTime,
          candidate.maxBytes,
          candidate.idleMs,
          background ?? undefined,
        )
        if (stopped) return
        if (result) {
          policy.recordResult(candidate, result, Date.now())
          const target = batchSample.processes.find(
            (p) => p.pid === candidate.pid && p.creationTime === candidate.creationTime,
          )
          if (target) target.workingSetBytes = result.afterBytes
        }
        actions.push({ at: Date.now(), candidate, result })
        if (actions.length > 60) actions.shift()
        if (Date.now() - now >= RECLAIM_BATCH_MS) break
      }
    } catch (error) {
      console.warn('[resident-memory] Sampling or reclaim failed:', error)
    } finally {
      running = false
    }
  }
  /**
   * 全后台轻释放：只裁剪属于「无焦点窗口」的渲染进程工作集。
   * 保护（出声/下载/录制/导入等）与本地空闲复查照常执行；
   * 不受低内存开关与回收冷却限制——进入后台本就是一次性时机。
   */
  const backgroundTrim = async () => {
    if (stopped || process.platform !== 'win32') return
    try {
      if (isProtected()) return
      const contents = readContentProtection()
      for (const m of app.getAppMetrics()) {
        if (stopped || isProtected()) return
        if (m.type !== 'Tab') continue
        const background = backgroundWindowForProcess(m.pid)
        if (!background) continue
        if (protectsProcess(contents, m.pid, background)) continue
        if (Date.now() - localActivityAt(m.pid, background) < ALL_BACKGROUND_TRIM_IDLE_MS) continue
        await trimWorkingSet(
          m.pid,
          m.creationTime,
          Number.MAX_SAFE_INTEGER,
          ALL_BACKGROUND_TRIM_IDLE_MS,
          background,
        )
      }
    } catch (error) {
      console.warn('[resident-memory] background trim failed:', error)
    }
  }
  const timer = setInterval(() => {
    void tick()
  }, POLL_MS)
  timer.unref()

  const diagnostics = () => ({
    samples: [...samples],
    actions: [...actions],
    stopped,
    enabled: enabled && readEnabled(),
    lastActivityAt,
  })
  const diagnosticApp = app as typeof app & { __residentMemoryDiagnostics?: typeof diagnostics }
  diagnosticApp.__residentMemoryDiagnostics = diagnostics
  const monitor = {
    diagnostics,
    tick,
    backgroundTrim,
    stop: () => {
      stopped = true
      clearInterval(timer)
      for (const cleanup of [...cleanups]) cleanup()
      cleanups.clear()
      cpuSamples.clear()
      if (activeTrimmer === monitor) activeTrimmer = null
      if (diagnosticApp.__residentMemoryDiagnostics === diagnostics)
        delete diagnosticApp.__residentMemoryDiagnostics
    },
  }
  activeTrimmer = monitor
  return monitor
}
