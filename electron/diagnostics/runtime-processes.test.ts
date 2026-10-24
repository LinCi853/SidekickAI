import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessMetric } from 'electron'

const fixture = vi.hoisted(() => ({
  metrics: [] as ProcessMetric[], contents: [] as any[],
  handle: vi.fn(), authorize: vi.fn(), metricsRead: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getName: () => 'SidekickAI', getAppMetrics: () => { fixture.metricsRead(); return fixture.metrics } },
  BrowserWindow: { fromWebContents: (contents: any) => contents.window },
  webContents: { getAllWebContents: () => fixture.contents },
  ipcMain: { handle: fixture.handle },
}))
vi.mock('../platform/security/trusted-renderer.js', () => ({ assertTrustedRenderer: fixture.authorize }))

const privateWorkingSet = vi.hoisted(() => ({
  map: new Map<number, number>(),
  read: vi.fn(async () => privateWorkingSet.map),
}))
vi.mock('./private-working-set.js', () => ({ readPrivateWorkingSetBytes: privateWorkingSet.read }))

import { getRuntimeProcessSnapshot, registerRuntimeProcessesIPC } from './runtime-processes'
import { IPC_CHANNELS } from '../shared/ipc-channels'

function metric(pid: number, type: ProcessMetric['type'], serviceName?: string): ProcessMetric {
  return { pid, type, serviceName, creationTime: 1000 + pid,
    cpu: { percentCPUUsage: 1.5, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 },
  }
}
function contents(id: number, pid: number, title: string, guest = false) {
  return {
    id, isDestroyed: () => false, getType: () => guest ? 'webview' : 'window',
    getTitle: () => title, getURL: () => 'https://user:secret@example.test/private?token=secret#secret',
    getOSProcessId: () => pid, hostWebContents: null,
    window: { getTitle: () => 'SidekickAI window', isDestroyed: () => false },
    mainFrame: { framesInSubtree: [{ osProcessId: pid }] },
  }
}

beforeEach(() => {
  fixture.metrics = []
  fixture.contents = []
  vi.resetAllMocks()
  privateWorkingSet.map = new Map()
  privateWorkingSet.read.mockImplementation(async () => privateWorkingSet.map)
})

