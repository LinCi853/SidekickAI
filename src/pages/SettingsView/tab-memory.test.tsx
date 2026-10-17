import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleHooks } from '../../hooks/draft-hook-test-harness';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../hooks/draft-hook-test-harness');
  return createHookHarness();
});
const fixture = vi.hoisted(() => ({
  updateAppSettings: vi.fn(),
  update: vi.fn(),
  state: {
    lowMemoryMode: false,
  },
}));

vi.mock('react', async () => ({
  ...await vi.importActual('react'), ...runner.react,
  useMemo: (factory: any, dependencies: unknown[]) => runner.react.useCallback(factory, dependencies)(),
}));
vi.mock('../../lib/electron-api', async () => ({
  ...await vi.importActual('../../lib/electron-api'),
  updateAppSettings: fixture.updateAppSettings,
}));
vi.mock('../../hooks/useSettingsData', () => ({
  useAppSettings: () => ({
    ...fixture.state,
    update: fixture.update,
    load: vi.fn(),
  }),
  useVoiceConfig: () => ({}),
  useHotkeys: () => ({ hotkeys: [], drafts: {} }),
  usePresets: () => ({ platforms: [], presets: [] }),
}));
vi.mock('../../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../../components/StandaloneWindowHeader', () => ({ default: 'window-header' }));
vi.mock('../../components/ShortcutHelp', () => ({ default: 'shortcut-help' }));
vi.mock('../../components/WindowResizeHandles', () => ({ default: 'resize-handles' }));
vi.mock('../../store/useModuleStore', () => ({
  useModuleStore: Object.assign(vi.fn(), { getState: () => ({ isEnabled: () => true }) }),
}));
vi.mock('../../store/useUiVersionStore', () => ({
  useUiVersionStore: Object.assign(
    (selector: (s: { version: string }) => unknown) => selector({ version: 'classic' }),
    { getState: () => ({ version: 'classic' }) },
  ),
}));
vi.mock('../../store/useTabStore', () => ({
  useTabStore: (select: (value: unknown) => unknown) => select({ tabs: [], activeTabId: null }),
}));

import SettingsView from './index';

/** 收集渲染树中的全部元素节点 */
function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
const component = (value: unknown, name: string) => nodes(value).find(node => node.type?.name === name);
const byName = (value: unknown, name: string) => nodes(value).find(node => node.props?.['data-name'] === name)!;

beforeEach(() => { runner.reset(); vi.clearAllMocks(); fixture.update.mockResolvedValue(undefined); });
afterEach(() => { runner.unmount(); vi.unstubAllGlobals(); });
describe('single developer memory mode', () => {
  it('removes the advanced group and persists the developer toggle', async () => {
    const view = runner.mount(SettingsView);
    byName(view.current, 'settings.nav.advanced').props.onClick();
    await settleHooks();
    expect(component(view.current, 'TabMemorySection')).toBeUndefined();
    byName(view.current, 'settings.nav.developer').props.onClick();
    await settleHooks();
    const section = component(view.current, 'DeveloperOptionsSection');
    expect(section.props.lowMemoryMode).toBe(false);
    await section.props.onChangeLowMemoryMode(true);
    expect(fixture.update).toHaveBeenCalledWith({ lowMemoryMode: true });
    await section.props.onChangeLowMemoryMode(false);
    expect(fixture.update).toHaveBeenLastCalledWith({ lowMemoryMode: false });
  });
});
