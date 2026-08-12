// electron/freeze/freeze-manager.ts — 页面冻结管理器（底层内存级冻结）
//
// 防撤回保险的核心。冻结 = 两层 CDP 机制叠加（scripts/freeze-poc-deepfreeze.cjs 验证）：
//   1. Emulation.setVirtualTimePolicy({ policy: 'pause' }) —— 暂停虚拟时钟
//      这是「底层冻结」的关键：CSS 动画（loading 转圈/脉冲/进度条）、rAF、定时器、
//      performance.now() 全部随之定格。仅 Debugger.pause 时 CSS compositor 动画
//      仍会继续转（用户实测「冻结后加载提示还在动」的根因），必须叠加虚拟时间暂停。
//   2. Debugger.pause —— 锁死 JS 主线程（事件/注入全部挂起），双保险。
//   Target.setAutoAttach 递归冻结 Worker / iframe 子目标。
//
// 已验证（Electron 30.5.1 / Chromium 124）：
//   - 虚拟时间暂停后 counter/spin/pulse/performance.now() 全部定格，恢复后继续
//   - 页面无感知（不触发 freeze/pagehide 事件）
//   - host webContents 不受影响（独立进程）
//   - 恢复顺序：Debugger.resume → Emulation 恢复 advance（积压定时器追帧后正常）
//
// 关键约束（PoC 中确认）：Debugger.pause 后 executeJavaScript 会 hang（注入脚本
// 无法在暂停的 isolate 上返回）。因此防撤回流程必须是「先抓取（未冻结态）→ 入库 →
// 再冻结锁现场」，不能「先冻结再读 DOM」。

import type { WebContents } from 'electron'
import { getWebviewByTabId, listRegisteredWebviews } from './webview-registry.js'

/** 冻结状态 */
export type FreezeState = 'idle' | 'attached' | 'frozen'

/** 单个 webContents 的冻结会话 */
interface FreezeSession {
  webContentsId: number
  state: FreezeState
  /** attach 时间戳 */
  attachedAt: number
  /** pause 时间戳（未冻结为 null） */
  frozenAt: number | null
}

/** tabId → 冻结会话 */
const sessions = new Map<string, FreezeSession>()

/** 附加调试器并启用递归子目标 attach（不 pause） */
async function attach(wc: WebContents): Promise<void> {
  if (wc.debugger.isAttached()) return
  await wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Debugger.enable')
  // 递归 attach 子目标（iframe / Worker / Service Worker），否则冻结不彻底
  await wc.debugger.sendCommand('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
}

/**
 * 暂停虚拟时钟（底层冻结：CSS 动画 / rAF / 定时器 / performance.now 全部定格）。
 * 页面无感知（不触发 freeze/pagehide 事件）。
 */
async function pauseVirtualClock(wc: WebContents): Promise<void> {
  await wc.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'pause' })
}

/** 恢复虚拟时钟推进（advance：积压定时器追帧后恢复正常节律） */
async function resumeVirtualClock(wc: WebContents): Promise<void> {
  await wc.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'advance' })
}

/**
 * 冻结指定 tabId 的 webview。
 *
 * 注意：调用方应在调用此方法**之前**完成对话抓取（executeJavaScript 读取 DOM），
 * 因为冻结后 executeJavaScript 会 hang。
 *
 * @returns 是否成功冻结
 */
