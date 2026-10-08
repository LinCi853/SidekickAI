import { beforeEach, expect, it, vi } from 'vitest'
import { createHookHarness, deferred, elements, settle } from '../../src/test/hook-harness'

const mocks = vi.hoisted(() => ({ hooks: null as any, installed: true, handlers: {} as Record<string, Function>, pending: false, recoveries: [] as any[],
  flush: vi.fn(), prepare: vi.fn(), close: vi.fn(), begin: vi.fn(), release: vi.fn(),
  preparation: vi.fn(), preparationEnd: vi.fn(), cloud: vi.fn(), start: vi.fn(), distribution: vi.fn() }))
vi.mock('react', () => ({ useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args), useCallback: (...args: any[]) => mocks.hooks.useCallback(...args) }))
vi.mock('../../installer-shared/uninstall/UninstallPage', () => ({ default: 'UninstallPage' }))
vi.mock('../../installer-shared/uninstall/api', () => ({ uninstallApi: {} }))
vi.mock('../../installer-shared/presentation/Wizard', () => ({ WizardShell: 'WizardShell', CloseConfirmation: 'CloseConfirmation', WizardDetails: 'WizardDetails' }))
vi.mock('./cloud', () => ({ hostContext: () => ({}), prepareCloudAssets: (...args: any[]) => mocks.cloud(...args) }))
import App from './App'

beforeEach(() => {
  vi.clearAllMocks(); mocks.installed = true; mocks.handlers = {}; mocks.pending = false; mocks.recoveries = []
  mocks.flush.mockResolvedValue(true)
  mocks.begin.mockResolvedValue(true)
  mocks.release.mockResolvedValue(undefined)
  mocks.preparation.mockResolvedValue(true)
  mocks.preparationEnd.mockResolvedValue(undefined)
  mocks.cloud.mockResolvedValue({ assets: [], resources: [], notice: '' })
  mocks.start.mockResolvedValue(true)
  mocks.distribution.mockResolvedValue({ sourcePath: 'E:/Staging/application.zip', bodyProof: 'body-proof', productVersion: '0.1.6',
    nativeArchitecture: 'x64', releaseId: '', releaseSha256: '', releaseProof: '' })
  mocks.prepare.mockImplementation(async (_directory, selected) => { mocks.pending = selected; return true })
  mocks.close.mockImplementation(async () => { if (mocks.pending) throw new Error('无法核对已有程序的启动身份'); return true })
  const subscribe = (name: string) => (callback: Function) => { mocks.handlers[name] = callback; return () => {} }
  vi.stubGlobal('window', { installer: {
    pendingInstallations: async () => mocks.recoveries,
    getInfo: async () => ({ version: '0.1.5-beta-rc', distributionMode: 'offline', perUserDefaultDir: 'E:/Apps/requested', features: [], options: [], licenses: [] }),
    scanInstallations: async () => ({ locations: mocks.installed ? [{ path: 'E:/Apps/requested', version: '0.1.5-beta-rc' }] : [], recommendedDir: 'E:/Apps/requested' }),
    readInstallConfig: async () => null, flushConfig: mocks.flush, setPendingLaunch: mocks.prepare, closeWindow: mocks.close,
    beginCompletion: mocks.begin, endCompletion: mocks.release,
    beginPreparation: mocks.preparation, endPreparation: mocks.preparationEnd, start: mocks.start,
    prepareDistribution: mocks.distribution, onDistributionProgress: subscribe('distribution'), cancelDistribution: async () => true,
    onStatus: subscribe('status'), onProgress: subscribe('progress'), onLog: subscribe('log'), onDone: subscribe('done'),
    onError: subscribe('error'), onCloseRequested: subscribe('systemClose'),
  } })
})

async function completed() {
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => App())
  render(); await settle(); render(); await settle(); render()
  mocks.handlers.done({ installDir: 'E:/Apps/actual' })
  render()
  return { render, footer: () => elements(render().props.footer).filter(element => element.type === 'button') }
}

