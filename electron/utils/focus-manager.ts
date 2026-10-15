// electron/utils/focus-manager.ts — 窗口焦点恢复管理器
//
// 统一管理「隐藏/关闭窗口后把前台交还给唤出前的外部窗口」的逻辑。
// 供所有通过快捷键或托盘切换显隐的窗口使用（主窗口、进阶面板）。
//
// 焦点语义（2026-10 焦点跳错窗口修复）：
//   恢复目标 = 「唤出本窗口之前」的外部前台窗口，在 show() 里、抢焦点之前
//   采集；hide()/close() 只恢复本轮采集到的句柄，采集失败或目标是自己则
//   完全交给系统自然激活。旧实现把「上次收起之后」的落点缓存到下次收起时
//   使用——永远慢一拍，两次收起之间切换过窗口就会把焦点抢回上上个窗口。
//
// 隐藏策略：minimize + skipTaskbar + hide，彻底从屏幕/Alt+Tab/任务栏消失。
//
// 性能设计：
//   - 前台窗口读写经 win32-foreground 常驻 PowerShell 桥（毫秒级往返），
//     不再每次派生新进程（冷启动 300ms~1s，双进程并发时完成顺序不可控）
//   - show() 在抢焦点前等待本轮采集，上限 SHOW_CAPTURE_TIMEOUT_MS，超时降级
//   - hide()/close() 窗口操作同步，验证+纠正异步（fire-and-forget，代际取消）
//   - macOS/Linux 无 user32：采集读到 null，天然降级为纯自然激活
//
// 典型用法（以 Alt+Space 切换主窗口为例）：
//   focusManager.track(win)                 // 窗口创建后调用一次
//   void focusManager.show(win)             // 热键显示：采集前台 → 显示+聚焦
//   focusManager.hide(win)                  // 热键隐藏：同步隐藏 + 异步交还前台

import type { BrowserWindow } from 'electron'
import { findWindowIdByWin } from '../window-factory/window-utils.js'
import { isTrackedFullscreen } from './fullscreen-tracker.js'
import { getForegroundHandle, setForegroundHandle } from './win32-foreground.js'

/** 窗口 → 追踪状态（本轮归还目标 + 隐藏前的窗口形态，供 show 时精确恢复） */
interface TrackedState {
  /**
   * 「唤出本窗口之前」的外部前台窗口句柄（show 抢焦点前采集），
   * hide/close 时交还。每轮 show/hide/close 各用各的，绝不跨轮复用。
   */
  returnHandle: number | null
  /** 本轮采集是否有效（false = hide/close 不强制恢复，只走自然激活） */
  returnHandleValid: boolean
  /** 隐藏前是否最大化（frameless 窗口 minimize+hide 往返后 Windows 可能丢失最大化状态） */
  wasMaximized: boolean
  /** 隐藏前是否全屏 */
  wasFullScreen: boolean
  /** 隐藏前 bounds（非最大化时用于校验宽度不被 Windows/minWidth 调整） */
  bounds: { x?: number; y?: number; width: number; height: number } | null
  /**
   * 显隐代际：每次 show/hide/close 递增。
   * 迟到的异步操作（旧采集、旧交还、旧激活核验）凭代际失效，
   * 避免「快速 hide→show 后，迟到的 SetForegroundWindow 把焦点抢走」。
   */
  generation: number
}

/** 窗口 → 追踪状态 */
const states = new Map<BrowserWindow, TrackedState>()

/** 唤出后首次核验焦点是否落下的延迟 */
const ACTIVATION_CHECK_DELAY_MS = 50
/** 激活重试（moveTop + focus，仅一次）后的复核延迟 */
const ACTIVATION_RETRY_DELAY_MS = 300
/** show 采集「唤出前前台窗口」的等待上限；超时/失败降级为自然激活 */
const SHOW_CAPTURE_TIMEOUT_MS = 120
/** 收起后等待系统自然激活落定再核验的延迟 */
const HIDE_SETTLE_MS = 60
/** 交还后复核前台的延迟 */
const RESTORE_VERIFY_DELAY_MS = 150

function newState(): TrackedState {
  return { returnHandle: null, returnHandleValid: false, wasMaximized: false, wasFullScreen: false, bounds: null, generation: 0 }
}

/**
 * 开始追踪窗口。
 * 在窗口创建后调用一次。窗口销毁时自动清理。
 */
