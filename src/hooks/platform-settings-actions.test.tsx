import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from './draft-hook-test-harness';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('./draft-hook-test-harness');
  return createHookHarness();
});
const fixture = vi.hoisted(() => ({ app: {} as any, update: vi.fn(), refresh: null as any, read: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual('react'), ...runner.react,
  useMemo: (factory: any, dependencies: unknown[]) => runner.react.useCallback(factory, dependencies)(),
}));
vi.mock('../lib/electron-api', async () => ({ ...await vi.importActual('../lib/electron-api'), updateAppSettings: fixture.update }));
vi.mock('./useSettingsData', () => ({
  useAppSettings: (enabled: boolean) => { fixture.read(enabled); return fixture.app; },
  useVoiceConfig: () => ({}), useHotkeys: () => ({ hotkeys: [], drafts: {} }),
  usePresets: () => ({ platforms: [], presets: [] }),
}));
vi.mock('./usePlatformUrlConfig', () => ({ usePlatformUrlConfig: () => ({ profiles: [], openProfileIds: new Set() }) }));
vi.mock('./useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../components/StandaloneWindowHeader', () => ({ default: 'window-header' }));
vi.mock('../store/useModuleStore', () => ({ useModuleStore: Object.assign(vi.fn(), { getState: () => ({ isEnabled: () => true }) }) }));
vi.mock('../store/useTabStore', () => ({ useTabStore: (select: any) => select({ tabs: [], activeTabId: null }) }));
import SettingsPanel from '../components/SettingsPanel';
import SettingsView from '../pages/SettingsView';

type Entry = 'panel' | 'window';
function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function mount(entry: Entry, open = true) {
  return runner.mount(() => {
    const [, refresh] = runner.react.useState(0);
    fixture.refresh = () => refresh((value: number) => value + 1);
    return entry === 'panel' ? SettingsPanel({ open, onClose() {} }) : SettingsView();
  });
}
async function navigate(view: { current: unknown }, category: string) {
  nodes(view.current).find(node => node.props?.['data-name'] === `settings.nav.${category}`)!.props.onClick();
  await settleHooks();
}
async function action(entry: Entry, view: { current: unknown }, field: 'hideForeignModels' | 'disableAllBlockRules') {
  if (entry === 'window') await navigate(view, field === 'hideForeignModels' ? 'advanced' : 'developer');
  const property = field === 'hideForeignModels' ? (entry === 'panel' ? 'onToggleHideForeignModels' : 'onChange') : 'onToggleDisableAllBlockRules';
  const node = nodes(view.current).find(item => field === 'hideForeignModels' && entry === 'window'
    ? item.props?.['data-name'] === 'settings.advanced.hide-foreign-models-toggle'
    : typeof item.props?.[property] === 'function')!;
  return () => node.props[property]();
}
function thresholdInput(view: { current: unknown }) {
  return nodes(view.current).find(node => node.props?.['data-name'] === 'settings.appearance.alt-space-threshold-input')!;
}

