import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '../../lib/electron-api';
import { settleHooks } from '../../hooks/draft-hook-test-harness';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../hooks/draft-hook-test-harness');
  return createHookHarness();
});
const fixture = vi.hoisted(() => ({
  mode: 'edit' as 'edit' | 'create',
  options: {} as { mode: 'edit' | 'create'; profileId?: string },
  profiles: [] as Profile[],
  create: vi.fn(), update: vi.fn(), close: vi.fn(), closeWindow: vi.fn(), toast: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual('react'), ...runner.react,
  useMemo: (factory: any, dependencies: unknown[]) => runner.react.useCallback(factory, dependencies)(),
}));
vi.mock('../../lib/electron-api', () => ({
  listAIPlatforms: async () => [], getPresetAIPlatforms: () => [],
  listProfiles: async () => fixture.profiles, listPresets: async () => [], listBlockRules: async () => [],
  getAppSettings: async () => ({ disableAllBlockRules: true }),
  createProfile: fixture.create, updateProfile: fixture.update,
  onProfileUpdated: () => () => {}, onMaximizeToggled: () => () => {}, onPinToggled: () => () => {},
  isWindowMaximized: async () => false, isWindowAlwaysOnTop: async () => false,
  closeCurrentWindow: fixture.closeWindow, minimizeWindow: vi.fn(), maximizeToggleWindow: vi.fn(), pinCurrentWindow: vi.fn(),
  saveBlockRule: vi.fn(), updateBlockRule: vi.fn(), deleteBlockRule: vi.fn(),
}));
vi.mock('./editorOpts', () => ({ parseEditorOpts: () => fixture.options }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ toast: null, showToast: fixture.toast }) }));
vi.mock('../../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../../components/WindowResizeHandles', () => ({ default: 'resize-handles' }));
vi.mock('../../components/ui/Modal', () => ({ default: 'modal' }));
vi.mock('../../components/ui/Button', () => ({ default: 'button' }));
vi.mock('./components/TitleBar', () => ({ AiAppEditorTitleBar: 'title-bar' }));
vi.mock('./components/BasicInfoFields', () => ({ BasicInfoFields: 'basic-fields' }));
vi.mock('./components/BlockRulesSection', () => ({ BlockRulesSection: 'block-rules' }));
vi.mock('./components/PopupWhitelistSection', () => ({ PopupWhitelistSection: 'popup-whitelist' }));
vi.mock('../../components/AiAppEditorModal/BasicInfoFields', () => ({ BasicInfoFields: 'modal-basic-fields' }));
vi.mock('../../components/AiAppEditorModal/BlockRulesSection', () => ({ BlockRulesSection: 'modal-block-rules' }));
vi.mock('../../components/AiAppEditorModal/PopupWhitelistSection', () => ({ PopupWhitelistSection: 'modal-popup-whitelist' }));
import AiAppEditor from './index';
import AiAppEditorModal from '../../components/AiAppEditorModal';

type Entry = 'window' | 'modal';
const profile = { id: 'profile-a', name: 'Existing', aiPlatformUrl: 'https://example.test', aiPlatformRegion: 'cn' } as Profile;
function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
async function mount(entry: Entry, mode: 'edit' | 'create' = 'edit') {
  fixture.options = { mode, profileId: mode === 'edit' ? profile.id : undefined };
  const view = runner.mount(() => entry === 'window'
    ? AiAppEditor()
    : AiAppEditorModal({ open: true, mode, profileId: fixture.options.profileId, onClose: fixture.close }));
  await settleHooks();
  return view;
}
async function edit(view: { current: unknown }, values: Record<string, unknown>) {
  const fields = nodes(view.current).find(node => typeof node.props?.setAiPlatformName === 'function')!.props;
  const whitelist = nodes(view.current).find(node => typeof node.props?.setPopupWhitelist === 'function')!.props;
  for (const [field, value] of Object.entries(values)) {
    if (field === 'popupWhitelist') whitelist.setPopupWhitelist(value);
    else fields[`set${field[0].toUpperCase()}${field.slice(1)}`](value);
  }
  await settleHooks();
}
async function save(view: { current: unknown }) {
  nodes(view.current).find(node => node.props?.['data-name'] === 'ai-app-editor.save-button')!.props.onClick();
  await settleHooks();
}
const completeDraft = {
  aiPlatformName: ' Renamed ', aiPlatformUrl: ' https://example.test/chat ', browserHomePage: ' https://example.test/home ',
  aiDesktopPreset: ' desktop-preset ', aiMobilePreset: ' mobile-preset ', aiInputSelector: ' textarea ',
  aiSendSelector: ' button.send ', aiThemeColor: '#aBc', aiPlatformRegion: 'global',
  popupWhitelist: ['https://login.example.test/'],
};
const completePatch = {
  name: 'Renamed', aiPlatformUrl: 'https://example.test/chat', browserHomePage: 'https://example.test/home',
  aiDesktopPreset: ' desktop-preset ', aiMobilePreset: ' mobile-preset ', aiInputSelector: 'textarea',
  aiSendSelector: 'button.send', aiThemeColor: '#aBc', aiPlatformRegion: 'global',
  popupWhitelist: ['https://login.example.test/'],
};

