// electron/diagnostics/tab-process-priority.ts — guest 进程优先级管理
//
// 非活跃标签的 guest 进程对交互延迟不敏感，降到系统低优先级后，
// 前台标签与界面进程能更稳定地拿到 CPU。激活（或正在出声）时恢复常规优先级。
//
// 优先级档位说明：libuv 在 Windows 上不提供 PROCESS_MODE_BACKGROUND 档，
// 因此用 PRIORITY_LOW（Windows 映射为 BELOW_NORMAL 优先级类）作为“后台”档。
// 这是该平台能通过 setPriority 设置的最低常规档。
//
// 状态由渲染层同步：每个窗口把当前激活标签与有声标签上报；
// 主进程把注册表中其余 guest 统一降级，避免主进程自行猜测标签可见性。
//
// 产品约束：清理不得妨碍正常使用。因此这里不是「无脑压低所有 guest」：
// - 仍承载窗口 webContents 的 pid 一律不动（界面渲染、输入、绘制都在这些进程上）；
// - 同一 pid 上有多个 guest 时取其中最高档位，只有全部非激活才整体降级；
// - 降级过的 pid 会被记住，guest 销毁/换代后把优先级还回常规档，
//   避免 pid 复用后新页面一开始就顶着低优先级跑。
import os from 'os'
import { BrowserWindow, ipcMain, webContents } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { TabPrioritySync } from '../shared/runtime-processes.js'
import { getRecordByWebContentsId } from '../window-factory/webview-registry.js'
import { assertTrustedRenderer } from '../security/trusted-renderer.js'

/** 后台档：非活跃 guest 使用，低于常规优先级 */
const BACKGROUND_PRIORITY = os.constants.priority.PRIORITY_LOW
/** 前台档：激活或出声的 guest 使用，恢复常规优先级 */
const FOREGROUND_PRIORITY = os.constants.priority.PRIORITY_NORMAL

/** 各窗口当前上报的负载（windowId → 最近一次同步） */
const latestByWindow = new Map<string, TabPrioritySync>()
/** 被本模块降过优先级的 pid */
const downgradedPids = new Set<number>()
/** 已生效的档位，同档位重复设置直接跳过 */
const appliedPriorities = new Map<number, number>()

/**
 * 判定一个 guest 的目标优先级：
 * - 已注册且激活/出声 → 常规
 * - 已注册且非激活 → 低
 * - 未注册（尚在挂载）→ 常规，等注册后再收敛，避免把激活标签按死在后台档
 */
function targetPriority(tabId: string | null | undefined): number {
  if (!tabId) return FOREGROUND_PRIORITY
  for (const payload of latestByWindow.values()) {
    if (payload.activeTabId === tabId) return FOREGROUND_PRIORITY
    if (payload.audibleTabIds?.includes(tabId)) return FOREGROUND_PRIORITY
  }
  return BACKGROUND_PRIORITY
}

/** 一次绘制快照里，每个 pid 上的 guest 与其它内容 */
interface ProcessOccupancy {
  /** 该 pid 上全部 guest 的目标档位 */
  guestPriorities: number[]
  /** 该 pid 是否还承载窗口 webContents（界面） */
  carriesWindow: boolean
}

function collectOccupancy(): Map<number, ProcessOccupancy> {
  const byPid = new Map<number, ProcessOccupancy>()
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed()) continue
      const pid = contents.getOSProcessId()
      if (pid <= 0) continue
      const occupancy = byPid.get(pid) ?? { guestPriorities: [], carriesWindow: false }
      byPid.set(pid, occupancy)
      if (contents.getType() !== 'webview') {
        occupancy.carriesWindow = true
        continue
      }
      const record = getRecordByWebContentsId(contents.id)
      // 未注册的 guest 保持常规优先级，注册回调里会再收敛
      if (!record?.tabId) continue
      occupancy.guestPriorities.push(targetPriority(record.tabId))
    } catch {
      // Web contents 可能在快照期间消失：按既有效果处理，不打断整轮收敛
    }
  }
  return byPid
}