describe('runtime process snapshot', () => {
  it('separates interface, webpage, GPU, network, audio and generic services', async () => {
    fixture.metrics = [metric(5, 'Utility', 'network.mojom.NetworkService'), metric(1, 'Browser'),
      metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'GPU'), metric(6, 'Utility', 'audio.mojom.AudioService'),
      metric(7, 'Utility', 'video_capture.mojom.VideoCaptureService'), metric(8, 'Utility', 'custom-service')]
    fixture.contents = [contents(20, 2, 'Settings'), contents(30, 3, 'Fixture A', true)]
    const snapshot = await getRuntimeProcessSnapshot()
    expect(snapshot.processes.map(item => item.role)).toEqual(['main', 'interface', 'webpage', 'gpu', 'network', 'audio', 'video', 'utility'])
    expect(snapshot.processes[0].name).toBe('SidekickAI')
    expect(snapshot.processes[2].targets[0]).toMatchObject({ title: 'Fixture A', kind: 'webpage' })
    expect(snapshot.processes[2].cpuPercent).toBe(1.5)
    expect(snapshot.processes[2].memoryBytes).toBe(1048576)
    expect(snapshot.capturedAt).toBeGreaterThan(0)
  })

  it('prefers Windows private working set over the shared-page working set fallback', async () => {
    fixture.metrics.push(metric(1, 'Browser'))
    privateWorkingSet.map = new Map([[1, 4096]])
    const snapshot = await getRuntimeProcessSnapshot()
    expect(privateWorkingSet.read).toHaveBeenCalledWith([1])
    expect(snapshot.processes[0].memoryBytes).toBe(4096)
  })

  it('keeps all pages sharing a PID and identifies separate subframe processes', async () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'Tab')]
    const guest = contents(30, 2, 'Fixture A', true)
    guest.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 3 }, { osProcessId: 3 }]
    fixture.contents = [contents(20, 2, 'Main'), guest, contents(40, 2, 'Fixture B', true)]
    const snapshot = await getRuntimeProcessSnapshot()
    // 界面与两个网页面同进程：不能整体归为界面，否则这一整块内存会漏出预算
    expect(snapshot.processes[0].role).toBe('mixed')
    expect(snapshot.processes[0].targets.map(target => target.title)).toEqual(['Main', 'Fixture A', 'Fixture B'])
    // 同一 guest 的两个子框架各占一行是既有行为：它们属于不同的框架行，
    // 真实进程里同一个 webContents 在同一 pid 上只会留一行
    expect(snapshot.processes[1].targets[0]).toMatchObject({ kind: 'subframe', title: 'Fixture A' })
    expect(snapshot.processes[2]).toMatchObject({ role: 'renderer', targets: [] })
  })

  it('judges a page by its webContents type even when it shares the interface process', async () => {
    // 界面窗口与 guest 共用一个 pid：宿主的帧树也把 guest 列了一遍
    fixture.metrics = [metric(2, 'Tab')]
    const host = contents(20, 2, 'Main window')
    host.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 2 }]
    const guest = contents(30, 2, 'Fixture A', true)
    guest.hostWebContents = host as any
    fixture.contents = [host, guest]
    const snapshot = await getRuntimeProcessSnapshot()
    expect(snapshot.processes[0].role).toBe('mixed')
    expect(snapshot.processes[0].targets.map(target => target.kind)).toEqual(['window', 'webpage'])
    expect(snapshot.processes[0].targets.map(target => target.webContentsId)).toEqual([20, 30])
  })

  it('counts a guest that shares its PID with the interface process', async () => {
    // 真正影响预算的是这一条：共享 pid 时该进程必须仍被判为参与预算的角色
    fixture.metrics = [metric(2, 'Tab')]
    fixture.contents = [contents(20, 2, 'Settings'), contents(30, 2, 'Fixture A', true)]
    expect((await getRuntimeProcessSnapshot()).processes[0].role).toBe('mixed')
  })

  it('deduplicates a repeated webpage row inside one process', async () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab')]
    // 同一个 guest 在帧树里被列出两次：同一进程只应留一行
    const guest = contents(30, 2, 'Fixture A', true)
    guest.mainFrame.framesInSubtree = [{ osProcessId: 3 }, { osProcessId: 3 }]
    fixture.contents = [guest, contents(40, 2, 'Fixture B', true)]
    const snapshot = await getRuntimeProcessSnapshot()
    expect(snapshot.processes[0]).toMatchObject({ role: 'webpage' })
    expect(snapshot.processes[0].targets).toHaveLength(2)
    expect(snapshot.processes[1].targets).toHaveLength(1)
    expect(snapshot.processes[1].targets[0]).toMatchObject({ kind: 'subframe' })
  })

  it('keeps an interface OOPIF out of the page budget while pages stay pages', async () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'Tab')]
    const host = contents(20, 2, 'Main window')
    host.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 4 }, { osProcessId: 4 }]
    const guest = contents(30, 3, 'Fixture A', true)
    guest.mainFrame.framesInSubtree = [{ osProcessId: 3 }]
    fixture.contents = [host, guest]
    const snapshot = await getRuntimeProcessSnapshot()
    expect(snapshot.processes[0]).toMatchObject({ role: 'interface' })
    expect(snapshot.processes[1]).toMatchObject({ role: 'webpage' })
    // 界面窗口的跨源 iframe 专属进程：界面帧树不参与统计，因此没有身份行
    expect(snapshot.processes[2]).toMatchObject({ role: 'renderer', targets: [] })
  })

  it('tolerates destroyed contents and navigation races while retaining available associations', async () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab')]
    const transitioning = contents(20, 2, 'Fixture A', true)
    Object.defineProperty(transitioning, 'mainFrame', { get: () => { throw new Error('Frame detached') } })
    fixture.contents = [{ isDestroyed: () => true }, { isDestroyed: () => { throw new Error('Destroyed') } },
      transitioning, contents(30, 3, 'Fixture B', true)]
    expect((await getRuntimeProcessSnapshot()).processes.map(item => item.targets[0]?.title)).toEqual(['Fixture A', 'Fixture B'])
  })

  it('identifies the embedded page by webContents type and its OOPIF subframes', async () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'Tab')]
    const host = contents(20, 2, 'Main window')
    host.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 3 }, { osProcessId: 4 }]
    const guest = contents(30, 3, 'Fixture A', true)
    guest.hostWebContents = host as any
    guest.mainFrame.framesInSubtree = [{ osProcessId: 3 }, { osProcessId: 4 }]
    fixture.contents = [host, guest]
    const snapshot = await getRuntimeProcessSnapshot()
    // 界面窗口只登记自己那一行：帧树里属于 guest 的行不再被算作界面内容
    expect(snapshot.processes[0]).toMatchObject({
      role: 'interface', targets: [{ webContentsId: 20, kind: 'window' }],
    })
    expect(snapshot.processes[1]).toMatchObject({ role: 'webpage', targets: [{ webContentsId: 30, kind: 'webpage', title: 'Fixture A' }] })
    expect(snapshot.processes[1].targets).toHaveLength(1)
    expect(snapshot.processes[2]).toMatchObject({ role: 'webpage', targets: [{ webContentsId: 30, kind: 'subframe', title: 'Fixture A' }] })
    expect(snapshot.processes[2].targets).toHaveLength(1)
  })

  it('uses only a hostname for unnamed webpages and omits their private URLs', async () => {
    fixture.metrics = [metric(2, 'Tab')]
    fixture.contents = [contents(20, 2, '', true)]
    const snapshot = await getRuntimeProcessSnapshot()
    expect(snapshot.processes[0].targets[0].title).toBe('example.test')
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|https:/)
  })

  it('does not retain associations when a PID is reused', async () => {
    fixture.metrics = [metric(2, 'Tab')]
    fixture.contents = [contents(20, 2, 'Previous page', true)]
    const previous = (await getRuntimeProcessSnapshot()).processes[0]
    fixture.contents = [contents(30, 2, 'New page', true)]
    fixture.metrics[0].creationTime += 5000
    const current = (await getRuntimeProcessSnapshot()).processes[0]
    expect(current.creationTime).not.toBe(previous.creationTime)
    expect(current.targets[0].title).toBe('New page')
  })

  it('reports invalid measurements as unavailable', async () => {
    fixture.metrics = [metric(2, 'GPU')]
    fixture.metrics[0].cpu.percentCPUUsage = Infinity
    fixture.metrics[0].memory.workingSetSize = NaN
    expect((await getRuntimeProcessSnapshot()).processes[0]).toMatchObject({ cpuPercent: null, memoryBytes: null })
  })

  it('authorizes IPC before reading any process information', async () => {
    registerRuntimeProcessesIPC()
    expect(fixture.handle).toHaveBeenCalledWith(IPC_CHANNELS.RUNTIME_PROCESSES_GET, expect.any(Function))
    const query = fixture.handle.mock.calls[0][1]
    fixture.authorize.mockImplementationOnce(() => { throw new Error('Untrusted renderer') })
    expect(() => query({})).toThrow('Untrusted renderer')
    expect(fixture.metricsRead).not.toHaveBeenCalled()
    await expect(query({})).resolves.toMatchObject({ processes: [] })
    expect(fixture.authorize).toHaveBeenCalledTimes(2)
    expect(fixture.metricsRead).toHaveBeenCalledTimes(1)
  })
})
