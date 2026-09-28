/* =====================================================================
   pages/OnboardingView.tsx —— 使用指南（分页式，紧凑布局，用户视角流程）
   职责：路由级编排——共享状态（设置/热键/模块/预设/导入）、IPC 调用与回调、
   页面切换与底部导航，最终组装各步骤组件（见 pages/onboarding/ 目录）。
   架构：
   - 顶栏：标题 + 窗口控制（关闭）
   - 主体：单页渲染，翻页切换；内容较多的页面可滚动
      0. 欢迎（视觉主图 + 一句话定位 + 三大价值）        → onboarding/WelcomeStep.tsx
      1. 认识窗口（窗口地图卡片，模块开关内嵌窗口卡片）  → onboarding/WindowsStep.tsx
      2. 个性化（Oxy 开关；主题/界面大小；关闭行为/启动；
            快捷键开关、屏蔽国外模型、顶栏按钮、UA、导入智能体 API）→ onboarding/PersonalizeStep.tsx
      3. 上手动作（3 个全局热键 + 高频窗口操作）         → onboarding/HotkeysStep.tsx
      4. 开始使用（祝福 + 行动卡片）                     → onboarding/FinishStep.tsx
   - 底部：页码指示 + 跳过 + 上一步/下一步/完成
   快捷键静态数据与 ShortcutsModal 共享 lib/shortcut-reference.ts，避免双维护。
   开机自启/静默启动不在引导页配置（由安装版/便携版各自决定）。
   ===================================================================== */

import { useEffect, useState } from 'react';
import {
  getAppSettings,
  updateAppSettings,
  completeOnboarding,
  isOnboardingCompleted,
  selectImportFile,
  importData,
  getHotkeys,
  setHotkeyEnabled,
  openSettingsWindow,
  listPresets,
  type AppSettings,
  type HotkeyConfig,
  type TopBarButtonGroup,
  type DevicePreset,
} from '../lib/electron-api';
import { useThemeStore } from '../store/useThemeStore';
import { useModuleStore } from '../store/useModuleStore';
import { useUiVersionStore } from '../store/useUiVersionStore';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { readUserUiScale } from '../lib/oxy-design-system';
import { PAGES, TOTAL_PAGES } from './onboarding/onboardingData';
import WelcomeStep from './onboarding/WelcomeStep';
import WindowsStep from './onboarding/WindowsStep';
import PersonalizeStep from './onboarding/PersonalizeStep';
import HotkeysStep from './onboarding/HotkeysStep';
import FinishStep from './onboarding/FinishStep';
import './OnboardingView.css';

// ==================== 组件 ====================

