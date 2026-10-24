// electron/diagnostics/tab-process-priority.test.ts
//
// 优先级判定逻辑：激活/有声标签保持常规，其余降为后台档。
// 不真正调用 os.setPriority（避免影响测试进程自身），通过 mock 观察目标档位。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const osPriority = { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0 }
const setPriority = vi.fn()

vi.mock('os', () => ({
  default: { constants: { priority: osPriority }, setPriority: (...args: unknown[]) => setPriority(...args) },
}))

const webviews = new Map<number, { id: number; type: string; destroyed: boolean; pid: number; tabId: string | null }>()

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false }),
  },
  webContents: {
    getAllWebContents: () => [...webviews.values()].map(item => ({
      id: item.id,
      isDestroyed: () => item.destroyed,
      getType: () => item.type,
      getOSProcessId: () => item.pid,
    })),
  },
}))

const records = new Map<number, { tabId: string }>()

vi.mock('../window-factory/webview-registry.js', () => ({
  getRecordByWebContentsId: (id: number) => records.get(id) ?? null,
}))

vi.mock('../platform/security/trusted-renderer.js', () => ({ assertTrustedRenderer: () => {} }))

const { ipcMain } = await import('electron')
const { applyGuestProcessPriorities, registerTabProcessPriorityIPC, resetTabProcessPriorityForTest } =
  await import('./tab-process-priority.js')

/** 取出 IPC handler 便于模拟渲染层上报 */
function priorityHandler(): (event: unknown, payload: unknown) => boolean {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    .find(entry => entry[0] === 'tab-priority:sync')
  if (!call) throw new Error('优先级同步通道未注册')
  return call[1] as (event: unknown, payload: unknown) => boolean
}

/** 注入一个 guest webview 及其注册记录 */
function addGuest(id: number, pid: number, tabId: string | null): void {
  webviews.set(id, { id, type: 'webview', destroyed: false, pid, tabId })
  if (tabId) records.set(id, { tabId })
  else records.delete(id)
}

/** 注入一个界面窗口内容（与 guest 共用 pid 时用于验证不压低界面） */
function addWindow(id: number, pid: number): void {
  webviews.set(id, { id, type: 'window', destroyed: false, pid, tabId: null })
}

/** 读取全部 guest 的目标档位（按 pid 汇总，便于断言） */
function prioritiesByPid(): Map<number, number> {
  const result = new Map<number, number>()
  for (const call of setPriority.mock.calls) result.set(call[0] as number, call[1] as number)
  return result
}

