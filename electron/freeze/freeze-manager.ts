// electron/freeze/freeze-manager.ts — 页面冻结管理器（Debugger.pause 彻底定格 + 智能解冻点击）
//
// 防撤回保险的核心：对 webview 的 guest webContents 执行 Debugger.pause，
// 锁死 JS 主线程（定时器/rAF/事件/SSE 回调全部停止），页面画面彻底定格。
//
// 冻结策略演进（scripts/freeze-poc-*.cjs 逐轮验证）：
//   v1 Debugger.pause 单层 —— 有效，但「冻结后加载提示还在动」？
//       → 排查发现是 CSS compositor 动画不受 JS 暂停影响。
//   v2 + Emulation.setVirtualTimePolicy(pause) 双层 —— 在无网络页面（data: URL）
//       counter/spin/performance.now 全部定格；但真实 AI 页面有活跃 SSE 连接时，
//       SSE 消息会「唤醒」虚拟时间推进，CSS 动画照转、内容照更新（POC 实测），
//       虚拟时间方案在真实场景不可靠 → 已移除。
//   v3 纯 Debugger.pause —— 画面彻底定格（capturePage 两次截图一致），滚轮滚动
//       仍可用（compositor 层处理，不依赖主线程），冻结态可滚动查看完整对话
//       （freeze-poc-scroll.cjs 验证）；但按钮点击/复制不可用（JS 冻结）。
//   v4 + 智能解冻点击（当前）—— 冻结态在 before-input-event 层监听 mouseDown，
//       检测到点击时瞬时 resume → 让该次点击（含 click 的 JS 响应）执行完 →
//       立即重新 pause（窗口约 200ms）。滚动本就可用（compositor）无需解冻。
//       「内容定格」与「点击可用」在浏览器底层互斥（已穷举验证：虚拟时间/断网/
//       限速均无法阻止已建立 SSE 连接的数据流），智能解冻是唯一两全路径。
//
// 已知边界（用户已确认取舍）：
//   - 文本选中/拖拽复制不可用（需要持续解冻，窗口只覆盖单次点击）
//   - 点击瞬间，冻结期间积压的 SSE 推送会被一次性处理（内容可能快速跳变
//     到最新，然后重新定格）；防撤回数据保险依赖冻结前已入库的快照
//
// 关键约束（PoC 中确认）：Debugger.pause 后 executeJavaScript 会 hang（注入脚本
// 无法在暂停的 isolate 上返回）。因此防撤回流程必须是「先抓取（未冻结态）→ 入库 →
// 再冻结锁现场」，不能「先冻结再读 DOM」。

import type { Input, WebContents } from 'electron'
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
  /** 智能解冻窗口进行中（避免重复进入） */
  unfreezing?: boolean
  /** 冻结态点击解冻的输入监听（detach 时移除） */
  inputHandler?: (event: Electron.Event, input: Input) => void
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

/** 智能解冻窗口参数 */
const CLICK_UNFREEZE_TIMEOUT_MS = 2000 // 解冻窗口上限（等待 mouseUp）
const CLICK_SETTLE_MS = 200 // mouseUp 后留给 click 事件与 JS 同步响应的缓冲

/** 移除冻结态点击解冻的输入监听 */
function removeClickUnfreeze(wc: WebContents, session: FreezeSession): void {
  if (session.inputHandler && !wc.isDestroyed()) {
    wc.removeListener('before-input-event', session.inputHandler)
  }
  session.inputHandler = undefined
}

/**
 * 智能解冻点击：冻结态监听 mouseDown，检测到点击时瞬时 resume →
 * 等 mouseUp（或 2s 超时）→ 缓冲 200ms 让 click 的 JS 响应执行完 → 立即重新 pause。
 *
 * 为什么需要：内容定格要求 JS 冻结，但冻结后点击无效。浏览器底层无法
 * 「JS 活着 + SSE 内容不动」（已穷举验证），只能解冻瞬间执行点击再锁回。
 */
function installClickUnfreeze(wc: WebContents, tabId: string, session: FreezeSession): void {
  removeClickUnfreeze(wc, session)

  const handler = (event: Electron.Event, input: Input) => {
    if (input.type !== 'mouseDown' || session.state !== 'frozen' || session.unfreezing) return
    session.unfreezing = true
    console.log(`[freeze] tab ${tabId} 冻结态检测到点击，瞬时解冻执行`)

    let finished = false
    const refreeze = () => {
      if (finished) return
      finished = true
      void (async () => {
        // 缓冲：让 click 合成 + JS 同步响应（如复制按钮）执行完
        await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS))
        try {
          if (!wc.isDestroyed() && wc.debugger.isAttached()) {
            await wc.debugger.sendCommand('Debugger.pause')
            console.log(`[freeze] tab ${tabId} 点击已执行，重新冻结`)
          }
        } catch { /* ignore */ }
        session.unfreezing = false
      })()
    }

    // 解冻窗口内监听 mouseUp（用户松开即结束窗口）
    const onUp = (e: Electron.Event, i: Input) => {
      if (i.type === 'mouseUp') refreeze()
    }

    void (async () => {
      try {
        await wc.debugger.sendCommand('Debugger.resume')
      } catch (err) {
        console.warn(`[freeze] tab ${tabId} 瞬时解冻失败:`, err)
        session.unfreezing = false
        return
      }
      wc.on('before-input-event', onUp)
      setTimeout(() => {
        wc.removeListener('before-input-event', onUp)
        refreeze()
      }, CLICK_UNFREEZE_TIMEOUT_MS)
    })()
  }

  wc.on('before-input-event', handler)
  session.inputHandler = handler
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
      // 彻底定格：Debugger.pause 锁死 JS（动画/定时器/SSE 回调全停，画面定格）
      await wc.debugger.sendCommand('Debugger.pause')
      const session: FreezeSession = {
        webContentsId: wc.id,
        state: 'frozen',
        attachedAt: existing?.attachedAt ?? Date.now(),
        frozenAt: Date.now(),
      }
      sessions.set(tabId, session)
      // 冻结态点击可用：智能解冻（点击瞬间 resume → 执行 → 重新 pause）
      installClickUnfreeze(wc, tabId, session)
      console.log(`[freeze] tab ${tabId} 已冻结`)
      return true
    }
    if (existing.state === 'attached') {
      // 已 attach 未冻结 → 直接 pause
      await wc.debugger.sendCommand('Debugger.pause')
      existing.state = 'frozen'
      existing.frozenAt = Date.now()
      sessions.set(tabId, existing)
      installClickUnfreeze(wc, tabId, existing)
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
    // 用户主动恢复：移除智能解冻监听（页面恢复完全交互）
    removeClickUnfreeze(wc, session)
    await wc.debugger.sendCommand('Debugger.resume')
    session.state = 'attached'
    session.frozenAt = null
    sessions.set(tabId, session)
    console.log(`[freeze] tab ${tabId} 已恢复`)
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
      removeClickUnfreeze(wc, session)
      if (session.state === 'frozen') {
        await wc.debugger.sendCommand('Debugger.resume')
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
