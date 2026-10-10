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
vi.mock('../security/trusted-renderer.js', () => ({ assertTrustedRenderer: fixture.authorize }))
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

beforeEach(() => { fixture.metrics = []; fixture.contents = []; vi.resetAllMocks() })

describe('runtime process snapshot', () => {
  it('separates interface, webpage, GPU, network, audio and generic services', () => {
    fixture.metrics = [metric(5, 'Utility', 'network.mojom.NetworkService'), metric(1, 'Browser'),
      metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'GPU'), metric(6, 'Utility', 'audio.mojom.AudioService'),
      metric(7, 'Utility', 'video_capture.mojom.VideoCaptureService'), metric(8, 'Utility', 'custom-service')]
    fixture.contents = [contents(20, 2, 'Settings'), contents(30, 3, 'Fixture A', true)]
    const snapshot = getRuntimeProcessSnapshot()
    expect(snapshot.processes.map(item => item.role)).toEqual(['main', 'interface', 'webpage', 'gpu', 'network', 'audio', 'video', 'utility'])
    expect(snapshot.processes[0].name).toBe('SidekickAI')
    expect(snapshot.processes[2].targets[0]).toMatchObject({ title: 'Fixture A', kind: 'webpage' })
    expect(snapshot.processes[2].cpuPercent).toBe(1.5)
    expect(snapshot.processes[2].memoryBytes).toBe(1048576)
    expect(snapshot.capturedAt).toBeGreaterThan(0)
  })

  it('keeps all pages sharing a PID and identifies separate subframe processes', () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'Tab')]
    const guest = contents(30, 2, 'Fixture A', true)
    guest.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 3 }, { osProcessId: 3 }]
    fixture.contents = [contents(20, 2, 'Main'), guest, contents(40, 2, 'Fixture B', true)]
    const snapshot = getRuntimeProcessSnapshot()
    expect(snapshot.processes[0].role).toBe('renderer')
    expect(snapshot.processes[0].targets.map(target => target.title)).toEqual(['Main', 'Fixture A', 'Fixture B'])
    expect(snapshot.processes[1]).toMatchObject({ role: 'webpage', targets: [{ kind: 'subframe', title: 'Fixture A' }] })
    expect(snapshot.processes[1].targets).toHaveLength(1)
    expect(snapshot.processes[2]).toMatchObject({ role: 'renderer', targets: [] })
  })

  it('tolerates destroyed contents and navigation races while retaining available associations', () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab')]
    const transitioning = contents(20, 2, 'Fixture A', true)
    Object.defineProperty(transitioning, 'mainFrame', { get: () => { throw new Error('Frame detached') } })
    fixture.contents = [{ isDestroyed: () => true }, { isDestroyed: () => { throw new Error('Destroyed') } },
      transitioning, contents(30, 3, 'Fixture B', true)]
    expect(getRuntimeProcessSnapshot().processes.map(item => item.targets[0]?.title)).toEqual(['Fixture A', 'Fixture B'])
  })

  it('replaces host-frame aliases with the actual embedded page and its subframes', () => {
    fixture.metrics = [metric(2, 'Tab'), metric(3, 'Tab'), metric(4, 'Tab')]
    const host = contents(20, 2, 'Main window')
    host.mainFrame.framesInSubtree = [{ osProcessId: 2 }, { osProcessId: 3 }, { osProcessId: 4 }]
    const guest = contents(30, 3, 'Fixture A', true)
    guest.hostWebContents = host as any
    guest.mainFrame.framesInSubtree = [{ osProcessId: 3 }, { osProcessId: 4 }]
    fixture.contents = [host, guest]
    const snapshot = getRuntimeProcessSnapshot()
    expect(snapshot.processes[0].targets).toHaveLength(1)
    expect(snapshot.processes[1]).toMatchObject({ role: 'webpage', targets: [{ webContentsId: 30, kind: 'webpage', title: 'Fixture A' }] })
    expect(snapshot.processes[1].targets).toHaveLength(1)
    expect(snapshot.processes[2]).toMatchObject({ role: 'webpage', targets: [{ webContentsId: 30, kind: 'subframe', title: 'Fixture A' }] })
    expect(snapshot.processes[2].targets).toHaveLength(1)
  })

  it('uses only a hostname for unnamed webpages and omits their private URLs', () => {
    fixture.metrics = [metric(2, 'Tab')]
    fixture.contents = [contents(20, 2, '', true)]
    const snapshot = getRuntimeProcessSnapshot()
    expect(snapshot.processes[0].targets[0].title).toBe('example.test')
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|https:/)
  })

  it('does not retain associations when a PID is reused', () => {
    fixture.metrics = [metric(2, 'Tab')]
    fixture.contents = [contents(20, 2, 'Previous page', true)]
    const previous = getRuntimeProcessSnapshot().processes[0]
    fixture.contents = [contents(30, 2, 'New page', true)]
    fixture.metrics[0].creationTime += 5000
    const current = getRuntimeProcessSnapshot().processes[0]
    expect(current.creationTime).not.toBe(previous.creationTime)
    expect(current.targets[0].title).toBe('New page')
  })

  it('reports invalid measurements as unavailable', () => {
    fixture.metrics = [metric(2, 'GPU')]
    fixture.metrics[0].cpu.percentCPUUsage = Infinity
    fixture.metrics[0].memory.workingSetSize = NaN
    expect(getRuntimeProcessSnapshot().processes[0]).toMatchObject({ cpuPercent: null, memoryBytes: null })
  })

  it('authorizes IPC before reading any process information', () => {
    registerRuntimeProcessesIPC()
    expect(fixture.handle).toHaveBeenCalledWith(IPC_CHANNELS.RUNTIME_PROCESSES_GET, expect.any(Function))
    const query = fixture.handle.mock.calls[0][1]
    fixture.authorize.mockImplementationOnce(() => { throw new Error('Untrusted renderer') })
    expect(() => query({})).toThrow('Untrusted renderer')
    expect(fixture.metricsRead).not.toHaveBeenCalled()
    expect(query({})).toMatchObject({ processes: [] })
    expect(fixture.authorize).toHaveBeenCalledTimes(2)
    expect(fixture.metricsRead).toHaveBeenCalledTimes(1)
  })
})
