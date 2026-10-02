import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookHarness, deferred } from '../../test/hook-harness';

const fixture = vi.hoisted(() => ({
  hooks: null as any, profiles: [] as any[], liveUrl: '',
  updateProfile: vi.fn(), updateTabHomeUrl: vi.fn(), feedback: vi.fn(), load: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (...args: any[]) => fixture.hooks.useState(...args),
  useRef: (...args: any[]) => fixture.hooks.useRef(...args),
  useCallback: (...args: any[]) => fixture.hooks.useCallback(...args),
  useEffect: (...args: any[]) => fixture.hooks.useEffect(...args),
}));
vi.mock('../../lib/electron-api', () => ({
  openAiAppEditor: vi.fn(), saveWhiteboardImage: vi.fn(), pushImageToWhiteboard: vi.fn(), getPresetAIPlatforms: () => [],
}));
vi.mock('../../lib/webview', () => ({
  safeReloadWebview: vi.fn(), safeLoadURLWebview: fixture.load, sanitizeUrl: (value: string) => value.trim(),
}));
import { useTabContextMenu } from './useTabContextMenu';
import { useNavigation } from './hooks/useNavigation';

const official = 'https://chatglm.cn';
const preferred = 'https://chatglm.cn/main/tools?lang=zh#favorites';
const tab = { id: 'tab', profileId: 'first', title: 'AI application', order: 0, url: official, homeUrl: 'https://chatglm.cn/obsolete' };
function menu(value: Partial<typeof tab> = {}) {
  const runner = createHookHarness(); fixture.hooks = runner.hooks;
  return { ...runner, render: () => runner.render(() => useTabContextMenu({
    tabs: [{ ...tab, ...value }], getProfile: id => fixture.profiles.find(profile => profile.id === id) ?? null,
    closeTab: vi.fn(), updateTabUrl: vi.fn(), updateTabHomeUrl: fixture.updateTabHomeUrl,
    updateProfile: fixture.updateProfile, onHomeFeedback: fixture.feedback,
  })) };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.profiles = ['first', 'second'].map(id => ({ id, name: id, isAIPlatform: true, aiPlatformId: 'chatglm', aiPlatformUrl: official }));
  fixture.liveUrl = preferred;
  fixture.updateProfile.mockImplementation(async (id, patch) => {
    fixture.profiles = fixture.profiles.map(profile => profile.id === id ? { ...profile, ...patch } : profile);
    return fixture.profiles.find(profile => profile.id === id);
  });
  fixture.updateTabHomeUrl.mockResolvedValue(undefined);
  vi.stubGlobal('document', { querySelector: () => ({ getURL: () => fixture.liveUrl }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('AI application homepage persistence', () => {
  it('saves the displayed URL into the exact application profile and preserves a sibling instance', async () => {
    const item = menu(); await item.render().setAsAIHome('tab');
    expect(fixture.updateProfile).toHaveBeenCalledWith('first', { aiPlatformUrl: preferred });
    expect(fixture.updateTabHomeUrl).not.toHaveBeenCalled();
    expect(fixture.profiles[0].aiPlatformUrl).toBe(preferred);
    expect(fixture.profiles[1].aiPlatformUrl).toBe(official);
    expect(fixture.feedback).toHaveBeenCalledWith('已设为当前 AI 首页');
    item.unmount();
  });
  it.each([null, { getURL: () => { throw new Error('Guest is unavailable'); } }])('uses the last tab URL when the guest cannot be queried: %j', async guest => {
    vi.stubGlobal('document', { querySelector: () => guest });
    const item = menu({ url: preferred }); await item.render().setAsAIHome('tab');
    expect(fixture.updateProfile).toHaveBeenCalledWith('first', { aiPlatformUrl: preferred });
    item.unmount();
  });
  it.each(['about:blank', 'chrome-error://chromewebdata/', 'javascript:void(0)'])('preserves the previous homepage for an internal page: %s', async url => {
    fixture.liveUrl = url;
    const item = menu(); await item.render().setAsAIHome('tab');
    expect(fixture.updateProfile).not.toHaveBeenCalled();
    expect(fixture.profiles[0].aiPlatformUrl).toBe(official);
    expect(fixture.feedback).toHaveBeenCalledWith('当前页面不是有效的网页地址');
    item.unmount();
  });
  it('reports success only after persistent saving completes', async () => {
    const save = deferred<any>(); fixture.updateProfile.mockReturnValue(save.promise);
    const item = menu(); const pending = item.render().setAsAIHome('tab');
    expect(fixture.feedback).not.toHaveBeenCalled();
    save.resolve({ ...fixture.profiles[0], aiPlatformUrl: preferred }); await pending;
    expect(fixture.feedback).toHaveBeenCalledWith('已设为当前 AI 首页'); item.unmount();
  });
  it('reports a rejected save without changing the application or tab homepage', async () => {
    fixture.updateProfile.mockRejectedValue(new Error('Storage is unavailable'));
    const item = menu(); await item.render().setAsAIHome('tab');
    expect(fixture.profiles[0].aiPlatformUrl).toBe(official);
    expect(fixture.updateTabHomeUrl).not.toHaveBeenCalled();
    expect(fixture.feedback).toHaveBeenCalledWith('设置首页失败，请重试'); item.unmount();
  });
  it('preserves tab-specific homepages for a generic browser profile', async () => {
    fixture.profiles[0].isAIPlatform = false;
    const item = menu(); await item.render().setAsAIHome('tab');
    expect(fixture.updateProfile).not.toHaveBeenCalled();
    expect(fixture.updateTabHomeUrl).toHaveBeenCalledWith('tab', preferred); item.unmount();
  });
  it('ignores a tab whose application was removed', async () => {
    fixture.profiles = [];
    const item = menu(); await item.render().setAsAIHome('tab');
    expect(fixture.updateProfile).not.toHaveBeenCalled();
    expect(fixture.updateTabHomeUrl).not.toHaveBeenCalled(); item.unmount();
  });
});

describe('homepage navigation source', () => {
  it.each([true, false])('chooses the application URL for AI profiles and the tab override for generic profiles: %s', isAIPlatform => {
    const runner = createHookHarness(); fixture.hooks = runner.hooks;
    const profile = { ...fixture.profiles[0], isAIPlatform, aiPlatformUrl: preferred };
    runner.render(() => useNavigation('tab', [tab], [profile])).handleGoHome();
    expect(fixture.load).toHaveBeenCalledWith(expect.anything(), isAIPlatform ? preferred : tab.homeUrl);
    runner.unmount();
  });
});