async function readyToInstall() {
  mocks.installed = false
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => App())
  render(); await settle(); render(); await settle(); render()
  const primary = () => elements(render().props.footer).find(element => element.type === 'button' && element.props.className.includes('primary'))!
  primary().props.onClick(); render()
  primary().props.onClick(); render()
  return { render, primary }
}

it('offers recovery on reopening and uses the original scope without downloading resources', async () => {
  mocks.recoveries = [{ installDir: 'E:/Apps/interrupted', forAllUsers: true, cleanupPaths: ['E:/Apps/previous'], journalPath: 'E:/Apps/journal', state: 'active' }]
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => App())
  render(); await settle(); render(); await settle()
  const button = elements(render().props.footer).find(element => element.type === 'button' && element.props.className.includes('primary'))!
  expect(button.props.children).toBe('恢复中断的安装')
  await button.props.onClick(); await settle()
  expect(mocks.cloud).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ installDir: 'E:/Apps/interrupted', forAllUsers: true, cleanupPaths: ['E:/Apps/previous'], cloudAssets: [] }))
})

it('preserves installed settings when closing after committed recovery cleanup', async () => {
  mocks.recoveries = [{ installDir: 'E:/Apps/interrupted', forAllUsers: true, cleanupPaths: [], journalPath: 'E:/Apps/journal', state: 'committed' }]
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => App())
  render(); await settle(); render(); await settle()
  const primary = () => elements(render().props.footer).find(element => element.type === 'button' && element.props.className.includes('primary'))!
  expect(primary().props.children).toBe('继续清理恢复副本')
  await primary().props.onClick(); await settle()
  mocks.recoveries = []
  mocks.handlers.done({ installDir: 'E:/Apps/interrupted' })
  render().props.onClose(); await settle()
  expect(mocks.flush).not.toHaveBeenCalled()
  expect(mocks.prepare).toHaveBeenCalledWith('E:/Apps/interrupted', false, false)
})

it('sends the selected staging location when retrying installation', async () => {
  const page = await readyToInstall()
  const location = elements(page.render()).find(element => typeof element.props.setStagingDir === 'function')!
  location.props.setStagingDir('E:/Install staging')
  page.render()
  await page.primary().props.onClick(); await settle()
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ stagingDir: 'E:/Install staging' }))
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ distributionSourcePath: 'E:/Staging/application.zip',
    distributionBodyProof: 'body-proof', distributionProductVersion: '0.1.6', distributionReleaseProof: '' }))
})