describe('tab process priority', () => {
  beforeEach(() => {
    setPriority.mockClear()
    webviews.clear()
    records.clear()
    resetTabProcessPriorityForTest()
    registerTabProcessPriorityIPC()
  })

  it('未收到任何同步时全部 guest 降为后台档', () => {
    addGuest(1, 101, 'tab-a')
    addGuest(2, 102, 'tab-b')
    applyGuestProcessPriorities()
    const priorities = prioritiesByPid()
    expect(priorities.get(101)).toBe(osPriority.PRIORITY_LOW)
    expect(priorities.get(102)).toBe(osPriority.PRIORITY_LOW)
  })

  it('激活与有声标签保持常规优先级，其余降为后台', () => {
    addGuest(1, 101, 'tab-active')
    addGuest(2, 102, 'tab-audible')
    addGuest(3, 103, 'tab-other')

    expect(priorityHandler()(null, {
      windowId: 'main',
      activeTabId: 'tab-active',
      audibleTabIds: ['tab-audible'],
    })).toBe(true)

    applyGuestProcessPriorities()
    const priorities = prioritiesByPid()
    expect(priorities.get(101)).toBe(osPriority.PRIORITY_NORMAL)
    expect(priorities.get(102)).toBe(osPriority.PRIORITY_NORMAL)
    expect(priorities.get(103)).toBe(osPriority.PRIORITY_LOW)
  })

  it('多窗口同步时任一窗口激活即视为前台', () => {
    addGuest(1, 101, 'tab-main')
    addGuest(2, 102, 'tab-browser')
    const handler = priorityHandler()
    expect(handler(null, { windowId: 'main', activeTabId: 'tab-main', audibleTabIds: [] })).toBe(true)
    expect(handler(null, { windowId: 'browser', activeTabId: 'tab-browser', audibleTabIds: [] })).toBe(true)

    applyGuestProcessPriorities()
    const priorities = prioritiesByPid()
    expect(priorities.get(101)).toBe(osPriority.PRIORITY_NORMAL)
    expect(priorities.get(102)).toBe(osPriority.PRIORITY_NORMAL)
  })

  it('非法载荷被拒绝且不改变既有状态', () => {
    const handler = priorityHandler()
    expect(handler(null, null)).toBe(false)
    expect(handler(null, { windowId: '', activeTabId: null })).toBe(false)
    expect(handler(null, { windowId: 'main', activeTabId: 123 })).toBe(false)
  })

  it('销毁或非 webview 的 contents 不参与优先级设置', () => {
    webviews.set(9, { id: 9, type: 'window', destroyed: false, pid: 109, tabId: null })
    webviews.set(10, { id: 10, type: 'webview', destroyed: true, pid: 110, tabId: 'tab-gone' })
    applyGuestProcessPriorities()
    expect(prioritiesByPid().has(109)).toBe(false)
    expect(prioritiesByPid().has(110)).toBe(false)
  })

  it('guest 与界面窗口共进程时不动该 pid，界面渲染优先级不受影响', () => {
    // 界面窗口在 pid 101 上，同一个 pid 里还挂着一个非激活 guest
    addWindow(5, 101)
    addGuest(1, 101, 'tab-a')
    addGuest(2, 102, 'tab-b')
    applyGuestProcessPriorities()
    const priorities = prioritiesByPid()
    // 共进程的 pid 完全不碰：既不降级，也不做多余的恢复调用
    expect(priorities.has(101)).toBe(false)
    expect(priorities.get(102)).toBe(osPriority.PRIORITY_LOW)
  })

  it('同 pid 多 guest 时取最高档位，激活标签不被同进程兄弟拖低', () => {
    addGuest(1, 101, 'tab-active')
    addGuest(2, 101, 'tab-cold')
    priorityHandler()(null, { windowId: 'main', activeTabId: 'tab-active', audibleTabIds: [] })
    applyGuestProcessPriorities()
    expect(prioritiesByPid().get(101)).toBe(osPriority.PRIORITY_NORMAL)
  })

  it('全部 guest 一起销毁后把降过级的 pid 还回常规档', () => {
    addGuest(1, 101, 'tab-a')
    applyGuestProcessPriorities()
    expect(prioritiesByPid().get(101)).toBe(osPriority.PRIORITY_LOW)

    setPriority.mockClear()
    webviews.delete(1)
    records.delete(1)
    applyGuestProcessPriorities()
    expect(prioritiesByPid().get(101)).toBe(osPriority.PRIORITY_NORMAL)

    // 恢复之后不再重复归还
    setPriority.mockClear()
    applyGuestProcessPriorities()
    expect(setPriority).not.toHaveBeenCalled()
  })

  it('guest 换到新 pid 时旧 pid 恢复、新 pid 降级', () => {
    addGuest(1, 101, 'tab-a')
    applyGuestProcessPriorities()
    setPriority.mockClear()

    // 同一标签的 guest 换代：旧 webContents 消失，新 webContents 落在新 pid
    addGuest(1, 202, 'tab-a')
    applyGuestProcessPriorities()
    const priorities = prioritiesByPid()
    expect(priorities.get(101)).toBe(osPriority.PRIORITY_NORMAL)
    expect(priorities.get(202)).toBe(osPriority.PRIORITY_LOW)
  })

  it('界面窗口接管曾降级的 pid 时也把优先级还回常规档', () => {
    addGuest(1, 101, 'tab-a')
    applyGuestProcessPriorities()
    setPriority.mockClear()

    addWindow(5, 101)
    applyGuestProcessPriorities()
    expect(prioritiesByPid().get(101)).toBe(osPriority.PRIORITY_NORMAL)
  })

  it('同档位不重复下发，避免每轮巡检刷系统调用', () => {
    addGuest(1, 101, 'tab-a')
    applyGuestProcessPriorities()
    setPriority.mockClear()
    applyGuestProcessPriorities()
    expect(setPriority).not.toHaveBeenCalled()
  })
})

it('forgets normal priority after process exit so a reused pid is applied again', () => {
 registerTabProcessPriorityIPC();
 resetTabProcessPriorityForTest(); webviews.clear(); records.clear(); setPriority.mockClear();
 addGuest(1,101,'old'); priorityHandler()(null,{windowId:'main',activeTabId:'old',audibleTabIds:[]});
 webviews.clear(); records.clear(); applyGuestProcessPriorities(); setPriority.mockClear();
 addGuest(2,101,'new'); priorityHandler()(null,{windowId:'main',activeTabId:'new',audibleTabIds:[]});
 expect(setPriority).toHaveBeenCalledWith(101,osPriority.PRIORITY_NORMAL);
});
it('recognizes nested ESRCH during guest teardown without repeated warnings', () => {
 resetTabProcessPriorityForTest(); webviews.clear(); records.clear(); setPriority.mockClear();
 addGuest(1,101,'old'); applyGuestProcessPriorities(); webviews.clear(); records.clear();
 const warning=vi.spyOn(console,'warn').mockImplementation(() => {});
 setPriority.mockImplementationOnce(() => { throw Object.assign(new Error('gone'),{code:'ERR_SYSTEM_ERROR',info:{code:'ESRCH'}}) });
 applyGuestProcessPriorities(); expect(warning).not.toHaveBeenCalled(); warning.mockRestore();
});
