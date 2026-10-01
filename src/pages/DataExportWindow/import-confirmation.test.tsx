import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createHookHarness, elements, settle } from '../../test/hook-harness'
const mocks = vi.hoisted(() => ({ hooks: null as any, inspection: { success: true, mode: 'limited', message: '仅导入网页登录态、AI 应用、设备预设和 API 配置。', fingerprint: 'confirmed-bytes' } as any, select: vi.fn(), detect: vi.fn(), inspect: vi.fn(), plain: vi.fn(), encrypted: vi.fn(), confirm: vi.fn() }))
vi.mock('react', () => Object.fromEntries(['useState', 'useRef', 'useMemo', 'useEffect'].map(name => [name, (...args: any[]) => mocks.hooks[name](...args)])))
vi.mock('../../components/PluginFrame', () => ({ registerHostCloseGuard: () => () => {} }))
vi.mock('../../hooks/useWindowDraft', () => ({ useWindowDraft() {} }))
vi.mock('../../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow() {} }))
vi.mock('../../hooks/useWindowMaximizedAndPinned', () => ({ useWindowMaximizedAndPinned: () => ({ isMaximized: false, isPinned: false, handleMaximize() {}, handleTogglePin() {} }) }))
vi.mock('../../components/WindowResizeHandles', () => ({ default: 'ResizeHandles' }))
vi.mock('../../components/ui', () => ({ IconButton: 'IconButton', PinToggleButton: 'PinToggleButton' }))
vi.mock('@/components/icons', () => ({ AlertIcon: 'AlertIcon' }))
vi.mock('../../lib/electron-api', () => ({ minimizeWindow() {}, closeCurrentWindow() {}, estimateExportSizes: async () => ({ basicData: 1, cookies: 0, indexedDB: 0, cache: 0, voiceAssets: 0 }), selectExportPath() {}, exportData() {}, selectImportFile: mocks.select, detectBackupEncrypted: mocks.detect, inspectBackup: mocks.inspect, importData: mocks.plain, importDataDecrypted: mocks.encrypted, getPlatformCapabilities: async () => ({ deviceId: 'target' }) }))
import DataExportWindow from './index'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.select.mockResolvedValue('backup.zip'); mocks.detect.mockResolvedValue(false)
  mocks.inspection = { success: true, mode: 'limited', message: '仅导入网页登录态、AI 应用、设备预设和 API 配置。', fingerprint: 'confirmed-bytes' }
  mocks.inspect.mockImplementation(async () => mocks.inspection)
  mocks.confirm.mockReturnValue(true); mocks.plain.mockResolvedValue({ success: true }); mocks.encrypted.mockResolvedValue({ success: true })
  vi.stubGlobal('window', { confirm: mocks.confirm, setTimeout, clearTimeout })
})
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const runner = createHookHarness(); mocks.hooks = runner.hooks
  const render = () => runner.render(() => DataExportWindow())
  const field = (name: string) => elements(render()).find(element => element.props['data-name'] === `data-export.${name}`)!
  return { field, runner }
}
it.each(['limited', 'full'])('shows the inspected %s range and binds execution to the confirmed archive', async mode => {
  mocks.inspection.mode = mode; mocks.inspection.message = mode === 'full' ? '完整恢复并重启。' : mocks.inspection.message
  const { field, runner } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  await field('confirm-import-button').props.onClick(); await settle()
  expect(mocks.inspect).toHaveBeenCalledWith('backup.zip', undefined)
  expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining(mocks.inspection.message))
  expect(mocks.plain).toHaveBeenCalledWith('backup.zip', 'confirmed-bytes')
  runner.unmount()
})
it('checks the password before displaying the actual range and uses the existing encrypted action', async () => {
  mocks.detect.mockResolvedValue(true)
  const { field, runner } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  field('import-password-input').props.onChange({ target: { value: 'password' } })
  await field('import-decrypt-button').props.onClick(); await settle()
  expect(mocks.inspect).toHaveBeenCalledWith('backup.zip', 'password')
  expect(mocks.encrypted).toHaveBeenCalledWith('backup.zip', 'password', 'confirmed-bytes')
  expect(mocks.plain).not.toHaveBeenCalled()
  runner.unmount()
})
it.each(['failed', 'cancelled'])('keeps execution unavailable when inspection is %s', async state => {
  if (state === 'failed') mocks.inspection = { success: false, error: 'Damaged backup' }
  else mocks.confirm.mockReturnValue(false)
  const { field, runner } = fixture()
  await field('select-file-button').props.onClick(); await settle()
  await field('confirm-import-button').props.onClick(); await settle()
  expect(mocks.plain).not.toHaveBeenCalled(); expect(mocks.encrypted).not.toHaveBeenCalled()
  if (state === 'failed') expect(mocks.confirm).not.toHaveBeenCalled()
  runner.unmount()
})