it('title-bar closure skips a selected launch after successful repair', async () => {
  const page = await completed()
  page.render().props.onClose(); await settle()
  expect(mocks.prepare).toHaveBeenCalledWith('E:/Apps/actual', false, false)
  expect(mocks.flush).not.toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('leaves direct closure usable after the selected application launch fails', async () => {
  const page = await completed()
  page.footer().find(button => button.props.className.includes('primary'))!.props.onClick()
  await settle(); page.render()
  expect(mocks.prepare).toHaveBeenCalledWith('E:/Apps/actual', true, false)
  mocks.handlers.systemClose(); await settle()
  expect(mocks.prepare).toHaveBeenLastCalledWith('E:/Apps/actual', false, false)
  expect(mocks.close).toHaveBeenCalledTimes(2)
})

it('retains explicit opening and closure actions after a rejected launch', async () => {
  const page = await completed()
  expect(page.footer().map(button => button.props.children)).toEqual(['关闭向导', '打开本次安装的程序'])
  page.footer()[1].props.onClick(); await settle()
  expect(mocks.prepare).toHaveBeenCalledWith('E:/Apps/actual', true, false)
  expect(page.footer().map(button => button.props.children)).toEqual(['关闭向导', '打开本次安装的程序'])
  mocks.close.mockResolvedValue(true)
  page.footer()[1].props.onClick(); await settle()
  expect(mocks.prepare).toHaveBeenLastCalledWith('E:/Apps/actual', true, false)
  expect(mocks.close).toHaveBeenCalledTimes(2)
})

it('saves new-install settings before explicit closure without launching', async () => {
  mocks.installed = false
  const page = await completed()
  page.footer().find(button => button.props.children === '关闭向导')!.props.onClick()
  await settle()
  expect(mocks.flush).toHaveBeenCalledWith(expect.objectContaining({ installDir: 'E:/Apps/actual', launchAfterInstall: false }))
  expect(mocks.prepare).toHaveBeenCalledWith('E:/Apps/actual', false, false)
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('admits only one concurrent completion operation', async () => {
  const pending = deferred<boolean>()
  mocks.close.mockReturnValue(pending.promise)
  const page = await completed()
  const button = page.footer().find(button => button.props.className.includes('primary'))!
  button.props.onClick(); button.props.onClick(); await settle()
  expect(mocks.begin).toHaveBeenCalledTimes(1)
  expect(mocks.release).not.toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalledTimes(1)
  pending.resolve(true); await settle()
  expect(mocks.release).toHaveBeenCalledTimes(1)
})

it('shows native completion stages and closes automatically after one successful opening', async () => {
  const pending = deferred<boolean>()
  mocks.close.mockReturnValue(pending.promise)
  const page = await completed()
  page.footer()[1].props.onClick(); await settle()
  mocks.handlers.status('正在等待本次安装的窗口就绪…')
  const done = elements(page.render()).find(element => typeof element.type === 'function' && element.type.name === 'StepDone')!
  expect(done.props.completionStatus).toBe('正在等待本次安装的窗口就绪…')
  pending.resolve(true); await settle()
  expect(mocks.close).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledTimes(1)
})

it('keeps the successful installation visible when application opening is pending', async () => {
  const page = await completed()
  page.footer().find(button => button.props.className.includes('primary'))!.props.onClick()
  await settle()
  const done = elements(page.render()).find(element => typeof element.type === 'function' && element.type.name === 'StepDone')!
  expect(done.props.closeBanner).toContain('安装已完成')
  expect(done.props.closeBanner).toContain('无法核对已有程序的启动身份')
  expect(done.props.closeBanner).not.toContain('尚未成功')
  expect(mocks.release).toHaveBeenCalledTimes(1)
})

it('starts no completion transaction after losing admission to another entry', async () => {
  mocks.begin.mockResolvedValue(false)
  const page = await completed()
  page.footer().find(button => button.props.className.includes('primary'))!.props.onClick()
  await settle()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.flush).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
})

it('occupies the wizard before resource preparation until native start is admitted', async () => {
  const pending = deferred<boolean>()
  mocks.start.mockReturnValue(pending.promise)
  const page = await readyToInstall()
  page.primary().props.onClick(); await settle()
  expect(mocks.preparation).toHaveBeenCalledTimes(1)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ launchAfterInstall: false }))
  expect(mocks.preparation.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0])
  if (mocks.cloud.mock.calls.length) expect(mocks.preparation.mock.invocationCallOrder[0]).toBeLessThan(mocks.cloud.mock.invocationCallOrder[0])
  expect(mocks.preparationEnd).not.toHaveBeenCalled()
  pending.resolve(true); await settle()
  expect(mocks.preparationEnd).toHaveBeenCalledTimes(1)
})

it('starts neither resource preparation nor deployment when wizard switching wins admission', async () => {
  mocks.preparation.mockResolvedValue(false)
  const page = await readyToInstall()
  page.primary().props.onClick(); await settle()
  expect(mocks.cloud).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.preparationEnd).not.toHaveBeenCalled()
  const operation = elements(page.render()).find(element => typeof element.type === 'function' && element.type.name === 'StepInstalling')!
  expect(operation.props.errorMsg).toBe('')
})

it('keeps bundled installation offline and reports only applicable resource behavior', async () => {
  const page = await readyToInstall()
  const details = elements(page.render()).find(element => Array.isArray(element.props.summary))!
  expect(details.props.summary.find(([label]: string[]) => label === '设置与资源')[1]).toBe('应用本次所选设置，内置工具与默认内容随本体提供')
  await page.primary().props.onClick(); await settle()
  expect(mocks.cloud).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ features: {}, cloudAssets: [], resources: [] }))
})
