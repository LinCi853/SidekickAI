// electron/utils/focus-manager.test.ts — 焦点服务回归测试
//
// 覆盖 2026-09 game-hotkey audit 指出的窗口路径缺口：
//   1. 唤出后核验焦点是否真正取得，未取得时一次有界 moveTop+focus 重试；
//   2. 快速 hide→show 后，旧隐藏的外部焦点恢复被代际取消（迟到的
//      SetForegroundWindow 不得把焦点抢回外部窗口）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const fixture = vi.hoisted(() => ({
  exec: vi.fn(),
  findWindowIdByWin: vi.fn(() => null),
}))
vi.mock('child_process', () => ({ exec: fixture.exec }))
vi.mock('./window-factory/window-utils.js', () => ({ findWindowIdByWin: fixture.findWindowIdByWin }))

import { track, show, hide } from './focus-manager'

function makeWindow(overrides: Partial<Record<string, unknown>> = {}): BrowserWindow {
  const win = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    setSkipTaskbar: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
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

/** exec 命令分类：GetForegroundWindow = 焦点捕获；SetForegroundWindow = 外部焦点恢复 */
function execCalls(kind: 'capture' | 'restore'): string[] {
  return fixture.exec.mock.calls
    .map(([cmd]) => cmd as string)
    .filter((cmd) => (kind === 'capture' ? cmd.includes('GetForegroundWindow') : cmd.includes('SetForegroundWindow')))
}

beforeEach(() => {
  vi.useFakeTimers()
  fixture.exec.mockReset()
  fixture.exec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    cb(null, '4242')
  })
  fixture.findWindowIdByWin.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('唤出焦点核验', () => {
  it('show 后未取得焦点 → 一次有界 moveTop+focus 重试', () => {
    const win = makeWindow()
    track(win)
    show(win)

    vi.advanceTimersByTime(150)
    expect(win.moveTop).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(2)

    // 只重试一次：继续未聚焦也不再重试，仅记录
    vi.advanceTimersByTime(300)
    expect(win.moveTop).toHaveBeenCalledTimes(1)
  })

  it('show 后已取得焦点 → 不做多余重试', () => {
    const win = makeWindow({ isFocused: vi.fn(() => true) })
    track(win)
    show(win)

    vi.advanceTimersByTime(600)
    expect(win.moveTop).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('可见未聚焦的窗口：只补焦点，不回弹隐藏前 bounds', () => {
    const win = makeWindow({ isVisible: vi.fn(() => true) })
    track(win)
    show(win)
    vi.advanceTimersByTime(600)

    // bounds 是上次 hide 的快照，可见状态唤出不得用它回弹用户调整
    expect(win.setBounds).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('旧激活核验被新显隐操作取消（代际失效）', () => {
    const win = makeWindow()
    track(win)
    show(win)
    hide(win) // 代际递增，show 的激活核验作废

    vi.advanceTimersByTime(600)
    // show 自身的 focus 已调用一次；hide 后核验取消，不得再有 moveTop/重试 focus
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.moveTop).not.toHaveBeenCalled()
  })
})

describe('外部焦点恢复代际取消', () => {
  it('快速 hide→show：旧隐藏的恢复被取消，不执行 SetForegroundWindow', async () => {
    const win = makeWindow()
    track(win)
    hide(win)
    await Promise.resolve() // 等待焦点捕获完成（prevHandle=4242）
    hide(win) // 此时有 prevHandle，恢复延迟 120ms
    show(win) // 新唤出 → 旧恢复必须取消
    vi.advanceTimersByTime(5000)

    expect(execCalls('restore')).toHaveLength(0)
  })

  it('无新唤出时，旧隐藏的恢复正常执行', async () => {
    const win = makeWindow()
    track(win)
    hide(win)
    await Promise.resolve()
    hide(win) // prevHandle=4242 → 安排恢复
    vi.advanceTimersByTime(5000)

    expect(execCalls('restore')).toHaveLength(1)
  })

  it('恢复执行前窗口销毁 → 放弃恢复', async () => {
    const win = makeWindow()
    track(win)
    hide(win)
    await Promise.resolve()
    hide(win)
    // 模拟窗口关闭：触发 closed 处理器 → 追踪状态清理 → 代际取消
    const closedHandler = (win.on as ReturnType<typeof vi.fn>).mock.calls
      .find(([event]) => event === 'closed')?.[1] as (() => void) | undefined
    closedHandler?.()
    vi.advanceTimersByTime(5000)

    expect(execCalls('restore')).toHaveLength(0)
  })
})