beforeEach(() => {
  runner.reset(); vi.clearAllMocks();
  fixture.app = { hideForeignModels: true, disableAllBlockRules: false, altSpaceResetThreshold: 6,
    hiddenPlatforms: [], topBarVisibleButtons: [], };
  for (const field of ['hideForeignModels', 'disableAllBlockRules', 'altSpaceResetThreshold']) {
    const name = `set${field[0].toUpperCase()}${field.slice(1)}`;
    fixture.app[name] = vi.fn((value: unknown) => { fixture.app = { ...fixture.app, [field]: value }; fixture.refresh?.(); });
  }
  fixture.update.mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { runner.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(['panel', 'window'] as const)('%s setting actions', entry => {
  it.each(['hideForeignModels', 'disableAllBlockRules'] as const)('saves %s with immediate local feedback', async field => {
    const view = mount(entry); const invoke = await action(entry, view, field);
    const initial = fixture.app[field];
    await invoke();
    expect(fixture.app[field]).toBe(!initial);
    expect(fixture.update.mock.calls).toEqual([[{ [field]: !initial }]]);
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each(['hideForeignModels', 'disableAllBlockRules'] as const)('restores the invocation value of %s after rerender and rejection', async field => {
    const view = mount(entry); const invoke = await action(entry, view, field);
    const initial = fixture.app[field]; const pending = deferred<void>();
    fixture.update.mockReturnValue(pending.promise);
    const saved = invoke();
    await settleHooks();
    expect(fixture.app[field]).toBe(!initial);
    pending.reject(new Error('Unavailable')); await saved; await settleHooks();
    expect(fixture.app[field]).toBe(initial);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(entry === 'panel' ? '[SettingsPanel]' : '[SettingsView]'), expect.any(Error));
  });
  it('keeps repeated toggles as independent saves', async () => {
    const view = mount(entry); const first = deferred<void>(); const second = deferred<void>();
    fixture.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = (await action(entry, view, 'hideForeignModels'))(); await settleHooks();
    const b = (await action(entry, view, 'hideForeignModels'))();
    expect(fixture.update.mock.calls).toEqual([[{ hideForeignModels: false }], [{ hideForeignModels: true }]]);
    second.resolve(); await b; first.reject(new Error('Unavailable')); await a;
    expect(fixture.app.hideForeignModels).toBe(true);
  });
  it('reads enabled settings on reopening without retaining a separate action state', async () => {
    mount(entry, false); runner.unmount(); runner.reset();
    fixture.app = { ...fixture.app, hideForeignModels: false, altSpaceResetThreshold: 12 };
    const view = mount(entry); await settleHooks();
    expect(fixture.read).toHaveBeenLastCalledWith(true);
    await (await action(entry, view, 'hideForeignModels'))();
    expect(fixture.update).toHaveBeenCalledWith({ hideForeignModels: true });
  });
});

describe('threshold consumers', () => {
  it.each([[-3, 3], [6, 6], [90, 20]])('bounds the panel callback value %s to %s', async (value, expected) => {
    const view = mount('panel');
    const section = nodes(view.current).find(node => typeof node.props?.onAltSpaceThresholdChange === 'function')!;
    await section.props.onAltSpaceThresholdChange(value);
    expect(fixture.app.altSpaceResetThreshold).toBe(expected);
    expect(fixture.update).toHaveBeenCalledWith({ altSpaceResetThreshold: expected });
  });
  it('restores the panel threshold captured before an external update', async () => {
    const view = mount('panel'); const pending = deferred<void>(); fixture.update.mockReturnValue(pending.promise);
    const section = nodes(view.current).find(node => typeof node.props?.onAltSpaceThresholdChange === 'function')!;
    const saved = section.props.onAltSpaceThresholdChange(14); await settleHooks();
    fixture.app = { ...fixture.app, altSpaceResetThreshold: 9 }; fixture.refresh(); await settleHooks();
    pending.reject(new Error('Unavailable')); await saved; await settleHooks();
    expect(fixture.app.altSpaceResetThreshold).toBe(6);
  });
  it.each([['2', 3], ['99', 20], ['11.8', 11], ['9tail', 9]])('keeps standalone draft parsing for %s', async (draft, expected) => {
    const view = mount('window');
    thresholdInput(view).props.onChange({ target: { value: draft } }); await settleHooks();
    expect(fixture.update).not.toHaveBeenCalled();
    thresholdInput(view).props.onBlur(); await settleHooks();
    expect(fixture.update).toHaveBeenCalledWith({ altSpaceResetThreshold: expected });
    expect(thresholdInput(view).props.value).toBe(String(expected));
  });
  it.each(['', 'invalid', '6'])('does not save invalid or unchanged standalone draft %s', async draft => {
    const view = mount('window');
    thresholdInput(view).props.onChange({ target: { value: draft } }); await settleHooks();
    thresholdInput(view).props.onBlur(); await settleHooks();
    expect(thresholdInput(view).props.value).toBe('6');
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it('restores the standalone draft after the threshold save fails', async () => {
    const view = mount('window'); const pending = deferred<void>(); fixture.update.mockReturnValue(pending.promise);
    thresholdInput(view).props.onChange({ target: { value: '16' } }); await settleHooks();
    thresholdInput(view).props.onBlur(); await settleHooks();
    expect(thresholdInput(view).props.value).toBe('16');
    pending.reject(new Error('Unavailable')); await settleHooks();
    expect(thresholdInput(view).props.value).toBe('6');
    expect(fixture.app.altSpaceResetThreshold).toBe(6);
  });
});
