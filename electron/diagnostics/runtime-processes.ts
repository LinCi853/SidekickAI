import { app, BrowserWindow, ipcMain, webContents, type ProcessMetric } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { RuntimeProcessRole, RuntimeProcessSnapshot, RuntimeProcessTarget } from '../shared/runtime-processes.js'
import { assertTrustedRenderer } from '../security/trusted-renderer.js'

function processTargets(): Map<number, RuntimeProcessTarget[]> {
  const targets = new Map<number, RuntimeProcessTarget[]>()
  const guestHosts = new Map<number, Set<number>>()
  const add = (pid: number, target: RuntimeProcessTarget, hostId?: number) => {
    if (pid <= 0) return
    const entries = targets.get(pid) ?? []
    if (!entries.some(entry => entry.webContentsId === target.webContentsId && entry.kind === target.kind)) entries.push(target)
    targets.set(pid, entries)
    if (hostId !== undefined) {
      const hosts = guestHosts.get(pid) ?? new Set<number>()
      hosts.add(hostId)
      guestHosts.set(pid, hosts)
    }
  }
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed()) continue
      const guest = contents.getType() === 'webview'
      const host = contents.hostWebContents ?? contents
      const window = BrowserWindow.fromWebContents(host)
      let title = contents.getTitle().trim().slice(0, 200)
      if (!title && guest) {
        try { title = new URL(contents.getURL()).hostname } catch { /* A guest may not have navigated yet. */ }
      }
      const target: RuntimeProcessTarget = {
        webContentsId: contents.id,
        kind: guest ? 'webpage' : 'window',
        title,
        windowTitle: window && !window.isDestroyed() ? window.getTitle().trim().slice(0, 200) : '',
      }
      const pid = contents.getOSProcessId()
      const hostId = guest ? contents.hostWebContents?.id : undefined
      add(pid, target, hostId)
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (frame.osProcessId !== pid) add(frame.osProcessId, { ...target, kind: 'subframe' }, hostId)
      }
    } catch { /* Web contents can disappear or change processes during a snapshot. */ }
  }
  // Embedded guests also appear in the host's frame tree; prefer their own page identity.
  for (const [pid, entries] of targets) {
    const hosts = guestHosts.get(pid)
    if (hosts) targets.set(pid, entries.filter(entry => entry.kind !== 'subframe' || !hosts.has(entry.webContentsId)))
  }
  return targets
}

function processRole(metric: ProcessMetric, targets: RuntimeProcessTarget[]): RuntimeProcessRole {
  if (metric.type === 'Browser') return 'main'
  if (metric.type === 'GPU') return 'gpu'
  if (metric.type === 'Tab') {
    if (targets.length && targets.every(target => target.kind === 'window')) return 'interface'
    if (targets.length && targets.every(target => target.kind !== 'window')) return 'webpage'
    return 'renderer'
  }
  if (metric.type === 'Utility') {
    const name = (metric.serviceName || metric.name || '').toLowerCase()
    if (name.includes('network')) return 'network'
    if (name.includes('audio')) return 'audio'
    if (name.includes('video')) return 'video'
    return 'utility'
  }
  return 'other'
}

const nonnegative = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function getRuntimeProcessSnapshot(): RuntimeProcessSnapshot {
  const targets = processTargets()
  const processes = app.getAppMetrics().map(metric => {
    const associated = targets.get(metric.pid) ?? []
    const memory = nonnegative(metric.memory.workingSetSize)
    return {
      pid: metric.pid,
      creationTime: metric.creationTime,
      role: processRole(metric, associated),
      name: metric.type === 'Browser' ? app.getName() : metric.name || metric.serviceName || '',
      targets: associated,
      cpuPercent: nonnegative(metric.cpu.percentCPUUsage),
      memoryBytes: memory === null ? null : memory * 1024,
    }
  })
  processes.sort((left, right) => Number(right.role === 'main') - Number(left.role === 'main') || left.pid - right.pid)
  return { capturedAt: Date.now(), processes }
}

export function registerRuntimeProcessesIPC(): void {
  ipcMain.handle(IPC_CHANNELS.RUNTIME_PROCESSES_GET, event => {
    assertTrustedRenderer(event)
    return getRuntimeProcessSnapshot()
  })
}
