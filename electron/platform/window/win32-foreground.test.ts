// electron/platform/window/win32-foreground.test.ts — 常驻 PowerShell 桥协议回归测试
//
// 覆盖：请求/响应行协议（带请求 id）、响应拆包粘包、超时与迟到响应丢弃、
// 进程退出兜底、dispose 清理。spawn 被 mock 为内存假进程。

import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  type Listener = (...args: any[]) => void
  class MiniEmitter {
    handlers = new Map<string, Listener[]>()
    on(event: string, cb: Listener): this {
      const list = this.handlers.get(event) ?? []
      list.push(cb)
      this.handlers.set(event, list)
      return this
    }
    emit(event: string, ...args: any[]): void {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args)
    }
  }
  class FakeChild extends MiniEmitter {
    stdout = new MiniEmitter()
    stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error) => void) => {
        cb?.()
        return true
      }),
      end: vi.fn(),
    }
    kill = vi.fn()
  }
  const children: FakeChild[] = []
  return {
    children,
    metrics: vi.fn(),
    owner: vi.fn(),
    spawn: vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    }),
  }
})
vi.mock('child_process', () => ({ spawn: fixture.spawn }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/foreground-test-no-resources',
    getAppMetrics: fixture.metrics,
  },
}))
vi.mock('../../diagnostics/resident-process-ownership.js', () => ({
  backgroundWindowForProcess: fixture.owner,
}))

/** 每个用例加载全新模块实例（模块级单例状态不跨用例泄漏） */
async function load() {
  vi.resetModules()
  return await import('./win32-foreground')
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  fixture.children.length = 0
})

describe('读前台窗口', () => {
  it('写出带 id 的请求行并解析响应', async () => {
    const m = await load()
    const pending = m.getForegroundHandle()
    const child = fixture.children[0]
    expect(child.stdin.write).toHaveBeenCalledWith('G:1\n', expect.any(Function))
    child.stdout.emit('data', Buffer.from('G:1:4242\r\n'))
    await expect(pending).resolves.toBe(4242)
  })

  it('半包/粘包按行缓冲解析', async () => {
    const m = await load()
    const first = m.getForegroundHandle()
    const second = m.getForegroundHandle()
    const child = fixture.children[0]
    child.stdout.emit('data', Buffer.from('G:1:42'))
    child.stdout.emit('data', Buffer.from('42\r\nG:2:7777\n'))
    await expect(first).resolves.toBe(4242)
    await expect(second).resolves.toBe(7777)
  })

  it('句柄为 0 视为失败返回 null', async () => {
    const m = await load()
    const pending = m.getForegroundHandle()
    fixture.children[0].stdout.emit('data', Buffer.from('G:1:0\n'))
    await expect(pending).resolves.toBeNull()
  })
})

describe('置前台窗口', () => {
  it('写出 SET 请求行，1 视为成功', async () => {
    const m = await load()
    const pending = m.setForegroundHandle(4242)
    const child = fixture.children[0]
    expect(child.stdin.write).toHaveBeenCalledWith('S:1:4242\n', expect.any(Function))
    child.stdout.emit('data', Buffer.from('S:1:1\n'))
    await expect(pending).resolves.toBe(true)
  })

  it('0 视为失败', async () => {
    const m = await load()
    const pending = m.setForegroundHandle(4242)
    fixture.children[0].stdout.emit('data', Buffer.from('S:1:0\n'))
    await expect(pending).resolves.toBe(false)
  })
})

describe('超时与异常路径', () => {
  it('超时解析为 null，迟到响应被丢弃且不影响后续请求', async () => {
    vi.useFakeTimers()
    const m = await load()
    const pending = m.getForegroundHandle(50)
    const child = fixture.children[0]
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toBeNull()
    // 迟到的响应 1 号不得串到下一个请求
    child.stdout.emit('data', Buffer.from('G:1:4242\n'))
    const next = m.getForegroundHandle()
    child.stdout.emit('data', Buffer.from('G:2:7777\n'))
    await expect(next).resolves.toBe(7777)
  })

  it('进程退出兜底：在途请求解析为 null，后续请求重新拉起会话', async () => {
    const m = await load()
    const pending = m.getForegroundHandle()
    const child = fixture.children[0]
    child.emit('exit', 0)
    await expect(pending).resolves.toBeNull()
    const next = m.getForegroundHandle()
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
    fixture.children[1].stdout.emit('data', Buffer.from('G:2:7777\n'))
    await expect(next).resolves.toBe(7777)
  })

  it('dispose 终止会话并放弃在途请求，后续请求直接降级', async () => {
    const m = await load()
    const pending = m.getForegroundHandle()
    const child = fixture.children[0]
    m.disposeWin32ForegroundBridge()
    await expect(pending).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalled()
    await expect(m.getForegroundHandle()).resolves.toBeNull()
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
  })
})

describe('后台窗口工作集请求', () => {
  const metrics = () => [
    { pid: 2, creationTime: 1000, type: 'Tab' },
    { pid: process.pid, creationTime: 500, type: 'Browser' },
  ]
  const window = () =>
    ({
      getNativeWindowHandle: () => {
        const bytes = Buffer.alloc(8)
        bytes.writeBigUInt64LE(4242n)
        return bytes
      },
    }) as Electron.BrowserWindow
  it('requires live renderer ownership before sending a native background-window guard', async () => {
    const m = await load(),
      owner = window()
    fixture.metrics.mockReturnValue(metrics())
    fixture.owner.mockReturnValue(owner)
    m.markForegroundActivity()
    await expect(m.trimWorkingSet(2, 1000, 48 * 1048576, 15000)).resolves.toBeNull()
    const pending = m.trimWorkingSet(2, 1000, 48 * 1048576, 15000, owner)
    const child = fixture.children[0]
    expect(child.stdin.write).toHaveBeenCalledWith(
      `T:1:2:1000:50331648:15000:${process.pid}:500:4242\n`,
      expect.any(Function),
    )
    child.stdout.emit('data', Buffer.from('T:1:100000000,1000000,10\n'))
    await expect(pending).resolves.toEqual({
      beforeBytes: 100000000,
      afterBytes: 1000000,
      durationMs: 10,
    })
  })
  it('rejects changed ownership and shared-process types without a native request', async () => {
    const m = await load(),
      owner = window()
    fixture.metrics.mockReturnValue(metrics())
    fixture.owner.mockReturnValue(null)
    await expect(m.trimWorkingSet(2, 1000, 48 * 1048576, 15000, owner)).resolves.toBeNull()
    fixture.metrics.mockReturnValue([{ ...metrics()[0], type: 'GPU' }, metrics()[1]])
    fixture.owner.mockReturnValue(owner)
    await expect(m.trimWorkingSet(2, 1000, 48 * 1048576, 15000, owner)).resolves.toBeNull()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})
