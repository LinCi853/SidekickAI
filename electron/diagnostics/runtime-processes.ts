import { app, BrowserWindow, ipcMain, webContents, type ProcessMetric } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { RuntimeProcessRole, RuntimeProcessSnapshot, RuntimeProcessTarget } from '../shared/runtime-processes.js'
import { assertTrustedRenderer } from '../security/trusted-renderer.js'
import { readPrivateWorkingSetBytes } from './private-working-set.js'

function processTargets(): Map<number, RuntimeProcessTarget[]> {
  const targets = new Map<number, RuntimeProcessTarget[]>()
  // 每个 pid 上按 (webContentsId, kind) 去重：一个 webContents 在同一进程里只留一行。
  // 去重必须在这里做——帧树会把同一内容重复列出（同一 guest 的多个子框架落在同一进程），
  // 没有它就会一行变多行，进程信息列表凭空膨胀。
  const add = (pid: number, target: RuntimeProcessTarget) => {
    if (pid <= 0) return
    const entries = targets.get(pid) ?? []
    if (!entries.some(entry => entry.webContentsId === target.webContentsId && entry.kind === target.kind)) entries.push(target)
    targets.set(pid, entries)
  }
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed()) continue
      // 内容身份只看 webContents 类型：webview 是嵌入的网页 guest，其余都是应用界面。
      // 不再依赖帧树反推身份，因此也不存在「宿主帧树里的别名行要事后清理」这一步。
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
      add(pid, target)
      // 只统计 guest 页的 OOPIF：界面窗口的跨源 iframe 不属于网页预算。
      // 也正因为这里只遍历 guest 的帧树，界面窗口永远拿不到 subframe 身份行。
      if (guest) {
        for (const frame of contents.mainFrame.framesInSubtree) {
          if (frame.osProcessId !== pid) add(frame.osProcessId, { ...target, kind: 'subframe' })
        }
      }
    } catch { /* Web contents can disappear or change processes during a snapshot. */ }
  }
  return targets
}

/**
 * 角色由进程承载的内容决定。
 * 参与网页预算的是 `webpage` 与 `mixed`：一个进程里既跑界面又跑网页时不能
 * 简单归为界面，否则这块内存会整体漏出预算统计，驱逐压力恒低于真实值。
 */
function processRole(metric: ProcessMetric, targets: RuntimeProcessTarget[]): RuntimeProcessRole {
  if (metric.type === 'Browser') return 'main'
  if (metric.type === 'GPU') return 'gpu'
  if (metric.type === 'Tab') {
    if (!targets.length) return 'renderer'
    const hasWindow = targets.some(target => target.kind === 'window')
    const hasPage = targets.some(target => target.kind === 'webpage')
    const hasSubframe = targets.some(target => target.kind === 'subframe')
    // 界面进程里另起进程的跨源子框架（OOPIF）仍属界面，不计入网页预算；
    // 真正的网页面与界面同进程时才升格为 mixed。
    if (hasWindow) return hasPage ? 'mixed' : 'interface'
    // subframe 行只由 guest 的帧树产生：独占该进程的 OOPIF 是网页内容的一部分
    return hasPage || hasSubframe ? 'webpage' : 'renderer'
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

export async function getRuntimeProcessSnapshot(): Promise<RuntimeProcessSnapshot> {
  const targets = processTargets()
  const processes = app.getAppMetrics().map(metric => {
    const associated = targets.get(metric.pid) ?? []
    // 含共享页工作集仅作专用工作集不可用时的回退，避免设置页在查询失败时整列变空。
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
  const privateWorkingSet = await readPrivateWorkingSetBytes(processes.map(item => item.pid)).catch(() => new Map<number, number>())
  for (const item of processes) {
    const bytes = privateWorkingSet?.get(item.pid)
    if (typeof bytes === 'number') item.memoryBytes = bytes
  }
  processes.sort((left, right) => Number(right.role === 'main') - Number(left.role === 'main') || left.pid - right.pid)
  return { capturedAt: Date.now(), processes }
}

export function registerRuntimeProcessesIPC(): void {
  ipcMain.handle(IPC_CHANNELS.RUNTIME_PROCESSES_GET, event => {
    assertTrustedRenderer(event)
    return getRuntimeProcessSnapshot()
  })
}