export async function freezeTab(tabId: string): Promise<boolean> {
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    console.warn(`[freeze] tab ${tabId} 的 webview 未找到（注册表: ${listRegisteredWebviews().length} 条）`)
    return false
  }

  const existing = sessions.get(tabId)
  try {
    if (!existing || existing.state === 'idle') {
      await attach(wc)
      // 底层冻结：先暂停虚拟时钟（动画/计时器定格），再锁死 JS
      await pauseVirtualClock(wc)
      await wc.debugger.sendCommand('Debugger.pause')
      sessions.set(tabId, {
        webContentsId: wc.id,
        state: 'frozen',
        attachedAt: existing?.attachedAt ?? Date.now(),
        frozenAt: Date.now(),
      })
      console.log(`[freeze] tab ${tabId} 已冻结（虚拟时钟+JS 双层定格）`)
      return true
    }
    if (existing.state === 'attached') {
      // 已 attach 未冻结 → 直接双层冻结
      await pauseVirtualClock(wc)
      await wc.debugger.sendCommand('Debugger.pause')
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      sessions.set(tabId, existing)
      console.log(`[freeze] tab ${tabId} 已冻结（复用已 attach 的 debugger）`)
      return true
    }
    // 已冻结 → 幂等返回
    console.log(`[freeze] tab ${tabId} 已处于冻结态，跳过`)
    return true
  } catch (err) {
    console.error(`[freeze] 冻结 tab ${tabId} 失败:`, err)
    return false
  }
}

/**
 * 恢复指定 tabId 的 webview（解除冻结，页面无缝继续）。
 * @returns 是否成功恢复
 */
export async function resumeTab(tabId: string): Promise<boolean> {
  const session = sessions.get(tabId)
  if (!session || session.state !== 'frozen') {
    console.log(`[freeze] tab ${tabId} 未冻结，无需恢复`)
    return false
  }
  const wc = getWebviewByTabId(tabId)
  if (!wc) {
    console.warn(`[freeze] tab ${tabId} 的 webview 已销毁，清理会话`)
    sessions.delete(tabId)
    return false
  }
  try {
    // 恢复顺序：先放 JS，再恢复虚拟时钟（advance 追帧积压定时器后恢复正常节律）
    await wc.debugger.sendCommand('Debugger.resume')
    await resumeVirtualClock(wc)
    session.state = 'attached'
    session.frozenAt = null
    sessions.set(tabId, session)
    console.log(`[freeze] tab ${tabId} 已恢复（虚拟时钟+JS）`)
    return true
  } catch (err) {
    console.error(`[freeze] 恢复 tab ${tabId} 失败:`, err)
    return false
  }
}

/**
 * 彻底分离调试器（恢复 + detach）。
 * 用于退出冻结模式、切换标签、关闭页面时清理。
 */
export async function detachTab(tabId: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session) return
  const wc = getWebviewByTabId(tabId)
  if (wc && !wc.isDestroyed()) {
    try {
      if (session.state === 'frozen') {
        // 与 resumeTab 相同的完整恢复序列（先 JS 后虚拟时钟）
        await wc.debugger.sendCommand('Debugger.resume')
        await resumeVirtualClock(wc)
      }
      if (wc.debugger.isAttached()) {
        await wc.debugger.detach()
      }
    } catch (err) {
      console.warn(`[freeze] detach tab ${tabId} 异常:`, err)
    }
  }
  sessions.delete(tabId)
  console.log(`[freeze] tab ${tabId} 已分离调试器`)
}

/** 查询指定 tab 的冻结状态 */
export function getFreezeState(tabId: string): FreezeState {
  return sessions.get(tabId)?.state ?? 'idle'
}

/** 查询是否处于冻结态 */
export function isFrozen(tabId: string): boolean {
  return getFreezeState(tabId) === 'frozen'
}

/** 当前所有冻结中的 tabId（用于退出时批量恢复） */
export function getFrozenTabs(): string[] {
  const result: string[] = []
  for (const [tabId, s] of sessions) {
    if (s.state === 'frozen') result.push(tabId)
  }
  return result
}

/** 应用退出前批量恢复所有冻结的 webview（避免残留 debugger 阻止退出） */
export async function detachAll(): Promise<void> {
  const tabIds = Array.from(sessions.keys())
  await Promise.all(tabIds.map((id) => detachTab(id)))
  console.log(`[freeze] 已批量分离 ${tabIds.length} 个会话`)
}
