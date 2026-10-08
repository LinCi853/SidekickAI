import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createHookHarness, elements, settle } from '../../test/hook-harness'
const mocks = vi.hoisted(() => ({ hooks: null as any, inspection: {} as any, select: vi.fn(), detect: vi.fn(), inspect: vi.fn(), plain: vi.fn(), encrypted: vi.fn(), confirm: vi.fn(), alert: vi.fn(), export: vi.fn(), save: vi.fn() }))
vi.mock('react', () => Object.fromEntries(['useState', 'useRef', 'useEffect'].map(name => [name, (...args: any[]) => mocks.hooks[name](...args)])))
vi.mock('../../components/PluginFrame', () => ({ registerHostCloseGuard: () => () => {} }))
vi.mock('../../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow() {} }))
vi.mock('../../hooks/useWindowMaximizedAndPinned', () => ({ useWindowMaximizedAndPinned: () => ({ isMaximized: false, isPinned: false, handleMaximize() {}, handleTogglePin() {} }) }))
vi.mock('../../components/WindowResizeHandles', () => ({ default: 'ResizeHandles' }))
vi.mock('../../components/ui', () => ({ IconButton: 'IconButton', PinToggleButton: 'PinToggleButton' }))
vi.mock('../../lib/electron-api', () => ({ minimizeWindow() {}, closeCurrentWindow() {}, selectExportPath: mocks.save, exportData: mocks.export, selectImportFile: mocks.select, detectBackupEncrypted: mocks.detect, inspectBackup: mocks.inspect, importData: mocks.plain, importDataDecrypted: mocks.encrypted }))
import DataExportWindow from './index'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.select.mockResolvedValue('backup.zip'); mocks.detect.mockResolvedValue(false); mocks.save.mockResolvedValue('saved.zip')
  mocks.inspection = { success: true, mode: 'full', fingerprint: 'confirmed-bytes', report: { imported: [], skipped: [{ category: 'profiles', reason: 'Invalid entry' }], warnings: [] } }
  mocks.inspect.mockImplementation(async () => mocks.inspection)
  mocks.confirm.mockReturnValue(true); mocks.plain.mockResolvedValue({ success: true }); mocks.encrypted.mockResolvedValue({ success: true }); mocks.export.mockResolvedValue({ success: true })
  vi.stubGlobal('window', { confirm: mocks.confirm, alert: mocks.alert, setTimeout, clearTimeout })
})
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => DataExportWindow())
  const field = (name: string) => elements(render()).find(element => element.props['data-name'] === `data-export.${name}`)!
  return { field, runner, render }
}
it.each(['limited', 'full'])('automatically imports the verified %s scope with one confirmation', async mode => {
  mocks.inspection.mode = mode
  const { field, runner, render } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  await field('confirm-import-button').props.onClick(); await settle()
  expect(mocks.inspect).toHaveBeenCalledWith('backup.zip', undefined)
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(mocks.plain).toHaveBeenCalledWith('backup.zip', 'confirmed-bytes')
  expect(elements(render()).filter(element => typeof element.type === 'string' && ['select', 'details', 'fieldset'].includes(element.type))).toHaveLength(0)
  runner.unmount()
})
it('reports a wrong password once and allows correction without persistent failure state', async () => {
  mocks.detect.mockResolvedValue(true)
  const { field, runner } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  field('import-password-input').props.onChange({ target: { value: 'wrong' } })
  mocks.inspection = { success: false, error: '密码错误' }
  await field('import-decrypt-button').props.onClick(); await settle()
  expect(mocks.alert).toHaveBeenCalledOnce()
  expect(mocks.alert).toHaveBeenCalledWith('密码错误')
  expect(field('status')).toBeUndefined()
  expect(mocks.encrypted).not.toHaveBeenCalled()
  field('import-password-input').props.onChange({ target: { value: 'correct' } })
  mocks.inspection = { success: true, mode: 'full', fingerprint: 'verified' }
  await field('import-decrypt-button').props.onClick(); await settle()
  expect(mocks.encrypted).toHaveBeenCalledWith('backup.zip', 'correct', 'verified')
  expect(mocks.alert).toHaveBeenCalledOnce()
  runner.unmount()
})
it('does not import when replacement is cancelled', async () => {
  mocks.confirm.mockReturnValue(false)
  const { field, runner } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  await field('confirm-import-button').props.onClick(); await settle()
  expect(mocks.plain).not.toHaveBeenCalled()
  expect(mocks.alert).not.toHaveBeenCalled()
  runner.unmount()
})
it('exports useful data with automatic defaults and optional encryption', async () => {
  const { field, runner } = fixture()
  field('encrypt-password-input').props.onChange({ target: { value: 'secret123' } })
  await field('export-button').props.onClick(); await settle()
  expect(mocks.save).toHaveBeenCalledWith(true)
  expect(mocks.export).toHaveBeenCalledWith('saved.zip', { basicData: true, cookies: true, indexedDB: true, cache: false, voiceAssets: false }, { password: 'secret123' })
  expect(field('encrypt-password-input').props.value).toBe('')
  runner.unmount()
})
it('shows one export failure popup and leaves no failure record on the page', async () => {
  mocks.export.mockResolvedValue({ success: false, error: 'Disk unavailable' })
  const { field, runner } = fixture()
  await field('export-button').props.onClick(); await settle()
  expect(mocks.alert).toHaveBeenCalledOnce()
  expect(mocks.alert).toHaveBeenCalledWith('Disk unavailable')
  expect(field('status')).toBeUndefined()
  runner.unmount()
})
