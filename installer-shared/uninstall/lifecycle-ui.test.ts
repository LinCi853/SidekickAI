import { afterEach, expect, it, vi } from 'vitest'
import { createHookHarness, settleHooks } from '../../src/hooks/draft-hook-test-harness'
import type { UninstallApi, UninstallEvent, UninstallRecoveryTask, UninstallRequest, UninstallResult } from './protocol'

const fixture = vi.hoisted(() => ({ runtime: null as any }))
vi.mock('react', () => ({
  useRef: (...args: any[]) => fixture.runtime.react.useRef(...args),
  useState: (...args: any[]) => fixture.runtime.react.useState(...args),
  useCallback: (...args: any[]) => fixture.runtime.react.useCallback(...args),
  useEffect: (...args: any[]) => fixture.runtime.react.useEffect(...args),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const reference = fixture.runtime.react.useRef(null)
    if (!reference.current || deps.some((value, index) => value !== reference.current.deps[index])) reference.current = { value: factory(), deps }
    return reference.current.value
  },
}))
vi.mock('./api', () => ({ uninstallApi: {} }))
vi.mock('../presentation/Wizard', () => ({ WizardShell: 'wizard-shell', CloseConfirmation: 'close-confirmation', DataPolicyPicker: 'data-policy' }))
vi.mock('../operation-details/OperationDetails', () => ({ default: 'operation-details' }))
import UninstallPage from './UninstallPage'

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.footer)]
}
function text(tree: any): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  return tree && typeof tree === 'object' ? text(tree.props?.children) + ' ' + text(tree.props?.footer) : ''
}
function button(tree: any, label: string): any {
  const found = nodes(tree).find(node => node.type === 'button' && text(node).trim() === label)
  expect(found, `button ${label}`).toBeTruthy()
  return found
}

afterEach(() => vi.unstubAllGlobals())
async function mount(recoveryTasks: UninstallRecoveryTask[] = []) {
  const harness = createHookHarness(); harness.reset(); fixture.runtime = harness
  let listener: (event: UninstallEvent) => void = () => {}
  const requests: UninstallRequest[] = []
  const api: UninstallApi = {
    getInfo: async () => ({ protocolVersion: 2, uninstallerVersion: '1.1.0', hostArch: 'x64', entry: 'standalone', supportsBackup: true, supportsElevation: true, supportsSilent: false }),
    scan: async () => ({ scanId: 'scan', generatedAt: 'now', dataRoots: [], recoveryTasks, recommendedTargetId: { token: 'target' },
      locations: recoveryTasks.length ? [] : [{ id: { token: 'target' }, edition: 'community', path: 'E:/fixture/app', displayPath: 'E:/fixture/app', source: ['installed'], scope: 'perUser',
        arch: 'x64', version: '1.0.0', registered: false, registeredRoots: [], executablePresent: true, resourcesPresent: true, identityConfidence: 'strong', runningPids: [], removable: true, recommended: true }] }),
    start: async request => { requests.push(request); return { requestId: request.requestId, operationId: `operation-${requests.length}`, state: 'accepted' } },
    cancel: async operationId => ({ operationId, accepted: false, state: 'tooLate' }), close: async () => {}, chooseBackupPath: async () => '',
    onEvent: callback => { listener = callback; return () => {} },
  }
  const view = harness.mount(() => UninstallPage({ api })); await settleHooks()
  const finish = async (partial: Partial<UninstallResult>) => {
    const request = requests.at(-1)!
    const result: UninstallResult = { requestId: request.requestId, operationId: `operation-${requests.length}`, state: 'failed', phase: 'failed',
      targetIds: [], removedInstallPaths: [], removedDataRoots: [], warnings: [], ...partial }
    listener({ protocolVersion: 2, requestId: result.requestId, operationId: result.operationId, sequence: 1, phase: result.phase,
      progress: 0, message: 'terminal result', terminal: true, result })
    await settleHooks()
  }
  return { view, requests, finish, harness }
}

it('retains the task identity and verified backup after a failed uninstall', async () => {
  const app = await mount()
  button(app.view.current, '继续').props.onClick(); await settleHooks()
  button(app.view.current, '开始卸载').props.onClick(); await settleHooks()
  const first = app.requests[0]
  await app.finish({ backups: [{ path: 'F:/backup/verified.zip', format: 'zip', categories: ['basicData'], verified: true }] })
  expect(text(app.view.current)).toContain('完整备份已验证')
  expect(text(app.view.current)).toContain('F:/backup/verified.zip')
  button(app.view.current, '重新扫描并继续').props.onClick(); await settleHooks()
  button(app.view.current, '继续').props.onClick(); await settleHooks()
  button(app.view.current, '开始卸载').props.onClick(); await settleHooks()
  expect(app.requests[1].requestId).toBe(first.requestId)
  expect(app.requests[1].resumeTaskId).toBe(first.requestId)
  app.harness.unmount()
})

it('offers persisted recovery without an installed application and labels pending cleanup', async () => {
  const task: UninstallRecoveryTask = { taskId: 'persistent-task', state: 'cleaning', installPaths: ['E:/fixture/app'], dataPaths: [],
    residualPaths: ['E:/fixture/.quarantine/content'], requiresElevation: false, message: '程序已卸载，等待残留文件释放。' }
  const app = await mount([task])
  button(app.view.current, '继续处理原任务').props.onClick(); await settleHooks()
  expect(app.requests[0].resumeTaskId).toBe(task.taskId)
  expect(app.requests[0].additionalTargetIds).toEqual([])
  await app.finish({ state: 'completed', phase: 'completed', warnings: ['CLEANUP_PENDING: E:/fixture/.quarantine/content'] })
  expect(text(app.view.current)).toContain('程序已卸载，待清理残留')
  expect(button(app.view.current, '重新扫描并继续')).toBeTruthy()
  app.harness.unmount()
})