export function track(win: BrowserWindow): void {
  if (states.has(win)) return
  states.set(win, newState())
  win.on('closed', () => { states.delete(win) })
}

/** 停止追踪窗口（通常不需要手动调用，closed 事件自动清理） */
export function untrack(win: BrowserWindow): void {
  states.delete(win)
}

const delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** 采集到的句柄是否就是本窗口自己（自己不能作为收起后的归还目标） */
function isSelfHandle(win: BrowserWindow, handle: number): boolean {
  try {
    const buf = win.getNativeWindowHandle()
    const own = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
    return own === handle
  } catch {
    return false
  }
}

/**
 * 显示窗口：先采集「唤出前」的外部前台窗口，再恢复 skipTaskbar + show + focus。
 *
 * 采集是恢复目标的唯一来源——本轮没采到（超时/目标是自己/非 Windows）时，
 * hide/close 只走系统自然激活，绝不用旧句柄抢焦点（宁可不动，也不乱抢）。
 * 快速连按只会发生一次唤出：更早的 show 在采集等待期间被代际取消。
 *
 * 唤出后异步核验焦点是否真正落下；未落下时做一次有界 moveTop+focus 重试
 * （不改动用户置顶偏好）。对可见未聚焦的窗口调用也是安全的：
 * 只补焦点，不回弹窗口形态。
 */
export async function show(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  const st = states.get(win) ?? newState()
  states.set(win, st)
  const generation = ++st.generation
  // 抢焦点之前采集前台窗口——此刻它就是「唤出前你在用的窗口」
  const captured = await getForegroundHandle(SHOW_CAPTURE_TIMEOUT_MS)
  if (win.isDestroyed()) return
  if (st.generation !== generation) return
  st.returnHandle = null
  st.returnHandleValid = false
  if (captured != null && !isSelfHandle(win, captured)) {
    st.returnHandle = captured
    st.returnHandleValid = true
  }
  // 可见未聚焦时只补焦点，不做形态恢复（bounds 是上次 hide 时的快照，回弹会撤销用户的调整）
  const wasHidden = !win.isVisible() || win.isMinimized()
  win.setSkipTaskbar(false)
  if (win.isMinimized()) win.restore()
  win.show()
  if (wasHidden) {
    if (st.wasFullScreen) {
      // 全屏窗口：恢复全屏
      const wid = findWindowIdByWin(win)
      const isFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
      if (!isFs) win.setFullScreen(true)
    } else if (st.wasMaximized) {
      // 最大化窗口：minimize + hide 往返后，frameless 窗口的原生最大化标记可能丢失，
      // 表现为恢复后变成普通尺寸（宽度莫名其妙变化）。此处重新最大化。
      if (!win.isMaximized()) win.maximize()
    } else if (st.bounds) {
      // 普通窗口：Windows 在 restore 时可能按动态 minWidth 等强制调整尺寸，
      // 若宽度/高度与隐藏前不一致则恢复隐藏前尺寸。
      const b = win.getBounds()
      if (b.width !== st.bounds.width || b.height !== st.bounds.height) {
        try {
          win.setBounds({ ...st.bounds })
        } catch { /* ignore */ }
      }
    }
  }
  win.focus()
  // 键盘钩子/后台热键唤出时 Windows 可能拒绝前台，立即做一次短暂置顶抢焦点
  if (!win.isFocused()) activateWithSteal(win)
  scheduleActivationCheck(win, generation)
}

/**
 * 唤出后核验窗口是否真正取得前台焦点。
 * Windows 前台锁定会拒绝非前台进程的 SetForegroundWindow（典型：独占全屏游戏在前台），
 * 首次失败时做一次有界 moveTop + focus 重试；仍失败则记录警告（不永久置顶、不与
 * window-events 的置顶偏好回放竞争）。
 */
function scheduleActivationCheck(win: BrowserWindow, generation: number): void {
  setTimeout(() => {
    if (win.isDestroyed()) return
    const cur = states.get(win)
    if (!cur || cur.generation !== generation) return
    if (win.isFocused()) return
    activateWithSteal(win)
    setTimeout(() => {
      if (win.isDestroyed()) return
      const later = states.get(win)
      if (!later || later.generation !== generation) return
      if (!win.isFocused()) {
        console.warn(
          '[focus-manager] 唤出后窗口未取得前台焦点（可能受前台锁定/全屏应用限制）',
        )
      }
    }, ACTIVATION_RETRY_DELAY_MS)
  }, ACTIVATION_CHECK_DELAY_MS)
}