/**
 * 把优先级应用到当前全部已注册 guest。
 *
 * - 仍承载窗口的 pid 跳过：guest 与界面同进程时压低会拖慢界面渲染；
 * - 同 pid 多 guest 时取最高档位，激活/有声的标签不会被同进程兄弟拖低；
 * - 本轮未降级的 pid 若以前降过（guest 销毁、换代或界面另起了进程），还回常规档。
 */
export function applyGuestProcessPriorities(): void {
  const occupancy = collectOccupancy()
  for (const pid of appliedPriorities.keys()) {
    if (!occupancy.has(pid) && !downgradedPids.has(pid)) appliedPriorities.delete(pid)
  }
  // 先算本轮命中，再统一收敛，避免 setPriority 失败留下半套状态
  const targets = new Map<number, number>()
  for (const [pid, entry] of occupancy) {
    // 仍承载窗口的 pid 一律不动：界面渲染、输入与绘制都在这些进程上
    if (!entry.guestPriorities.length || entry.carriesWindow) continue
    // 同 pid 多 guest 取档位最高的那个（数值最小=优先级最高），
    // 激活/有声的标签不会被同进程的冷标签拖低
    targets.set(pid, Math.min(...entry.guestPriorities))
  }
  // 释放：此前降过、但本轮已不属于纯 guest 进程的 pid 还回常规档
  for (const pid of [...downgradedPids]) {
    if (!targets.has(pid)) releasePid(pid)
  }
  for (const [pid, priority] of targets) {
    // 同档位重复设置没有意义，监控器每 5 秒一拍，跳过可省下大量系统调用
    if (appliedPriorities.get(pid) === priority) continue
    if (!setPidPriority(pid, priority)) continue
    appliedPriorities.set(pid, priority)
    if (priority > FOREGROUND_PRIORITY) downgradedPids.add(pid)
  }
}

/** 尝试设置优先级；进程已退出（ESRCH）视为无需恢复 */
function setPidPriority(pid: number, priority: number): boolean {
  try {
    os.setPriority(pid, priority)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const info = (error as { info?: { code?: string } } | undefined)?.info
    if (code !== 'ESRCH' && info?.code !== 'ESRCH') console.warn('[tab-priority] 设置 guest 优先级失败:', error)
    return false
  }
}

/** 把曾经降级的 pid 还回常规档并清账 */
function releasePid(pid: number): void {
  if (!downgradedPids.delete(pid)) return
  appliedPriorities.delete(pid)
  setPidPriority(pid, FOREGROUND_PRIORITY)
}

/** 窗口关闭后清理其上报，防止残留的激活记录把别的标签挡在后台档外 */
export function forgetWindow(windowId: string): void {
  latestByWindow.delete(windowId)
  applyGuestProcessPriorities()
}

/** 注册优先级同步 IPC；渲染层在激活标签变化时上报 */
export function registerTabProcessPriorityIPC(): void {
  ipcMain.handle(IPC_CHANNELS.TAB_PRIORITY_SYNC, (event, payload: TabPrioritySync) => {
    assertTrustedRenderer(event)
    if (!payload || typeof payload.windowId !== 'string' || !payload.windowId) return false
    if (payload.activeTabId !== null && typeof payload.activeTabId !== 'string') return false
    // 拒绝与发送方窗口不一致的上报，避免关闭过程中的迟到消息把记录写回
    if (event?.sender) {
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow || senderWindow.isDestroyed()) return false
    }
    latestByWindow.set(payload.windowId, {
      windowId: payload.windowId,
      activeTabId: payload.activeTabId ?? null,
      audibleTabIds: Array.isArray(payload.audibleTabIds)
        ? payload.audibleTabIds.filter(id => typeof id === 'string')
        : [],
    })
    applyGuestProcessPriorities()
    return true
  })
}

/** 测试辅助：重置内部状态 */
export function resetTabProcessPriorityForTest(): void {
  latestByWindow.clear()
  downgradedPids.clear()
  appliedPriorities.clear()
}