export default function OnboardingView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [recommendMsg, setRecommendMsg] = useState<string | null>(null);
  const modules = useModuleStore((s) => s.modules);
  const setModuleEnabledState = useModuleStore((s) => s.setEnabled);
  const [page, setPage] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const isOxy = useUiVersionStore((s) => s.version === 'oxy');
  const setUiVersion = useUiVersionStore((s) => s.setVersion);

  useEffect(() => {
    void (async () => {
      try {
        void useModuleStore.getState().init();
        const [cfg, isDone, hks, ps] = await Promise.all([
          getAppSettings(),
          isOnboardingCompleted(),
          getHotkeys().catch(() => [] as HotkeyConfig[]),
          listPresets().catch(() => [] as DevicePreset[]),
        ]);
        setSettings(cfg);
        setCompleted(isDone);
        setHotkeys(hks);
        setPresets(ps);
      } catch (e) {
        console.error('[OnboardingView] 加载失败:', e);
      }
    })();
  }, []);

  useEscToCloseWindow();

  const updateField = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (!settings) return;
    try {
      const next = await updateAppSettings({ [key]: value } as Partial<AppSettings>);
      setSettings(next);
    } catch (e) {
      console.error('[OnboardingView] 更新设置失败:', key, e);
    }
  };

  /** Oxy 界面系统开关：开启后主题/界面大小由系统自动管理；关闭时恢复用户手动比例 */
  const handleOxyToggle = async (next: boolean) => {
    try {
      if (next) {
        setUiVersion('oxy');
      } else {
        const saved = readUserUiScale();
        setUiVersion('classic');
        document.documentElement.setAttribute('data-ui-scale', saved);
        await updateField('uiScale', saved);
      }
    } catch (e) {
      console.error('[OnboardingView] Oxy 切换失败:', e);
    }
  };

  /** 系统级默认快捷键（Alt+Space 呼出/隐藏主窗口）开关 */
  const handleMainHotkeyToggle = async (next: boolean) => {
    try {
      await setHotkeyEnabled('toggleMainWindow', next);
      setHotkeys((prev) => prev.map((h) => (h.action === 'toggleMainWindow' ? { ...h, enabled: next } : h)));
    } catch (e) {
      console.error('[OnboardingView] 系统级快捷键切换失败:', e);
    }
  };

  /** Alt+Q 进阶面板快捷键开关 */
  const handlePanelHotkeyToggle = async (next: boolean) => {
    try {
      await setHotkeyEnabled('toggleDetachedWindows', next);
      setHotkeys((prev) => prev.map((h) => (h.action === 'toggleDetachedWindows' ? { ...h, enabled: next } : h)));
    } catch (e) {
      console.error('[OnboardingView] 进阶面板快捷键切换失败:', e);
    }
  };

  /** Alt+V 后台语音快捷键开关 */
  const handleVoiceHotkeyToggle = async (next: boolean) => {
    try {
      await setHotkeyEnabled('backgroundVoice', next);
      setHotkeys((prev) => prev.map((h) => (h.action === 'backgroundVoice' ? { ...h, enabled: next } : h)));
    } catch (e) {
      console.error('[OnboardingView] 后台语音快捷键切换失败:', e);
    }
  };

  /** 顶栏按钮组显隐切换 */
  const toggleTopBarGroup = (group: TopBarButtonGroup) => {
    const cur = settings?.topBarVisibleButtons ?? [];
    const next = cur.includes(group) ? cur.filter((x) => x !== group) : [...cur, group];
    void updateField('topBarVisibleButtons', next);
  };

  const handleModuleToggle = async (id: string, enabled: boolean) => {
    setModuleError(null);
    const r = await setModuleEnabledState(id, enabled);
    if (!r.ok) setModuleError(r.error ?? '操作失败');
  };

  /** 推荐配置：常用（stable）开、实验（dev）关；先关实验再开常用，避免依赖方向受限 */
  const applyRecommended = async () => {
    setModuleError(null);
    setRecommendMsg(null);
    const ordered = [
      ...modules.filter((m) => m.category === 'dev'),
      ...modules.filter((m) => m.category === 'stable'),
    ];
    for (const m of ordered) {
      if (!m.installed) continue;
      const want = m.category === 'stable';
      if (m.enabled === want) continue;
      const r = await setModuleEnabledState(m.id, want);
      if (!r.ok) {
        setModuleError(r.error ?? '应用推荐配置失败');
        return;
      }
    }
    setRecommendMsg('已应用推荐配置');
    window.setTimeout(() => setRecommendMsg(null), 2000);
  };

  const handleImport = async () => {
    if (importing) return;
    setImportError(null);
    try {
      const zipPath = await selectImportFile();
      if (!zipPath) return;
      const confirmed = window.confirm(
        `确认导入以下文件？\n\n${zipPath}\n\n此操作将完全覆盖当前所有数据，应用将自动重启。`,
      );
      if (!confirmed) return;
      setImporting(true);
      const result = await importData(zipPath);
      if (!result.success) {
        setImportError(result.error ?? '导入失败');
        setImporting(false);
      }
    } catch (err) {
      setImportError((err as Error).message);
      setImporting(false);
    }
  };

  /** 完成引导（开机自启/静默启动不在引导页配置，由安装版/便携版各自决定） */
  const buildFinishPatch = (): Partial<AppSettings> => ({
    uiScale: settings?.uiScale,
    closeBehavior: settings?.closeBehavior,
    startupOpen: settings?.startupOpen,
  });

  const handleFinish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await completeOnboarding(buildFinishPatch());
    } catch (e) {
      console.error('[OnboardingView] 完成引导失败:', e);
      setFinishing(false);
    }
  };

  /** 完成引导并打开完整设置窗口（先开设置窗再完成引导，避免引导窗销毁后 IPC 失败） */
  const handleFinishAndOpenSettings = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await openSettingsWindow();
      await completeOnboarding(buildFinishPatch());
    } catch (e) {
      console.error('[OnboardingView] 完成引导失败:', e);
      setFinishing(false);
    }
  };

  if (!settings) {
    return (
      <div className="onboarding-root app-shell app-view-root" data-name="onboarding.loading">
        <div className="onboarding-loading">加载中...</div>
      </div>
    );
  }

  return (
    <div className="onboarding-root app-view-root" data-name="onboarding.container">
      <StandaloneWindowHeader
        title="工百窗 · 使用指南"
        showPinButton={false}
        showMinMax={false}
        dataNamePrefix="onboarding"
      />

      <div className="onboarding-body" data-name="onboarding.body">

        {/* 页 0：欢迎 */}
        {page === 0 && <WelcomeStep />}

        {/* 页 1：认识窗口（开关内嵌窗口卡片，其余模块单独列出） */}
        {page === 1 && (
          <WindowsStep
            modules={modules}
            hotkeys={hotkeys}
            recommendMsg={recommendMsg}
            moduleError={moduleError}
            onApplyRecommended={() => void applyRecommended()}
            onModuleToggle={handleModuleToggle}
          />
        )}

        {/* 页 2：个性化（Oxy + 常用配置） */}
        {page === 2 && (
          <PersonalizeStep
            settings={settings}
            presets={presets}
            isOxy={isOxy}
            theme={theme}
            setTheme={setTheme}
            onOxyToggle={handleOxyToggle}
            updateField={updateField}
            toggleTopBarGroup={toggleTopBarGroup}
          />
        )}

        {/* 页 3：上手动作（平铺三段式行，与 ShortcutsModal 视觉一致） */}
        {page === 3 && (
          <HotkeysStep
            hotkeys={hotkeys}
            onToggleMainHotkey={handleMainHotkeyToggle}
            onTogglePanelHotkey={handlePanelHotkeyToggle}
            onToggleVoiceHotkey={handleVoiceHotkeyToggle}
          />
        )}

        {/* 页 4：开始使用 */}
        {page === 4 && (
          <FinishStep
            importing={importing}
            importError={importError}
            finishing={finishing}
            onImport={handleImport}
            onFinishAndOpenSettings={handleFinishAndOpenSettings}
          />
        )}
      </div>

      {/* 底部导航 */}
      <footer className="onboarding-footer" data-name="onboarding.footer">
        <div className="onboarding-dots">
          {PAGES.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`onboarding-dot${i === page ? ' is-active' : ''}`}
              onClick={() => setPage(i)}
              aria-label={p.title}
            />
          ))}
        </div>
        <div className="onboarding-nav">
          <button type="button" className="onboarding-btn-text" onClick={() => void handleFinish()}>
            跳过
          </button>
          {page > 0 && (
            <button type="button" className="onboarding-btn-secondary" onClick={() => setPage((p) => p - 1)}>
              上一步
            </button>
          )}
          {page < TOTAL_PAGES - 1 ? (
            <button type="button" className="onboarding-btn-primary" onClick={() => setPage((p) => p + 1)}>
              下一步
            </button>
          ) : (
            <button type="button" className="onboarding-btn-primary" disabled={finishing} onClick={() => void handleFinish()}>
              {finishing ? '正在进入...' : completed ? '完成' : '开始使用'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