/**
 * 带前台锁定绕过的激活：短暂 topmost 触发系统级激活，随后还原置顶状态。
 * Windows 前台锁定会拒绝后台进程的 SetForegroundWindow（fallback 热键、提权/全屏
 * 窗口在前台等场景），而置顶窗口 show 可正常取得前台——借此强行夺回焦点。
 * window-events 的 reapplyAlwaysOnTop 会在 show/focus 事件里按用户偏好还原置顶，
 * 与本函数"短暂 topmost → 还原"的语义一致，不会相互冲突。
 */
function activateWithSteal(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  const wasTopmost = win.isAlwaysOnTop()
  try { win.setAlwaysOnTop(true) } catch { /* ignore */ }
  win.show()
  try { win.setAlwaysOnTop(wasTopmost) } catch { /* ignore */ }
  win.moveTop()
  win.focus()
}

/**
 * 把前台交还给唤出前的外部窗口（验证-纠正）：
 * 等系统自然激活落定后读一次前台，已落在目标上则零干预；
 * 未落在目标上才纠正一次，并复核结果如实记录。
 * 句柄失效/前台锁定拒绝时保持现状——宁可不动，也不拿旧句柄乱抢。
 */
async function restoreReturnAsync(handle: number, isCancelled: () => boolean): Promise<void> {
  await delay(HIDE_SETTLE_MS)
  if (isCancelled()) return
  const foreground = await getForegroundHandle()
  if (isCancelled()) return
  // 自然激活已经落对（或前台读不到、无从判断）→ 零干预路径在 fg === handle 时成立；
  // fg 为 null（读失败）时仍尝试交还：目标是本轮新鲜句柄，语义上就是正确落点
  if (foreground === handle) return
  const ok = await setForegroundHandle(handle)
  if (isCancelled()) return
  if (!ok) {
    console.warn('[focus-manager] 交还前台失败（句柄失效或被前台锁定）:', handle)
    return
  }
  await delay(RESTORE_VERIFY_DELAY_MS)
  if (isCancelled()) return
  if (await getForegroundHandle() !== handle) {
    console.warn('[focus-manager] 交还前台后仍未落在目标窗口（可能被前台锁定）:', handle)
  }
}

/**
 * 隐藏窗口并把前台交还给唤出前的外部窗口。
 *
 * 隐藏策略：minimize + skipTaskbar + hide，比 win.hide()（SW_HIDE）更彻底。
 * 窗口操作同步执行；交还前台异步执行（fire-and-forget，代际取消）。
 * 本轮没有有效归还目标（唤出采集失败/目标是自己）时不做强制恢复，
 * 交给系统自然激活——自然落点通常就是唤出前的窗口。
 */
export function hide(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const st = states.get(win) ?? newState()
  // 记住隐藏前的窗口形态（minimize 之前读取，避免动画中间态）
  st.wasMaximized = win.isMaximized()
  const wid = findWindowIdByWin(win)
  st.wasFullScreen = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
  st.bounds = win.getBounds()
  // 递增代际：取消未完成的旧采集/旧交还/旧激活核验
  st.generation++
  const generation = st.generation
  const handle = st.returnHandle
  const shouldRestore = st.returnHandleValid && handle != null
  // 消费本轮归还目标：每轮 hide 只允许一次强制恢复
  st.returnHandle = null
  st.returnHandleValid = false
  states.set(win, st)
  // 同步隐藏：minimize + skipTaskbar + hide，窗口立即从所有界面消失
  win.minimize()
  win.setSkipTaskbar(true)
  win.hide()
  if (shouldRestore && handle != null) {
    void restoreReturnAsync(handle, () => st.generation !== generation || win.isDestroyed())
  }
}

/**
 * 关闭（销毁）窗口并把前台交还给唤出前的外部窗口。
 * 适用于进阶面板等每次打开都重建的窗口。
 * 销毁是本流程的预期结果，取消条件只看代际（不因窗口消失而放弃交还）。
 */
export function close(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const st = states.get(win)
  win.close()
  if (!st) return
  st.generation++
  const generation = st.generation
  const handle = st.returnHandle
  const shouldRestore = st.returnHandleValid && handle != null
  st.returnHandle = null
  st.returnHandleValid = false
  if (shouldRestore && handle != null) {
    void restoreReturnAsync(handle, () => st.generation !== generation)
  }
}
