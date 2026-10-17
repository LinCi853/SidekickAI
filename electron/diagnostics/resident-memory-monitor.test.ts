import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ metrics: vi.fn(), allContents: vi.fn(), allWindows: vi.fn(), trim: vi.fn(), activity: vi.fn(), owner: vi.fn(), windowForContents: vi.fn() }))
vi.mock('electron', async () => {
 const { EventEmitter } = await import('node:events')
 return { app: Object.assign(new EventEmitter(), { getAppMetrics: fixture.metrics }), BrowserWindow: { getAllWindows: fixture.allWindows, fromWebContents: fixture.windowForContents }, webContents: { getAllWebContents: fixture.allContents } }
})
vi.mock('../utils/win32-foreground.js', () => ({ trimWorkingSet: fixture.trim, markForegroundActivity: fixture.activity }))
vi.mock('./resident-process-ownership.js', () => ({ backgroundWindowForProcess: fixture.owner }))
import { createResidentMemoryMonitor } from './resident-memory-monitor'
const MiB = 1024 * 1024
let contents: EventEmitter & Record<string, any>
let monitor: ReturnType<typeof createResidentMemoryMonitor> | undefined
const metrics = (seconds = 1) => [{ pid: 2, creationTime: 1000, type: 'Tab', memory: { workingSetSize: 200 * 1024, privateBytes: 300 * 1024 }, cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 99 } }]
const page = (pid: number) => Object.assign(new EventEmitter(), { id: pid, getOSProcessId: () => pid, getType: () => 'webview', isDestroyed: () => false, isCurrentlyAudible: () => false, isBeingCaptured: () => false, isLoading: () => false })
beforeEach(() => {
 vi.useFakeTimers(); vi.setSystemTime(100000)
 vi.stubEnv('SIDEKICK_RESIDENT_RECLAIM', '1')
 vi.stubGlobal('process', Object.assign(Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }), { getSystemMemoryInfo: () => ({ total: 8 * 1024 * 1024, free: 4 * 1024 * 1024 }) }))
 contents = page(2)
 fixture.owner.mockReturnValue(null)
 fixture.windowForContents.mockReturnValue(null)
 fixture.allContents.mockReturnValue([contents]); fixture.allWindows.mockReturnValue([]); fixture.metrics.mockReturnValue(metrics()); fixture.trim.mockResolvedValue({ beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 2 })
})
afterEach(() => { monitor?.stop(); monitor = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks() })
async function idleTick() { await monitor!.tick(); vi.setSystemTime(125000); await monitor!.tick() }
describe('resident memory monitor', () => {
 it.each(['isLoading', 'isCurrentlyAudible', 'isBeingCaptured', 'muted-video'])('keeps %s protection local to its window while reclaiming an unrelated idle renderer', async method => {
  const windows = [10, 20].map(id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } }))
  const protectedGuest: any = page(3), protectedShell: any = Object.assign(page(4), { getType: () => 'window' })
  fixture.allContents.mockReturnValue([contents, protectedGuest, protectedShell]); fixture.allWindows.mockReturnValue(windows)
  fixture.windowForContents.mockImplementation(c => c === contents ? windows[0] : windows[1])
  fixture.owner.mockImplementation(pid => pid === 2 ? windows[0] : pid === 3 || pid === 4 ? windows[1] : null)
  fixture.metrics.mockReturnValue([metrics()[0], ...[3, 4, 5, 6].map(pid => ({ ...metrics()[0], pid, type: pid < 5 ? 'Tab' : pid === 5 ? 'GPU' : 'Browser' }))])
  monitor = createResidentMemoryMonitor(() => false)
  if (method === 'muted-video') protectedGuest.emit('media-started-playing')
  else protectedGuest[method] = () => true
  await idleTick()
  expect(fixture.trim).toHaveBeenCalledOnce()
  expect(fixture.trim.mock.calls[0][0]).toBe(2)
  const snapshot = monitor.diagnostics().samples.at(-1) as { processes: { pid: number; protected: boolean }[] }
  expect(snapshot.processes.filter(p => p.protected).map(p => p.pid)).toEqual([3, 4, 5, 6])
 })
 it.each(['isLoading', 'muted-video'])('reclaims a separate guest in the same idle window during %s while protecting its shell and shared services', async method => {
  const background = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html' } })
  const protectedGuest: any = page(3), shell = Object.assign(page(4), { getType: () => 'window' })
  fixture.allContents.mockReturnValue([contents, protectedGuest, shell]); fixture.allWindows.mockReturnValue([background])
  fixture.windowForContents.mockReturnValue(background)
  fixture.owner.mockImplementation(pid => pid < 5 ? background : null)
  fixture.metrics.mockReturnValue([metrics()[0], ...[3, 4, 5].map(pid => ({ ...metrics()[0], pid, type: pid < 5 ? 'Tab' : 'GPU' }))])
  monitor = createResidentMemoryMonitor(() => false)
  if (method === 'muted-video') protectedGuest.emit('media-started-playing'); else protectedGuest.isLoading = () => true
  await idleTick()
  expect(fixture.trim.mock.calls.map(call => call[0])).toEqual([2])
 })
 it('protects a renderer shared by a quiet guest and its loading sibling', async () => {
  const background = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html' } })
  const sibling: any = page(2); sibling.isLoading = () => true
  fixture.allContents.mockReturnValue([contents, sibling]); fixture.allWindows.mockReturnValue([background])
  fixture.windowForContents.mockReturnValue(background); fixture.owner.mockReturnValue(background)
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('keeps unknown protected content ownership global', async () => {
  const background = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } })
  const unknown: any = page(3); unknown.isLoading = () => true
  fixture.allContents.mockReturnValue([contents, unknown]); fixture.allWindows.mockReturnValue([background])
  fixture.owner.mockReturnValue(background)
  fixture.windowForContents.mockImplementation(c => c === contents ? background : null)
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('rechecks window media protection between native calls without blocking a different idle window', async () => {
  const windows = [10, 20, 30].map(id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } }))
  const pages = [contents, page(3), page(4)]
  fixture.allContents.mockReturnValue(pages); fixture.allWindows.mockReturnValue(windows)
  fixture.windowForContents.mockImplementation(c => windows[pages.indexOf(c)])
  fixture.owner.mockImplementation(pid => windows[pid - 2])
  fixture.metrics.mockReturnValue(pages.map((_, index) => ({ ...metrics()[0], pid: index + 2 })))
  fixture.trim.mockImplementationOnce(async () => { pages[1].emit('media-started-playing'); return { beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 2 } })
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim.mock.calls.map(call => call[0])).toEqual([2, 4])
 })
 it('reclaims an idle background renderer while another window receives input', async () => {
  const background = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } })
  const foreground = page(3)
  fixture.allContents.mockReturnValue([contents, foreground]); fixture.allWindows.mockReturnValue([background])
  fixture.owner.mockImplementation(pid => pid === 2 ? background : null)
  fixture.metrics.mockReturnValue([metrics()[0], { ...metrics()[0], pid: 3, type: 'Browser' }])
  monitor = createResidentMemoryMonitor(() => false); await monitor.tick()
  vi.setSystemTime(125000); foreground.emit('input-event'); await monitor.tick()
  expect(fixture.trim).toHaveBeenCalledOnce()
  expect(fixture.trim.mock.calls[0][0]).toBe(2)
  expect(fixture.trim.mock.calls[0][4]).toBe(background)
 })
 it.each(['focus', 'input'])('rechecks background %s between native calls', async event => {
  const windows = [2, 3].map(() => Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } }))
  const other = page(3)
  let focused = false
  fixture.allContents.mockReturnValue([contents, other]); fixture.allWindows.mockReturnValue(windows)
  fixture.metrics.mockReturnValue([metrics()[0], { ...metrics()[0], pid: 3 }])
  fixture.owner.mockImplementation(pid => pid === 2 ? windows[0] : focused ? null : windows[1])
  fixture.trim.mockImplementationOnce(async () => {
   if (event === 'focus') { focused = true; windows[1].emit('focus') } else other.emit('input-event')
   return { beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 17 }
  })
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it('protects a background shell while input is delivered to its guest', async () => {
  const background = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { getURL: () => 'file:///app.html?mode=browser' } })
  const guest = page(3)
  fixture.allContents.mockReturnValue([contents, guest]); fixture.allWindows.mockReturnValue([background])
  fixture.owner.mockReturnValue(background); fixture.windowForContents.mockReturnValue(background)
  monitor = createResidentMemoryMonitor(() => false); await monitor.tick()
  vi.setSystemTime(125000); guest.emit('input-event'); await monitor.tick()
  expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('uses cumulative CPU deltas despite a different caller resetting instantaneous percent', async () => {
  monitor = createResidentMemoryMonitor(() => false); await idleTick(); expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it('continues reclaiming after a successful 17ms native call', async () => {
  fixture.trim.mockResolvedValue({ beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 17 })
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  vi.setSystemTime(190000); await monitor.tick()
  expect(fixture.trim).toHaveBeenCalledTimes(2)
 })
 it('retries native skips without consuming the successful cooldown', async () => {
  fixture.trim.mockResolvedValue(null)
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  vi.setSystemTime(156000); await monitor.tick()
  expect(fixture.trim).toHaveBeenCalledTimes(2)
 })
 it('reclaims a bounded batch of idle processes in one poll', async () => {
  fixture.metrics.mockReturnValue(Array.from({ length: 10 }, (_, index) => ({ ...metrics()[0], pid: index + 2 })))
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).toHaveBeenCalledTimes(8)
  expect(new Set(fixture.trim.mock.calls.map(call => call[0])).size).toBe(8)
 })
 it('covers all five standard processes before the next idle opportunity', async () => {
  fixture.metrics.mockReturnValue(Array.from({ length: 5 }, (_, index) => ({ ...metrics()[0], pid: index + 2 })))
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).toHaveBeenCalledTimes(5)
 })
 it('ends the larger batch when the first native operation spends its time budget', async () => {
  fixture.metrics.mockReturnValue(Array.from({ length: 5 }, (_, index) => ({ ...metrics()[0], pid: index + 2 })))
  fixture.trim.mockImplementationOnce(async () => {
   vi.setSystemTime(125151)
   return { beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 151 }
  })
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it('uses a browser-window allowance below the five GiB limit', async () => {
  fixture.allWindows.mockReturnValue(Array.from({ length: 11 }, (_, index) => Object.assign(new EventEmitter(), {
   isDestroyed: () => false, webContents: { getURL: () => index === 0 ? 'file:///app.html?windowId=main' : 'file:///app.html?mode=browser' },
  })))
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  const budget = (monitor.diagnostics().samples.at(-1) as { workingSetBudgetBytes: number }).workingSetBudgetBytes
  expect(budget).toBeGreaterThan(4 * 1024 * MiB)
  expect(budget).toBeLessThan(5 * 1024 * MiB)
 })
 it.each(['input', 'disabled', 'protected'])('stops the batch as soon as %s changes', async change => {
  let enabled = true, protectedWork = false
  fixture.metrics.mockReturnValue([metrics()[0], { ...metrics()[0], pid: 3 }])
  fixture.trim.mockImplementationOnce(async () => {
   if (change === 'input') contents.emit('input-event')
   if (change === 'disabled') enabled = false
   if (change === 'protected') protectedWork = true
   return { beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 17 }
  })
  monitor = createResidentMemoryMonitor(() => protectedWork, () => enabled); await idleTick()
  expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it.each(['isLoading', 'isCurrentlyAudible', 'isBeingCaptured'])('protects contents during %s', async method => {
  contents[method] = () => true; monitor = createResidentMemoryMonitor(() => false); await idleTick(); expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('protects muted media until every player has paused', async () => {
  monitor = createResidentMemoryMonitor(() => false)
  contents.emit('media-started-playing'); contents.emit('media-started-playing')
  await idleTick(); expect(fixture.trim).not.toHaveBeenCalled()
  contents.emit('media-paused'); vi.setSystemTime(130000); await monitor.tick(); expect(fixture.trim).not.toHaveBeenCalled()
  contents.emit('media-paused'); vi.setSystemTime(135000); await monitor.tick(); expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it('drops playback protection when its renderer exits', async () => {
  monitor = createResidentMemoryMonitor(() => false)
  contents.emit('media-started-playing'); await idleTick(); expect(fixture.trim).not.toHaveBeenCalled()
  contents.emit('render-process-gone'); vi.setSystemTime(130000); await monitor.tick(); expect(fixture.trim).toHaveBeenCalledOnce()
 })
 it('rechecks media playback between native calls and removes its listeners on stop', async () => {
  fixture.metrics.mockReturnValue([metrics()[0], { ...metrics()[0], pid: 3 }])
  fixture.trim.mockImplementationOnce(async () => {
   contents.emit('media-started-playing')
   return { beforeBytes: 200 * MiB, afterBytes: 40 * MiB, durationMs: 17 }
  })
  monitor = createResidentMemoryMonitor(() => false); await idleTick()
  expect(fixture.trim).toHaveBeenCalledOnce()
  monitor.stop()
  for (const event of ['media-started-playing', 'media-paused', 'render-process-gone']) expect(contents.listenerCount(event)).toBe(0)
 })
 it('protects application operations and recent input', async () => {
  let protectedWork = true; monitor = createResidentMemoryMonitor(() => protectedWork); await idleTick(); expect(fixture.trim).not.toHaveBeenCalled()
  protectedWork = false; contents.emit('input-event'); vi.setSystemTime(126000); await monitor.tick(); expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('skips busy cumulative CPU and does not reclaim a process with missing counters', async () => {
  monitor = createResidentMemoryMonitor(() => false); await monitor.tick(); fixture.metrics.mockReturnValue(metrics(2)); vi.setSystemTime(125000); await monitor.tick(); expect(fixture.trim).not.toHaveBeenCalled()
  fixture.metrics.mockReturnValue([{ ...metrics()[0], cpu: { percentCPUUsage: 0 } }]); vi.setSystemTime(150000); await monitor.tick(); expect(fixture.trim).not.toHaveBeenCalled()
 })
 it('honors the A/B switch and removes listeners when stopped', async () => {
  vi.stubEnv('SIDEKICK_RESIDENT_RECLAIM', '0'); monitor = createResidentMemoryMonitor(() => false); await idleTick(); expect(fixture.metrics).not.toHaveBeenCalled(); monitor.stop(); expect(contents.listenerCount('input-event')).toBe(0)
 })
})

it('honors a live developer toggle without restarting the app', async () => {
  let enabled = false;
  monitor = createResidentMemoryMonitor(() => false, () => enabled);
  await idleTick();
  expect(fixture.metrics).not.toHaveBeenCalled();
  enabled = true;
  await monitor.tick();
  vi.setSystemTime(150000); await monitor.tick();
  expect(fixture.trim).toHaveBeenCalledOnce();
  fixture.trim.mockClear(); enabled = false;
  vi.setSystemTime(400000); await monitor.tick();
  expect(fixture.trim).not.toHaveBeenCalled();
  expect(monitor.diagnostics().enabled).toBe(false);
});
