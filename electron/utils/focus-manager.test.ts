// electron/utils/focus-manager.test.ts — 焦点服务回归测试
//
// 覆盖 2026-10 焦点跳错窗口修复的核心语义：
//   1. 恢复目标只来自 show() 抢焦点前的本轮采集，绝不复用上一轮句柄；
//   2. 收起后验证-纠正：自然落点已正确则零干预，不正确才交还一次；
//   3. 采集失败/目标是自己 → 本轮降级为纯自然激活；
//   4. 代际取消迟到交还；close 销毁后仍完成交还；
//   5. 唤出后焦点核验与一次有界重试保留。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const fixture = vi.hoisted(() => ({
  getForegroundHandle: vi.fn(),
  setForegroundHandle: vi.fn(),
  findWindowIdByWin: vi.fn(() => null),
}))
vi.mock('./win32-foreground.js', () => ({
  getForegroundHandle: fixture.getForegroundHandle,
  setForegroundHandle: fixture.setForegroundHandle,
}))
vi.mock('../window-factory/window-utils.js', () => ({ findWindowIdByWin: fixture.findWindowIdByWin }))
vi.mock('./fullscreen-tracker.js', () => ({ isTrackedFullscreen: () => false }))

import { track, show, hide, close } from './focus-manager'

function makeWindow(overrides: Partial<Record<string, unknown>> = {}): BrowserWindow {
  const selfHandle = Buffer.alloc(8)
  selfHandle.writeBigUInt64LE(9999n)
  const win = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isAlwaysOnTop: vi.fn(() => false),
    setSkipTaskbar: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    getNativeWindowHandle: vi.fn(() => selfHandle),
    restore: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    maximize: vi.fn(),
    setFullScreen: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    setBounds: vi.fn(),
    on: vi.fn(),
    ...overrides,
  }
  return win as unknown as BrowserWindow
}

/** 触发 track() 注册的 closed 处理器（模拟窗口销毁清理） */
function fireClosed(win: BrowserWindow): void {
  const closedHandler = (win.on as ReturnType<typeof vi.fn>).mock.calls
    .find(([event]) => event === 'closed')?.[1] as (() => void) | undefined
  closedHandler?.()
}

beforeEach(() => {
  vi.useFakeTimers()
  fixture.getForegroundHandle.mockReset()
  fixture.setForegroundHandle.mockReset()
  fixture.getForegroundHandle.mockResolvedValue(4242)
  fixture.setForegroundHandle.mockResolvedValue(true)
  fixture.findWindowIdByWin.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('归还目标只来自本轮采集', () => {
  it('唤出前采集前台窗口；收起后自然落点已正确则零干预', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    expect(fixture.getForegroundHandle).toHaveBeenCalledWith(120)
    // show 自身 + 未聚焦时的立即抢焦点各调用一次
    expect(win.show).toHaveBeenCalledTimes(2)
    // show 抢焦点可能对自身句柄调用 setForegroundHandle，交还断言只看 hide 之后
    fixture.setForegroundHandle.mockClear()

    // 收起后自然落点 = 唤出前采集的 4242 → 不做强制恢复
    fixture.getForegroundHandle.mockResolvedValue(4242)
    hide(win)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.setForegroundHandle).not.toHaveBeenCalled()
  })

  it('收起后自然落点不是唤出前窗口 → 交还一次并复核', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    fixture.setForegroundHandle.mockClear()

    fixture.getForegroundHandle.mockResolvedValue(7777)
    hide(win)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.setForegroundHandle).toHaveBeenCalledTimes(1)
    expect(fixture.setForegroundHandle).toHaveBeenCalledWith(4242)
  })

  it('采集到的是本窗口自己 → 本轮不强制恢复', async () => {
    const win = makeWindow()
    track(win)
    // 与 getNativeWindowHandle 的 9999 相同
    fixture.getForegroundHandle.mockResolvedValue(9999)
    await show(win)
    fixture.setForegroundHandle.mockClear()

    fixture.getForegroundHandle.mockResolvedValue(7777)
    hide(win)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.setForegroundHandle).not.toHaveBeenCalled()
  })

  it('采集失败/超时 → 降级为纯自然激活', async () => {
    const win = makeWindow()
    track(win)
    fixture.getForegroundHandle.mockResolvedValue(null)
    await show(win)
    fixture.setForegroundHandle.mockClear()

    fixture.getForegroundHandle.mockResolvedValue(7777)
    hide(win)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.setForegroundHandle).not.toHaveBeenCalled()
  })
})

describe('代际取消与 close 交还', () => {
  it('快速 hide→show 取消旧的交还', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    hide(win)              // 安排 60ms 后交还
    await show(win)        // 新唤出 → 代际递增，旧交还作废
    fixture.setForegroundHandle.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    // 激活重试会对自身句柄夺焦点；本用例只禁止交还旧的 4242
    expect(fixture.setForegroundHandle).not.toHaveBeenCalledWith(4242)
  })

  it('close 销毁窗口后仍把前台交还给唤出前窗口', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    fixture.setForegroundHandle.mockClear()

    fixture.getForegroundHandle.mockResolvedValue(7777)
    close(win)
    fireClosed(win)        // 状态清理不得取消交还
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.setForegroundHandle).toHaveBeenCalledWith(4242)
  })
})

describe('唤出焦点核验', () => {
  it('show 后未取得焦点 → 一次有界 moveTop+focus 重试', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    // 立即抢焦点一次
    expect(win.moveTop).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(150)
    // 延时核验再抢一次，共两次
    expect(win.moveTop).toHaveBeenCalledTimes(2)
    expect(win.focus).toHaveBeenCalledTimes(3)

    // 只重试一次：继续未聚焦也不再重试，仅记录
    vi.advanceTimersByTime(300)
    expect(win.moveTop).toHaveBeenCalledTimes(2)
  })

  it('show 后已取得焦点 → 不做多余重试', async () => {
    const win = makeWindow({ isFocused: vi.fn(() => true) })
    track(win)
    await show(win)

    vi.advanceTimersByTime(600)
    expect(win.moveTop).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('可见未聚焦的窗口：只补焦点，不回弹隐藏前 bounds', async () => {
    const win = makeWindow({ isVisible: vi.fn(() => true) })
    track(win)
    await show(win)
    vi.advanceTimersByTime(600)

    // bounds 是上次 hide 的快照，可见状态唤出不得用它回弹用户调整
    expect(win.setBounds).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('旧激活核验被新显隐操作取消（代际失效）', async () => {
    const win = makeWindow()
    track(win)
    await show(win)
    hide(win) // 代际递增，show 的激活核验作废

    vi.advanceTimersByTime(600)
    // show 自身 focus + 立即抢焦点 focus；hide 后延时核验取消，不得再有 moveTop
    expect(win.focus).toHaveBeenCalledTimes(2)
    expect(win.moveTop).toHaveBeenCalledTimes(1)
  })
})
