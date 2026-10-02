import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../hooks/draft-hook-test-harness');
  return createHookHarness();
});
const fixture = vi.hoisted(() => ({ openLogsFolder: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual('react'), ...runner.react,
  useMemo: (factory: any, dependencies: unknown[]) => runner.react.useCallback(factory, dependencies)(),
}));
vi.mock('../../lib/electron-api', async () => ({
  ...await vi.importActual('../../lib/electron-api'), openLogsFolder: fixture.openLogsFolder,
}));
vi.mock('../../hooks/useSettingsData', () => ({
  useAppSettings: () => ({ hiddenPlatforms: [], topBarVisibleButtons: [], altSpaceResetThreshold: 6 }),
  useVoiceConfig: () => ({}), useHotkeys: () => ({ hotkeys: [], drafts: {} }),
  usePresets: () => ({ platforms: [], presets: [] }),
}));
vi.mock('../../hooks/usePlatformUrlConfig', () => ({
  usePlatformUrlConfig: () => ({ profiles: [], openProfileIds: new Set() }),
}));
vi.mock('../../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../StandaloneWindowHeader', () => ({ default: 'window-header' }));
vi.mock('../../store/useModuleStore', () => ({
  useModuleStore: Object.assign(vi.fn(), { getState: () => ({ isEnabled: () => true }) }),
}));
vi.mock('../../store/useTabStore', () => ({
  useTabStore: (select: any) => select({ tabs: [], activeTabId: null }),
}));
import SettingsPanel from './index';
import SettingsView from '../../pages/SettingsView';
import AdvancedSection from './sections/AdvancedSection';
import LogFolderSection from './sections/LogFolderSection';

function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
const component = (value: unknown, name: string) => nodes(value).find(node => node.type?.name === name);

beforeEach(() => { runner.reset(); vi.clearAllMocks(); });
afterEach(() => { runner.unmount(); vi.unstubAllGlobals(); });

describe('settings log folder entry', () => {
  it('keeps standalone log access within the advanced category', async () => {
    const view = runner.mount(SettingsView);
    expect(nodes(view.current).some(node => node.props?.['data-name'] === 'settings.nav.logs')).toBe(false);
    const advanced = nodes(view.current).find(node => node.props?.['data-name'] === 'settings.nav.advanced')!;
    advanced.props.onClick(); await settleHooks();
    expect(component(view.current, 'LogFolderSection')).toBeDefined();
    expect(component(view.current, 'LogCenterSection')).toBeUndefined();
  });

  it('keeps sliding-panel log access within its expanded advanced settings', async () => {
    const view = runner.mount(() => SettingsPanel({ open: true, onClose() {} }));
    expect(component(view.current, 'LogCenterSection')).toBeUndefined();
    expect(component(view.current, 'LogFolderSection')).toBeUndefined();
    const advanced = component(view.current, 'AdvancedSection')!;
    expect(advanced).toBeDefined();
    const props = advanced.props;
    runner.unmount(); runner.reset();
    const detail = runner.mount(() => AdvancedSection(props));
    expect(component(detail.current, 'LogFolderSection')).toBeUndefined();
    nodes(detail.current).find(node => typeof node.props?.onToggle === 'function')!.props.onToggle();
    await settleHooks();
    expect(component(detail.current, 'LogFolderSection')).toBeDefined();
    expect(component(detail.current, 'LogCenterSection')).toBeUndefined();
  });

  it('invokes only the folder command and disables repeated activation while pending', async () => {
    const pending = deferred<void>();
    fixture.openLogsFolder.mockReturnValue(pending.promise);
    const view = runner.mount(LogFolderSection);
    const button = () => nodes(view.current).find(node => node.props?.['data-name'] === 'settings.advanced.logs.open-folder')!;
    expect(nodes(view.current).filter(node => typeof node.props?.onClick === 'function')).toHaveLength(1);
    button().props.onClick(); button().props.onClick(); await settleHooks();
    expect(fixture.openLogsFolder).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    expect(button().props['aria-busy']).toBe(true);
    pending.resolve(); await settleHooks();
    expect(button().props.disabled).toBe(false);
    expect(button().props['aria-busy']).toBe(false);
    expect(nodes(view.current).some(node => node.props?.role === 'alert')).toBe(false);
  });

  it('keeps a failed folder request retryable and clears failure when retrying', async () => {
    fixture.openLogsFolder.mockRejectedValueOnce(new Error('Directory unavailable'));
    const view = runner.mount(LogFolderSection);
    const button = () => nodes(view.current).find(node => node.props?.['data-name'] === 'settings.advanced.logs.open-folder')!;
    button().props.onClick(); await settleHooks();
    const error = nodes(view.current).find(node => node.props?.role === 'alert');
    expect(error?.props.children).toBe('\u65e0\u6cd5\u6253\u5f00\u65e5\u5fd7\u6587\u4ef6\u5939\uff0c\u8bf7\u91cd\u8bd5');
    expect(button().props.disabled).toBe(false);
    const pending = deferred<void>(); fixture.openLogsFolder.mockReturnValue(pending.promise);
    button().props.onClick(); await settleHooks();
    expect(nodes(view.current).some(node => node.props?.role === 'alert')).toBe(false);
    expect(button().props.disabled).toBe(true);
    pending.resolve(); await settleHooks();
    expect(fixture.openLogsFolder).toHaveBeenCalledTimes(2);
    expect(button().props.disabled).toBe(false);
  });
});