beforeEach(() => {
  runner.reset(); vi.clearAllMocks(); fixture.profiles = [profile];
  fixture.create.mockImplementation(async input => {
    const created = { ...input, id: 'created-profile' };
    fixture.profiles = [...fixture.profiles, created];
    return created;
  });
  fixture.update.mockImplementation(async (id, patch) => ({ ...profile, ...patch, id }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { runner.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(['window', 'modal'] as const)('%s profile save consumer', entry => {
  it('saves the same complete field rules using the exact edited profile', async () => {
    const view = await mount(entry); await edit(view, completeDraft); await save(view);
    expect(fixture.update.mock.calls).toEqual([[profile.id, completePatch]]);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenLastCalledWith('已保存');
  });

  it('keeps optional fields undefined and the existing empty-name fallback', async () => {
    const view = await mount(entry);
    await edit(view, { aiPlatformName: ' ', browserHomePage: ' ', aiInputSelector: ' ', aiSendSelector: ' ', popupWhitelist: [] });
    await save(view);
    expect(fixture.update.mock.calls).toEqual([[profile.id, {
      name: '未命名 AI 应用', aiPlatformUrl: 'https://example.test', browserHomePage: undefined,
      aiDesktopPreset: undefined, aiMobilePreset: undefined, aiInputSelector: undefined,
      aiSendSelector: undefined, aiThemeColor: undefined, aiPlatformRegion: 'cn', popupWhitelist: undefined,
    }]]);
  });

  it('creates the same fields while retaining its own completion behavior', async () => {
    const view = await mount(entry, 'create'); await edit(view, completeDraft); await save(view);
    expect(fixture.create.mock.calls).toEqual([[{ isAIPlatform: true, aiPlatformId: undefined, ...completePatch }]]);
    expect(fixture.close).toHaveBeenCalledTimes(entry === 'modal' ? 1 : 0);
    expect(fixture.closeWindow).not.toHaveBeenCalled();
    if (entry === 'window') {
      await save(view);
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.update).toHaveBeenCalledWith('created-profile', completePatch);
    }
  });

  it('retains the edited fields and error prefix after a rejected save', async () => {
    const error = new Error('Unavailable'); fixture.update.mockRejectedValue(error);
    const view = await mount(entry); await edit(view, completeDraft); await save(view);
    const fields = nodes(view.current).find(node => typeof node.props?.setAiPlatformName === 'function')!.props;
    expect(fields.aiPlatformName).toBe(completeDraft.aiPlatformName);
    expect(fields.aiPlatformUrl).toBe(completeDraft.aiPlatformUrl);
    expect(nodes(view.current).find(node => node.props?.['data-name'] === 'ai-app-editor.save-button')!.props.disabled).toBe(false);
    expect(console.error).toHaveBeenCalledWith(entry === 'window' ? '[AiAppEditor] 保存失败:' : '[AiAppEditorModal] 保存失败:', error);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it.each([
    [{ aiPlatformUrl: ' ' }, '平台 URL 不能为空'],
    [{ aiThemeColor: ' #abc ' }, '主题色格式无效（需 #RGB 或 #RRGGBB）'],
  ] as const)('keeps validation before field serialization for %j', async (draft, message) => {
    const view = await mount(entry); await edit(view, draft); await save(view);
    expect(fixture.update).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenLastCalledWith(message);
  });
});
