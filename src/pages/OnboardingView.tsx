/* =====================================================================
   pages/OnboardingView.tsx —— 首次启动引导视图（分页式，纵向滚动兜底）
   架构：
   - 顶栏：标题 + 窗口控制（最小化/关闭）
   - 主体：单页渲染，翻页切换；内容溢出时纵向滚动兜底
     0. 欢迎页（核心亮点）
     1. 窗口类型
     2. 快捷键速查
     3. 快速设置（主题/UI/关闭行为/启动项/热键/顶栏按钮）
   - 底部：页码指示 + 跳过 + 上一步/下一步/完成
   ===================================================================== */

import { useEffect, useState } from 'react';
import {
  getAppSettings,
  updateAppSettings,
  getHotkeys,
  setHotkeyFor,
  setHotkeyEnabled,
  completeOnboarding,
  isOnboardingCompleted,
  selectImportFile,
  importData,
  ALL_TOP_BAR_BUTTON_GROUPS,
  type AppSettings,
  type TopBarButtonGroup,
  type HotkeyConfig,
  type HotkeyAction,
} from '../lib/electron-api';
import { useThemeStore, type ThemeMode } from '../store/useThemeStore';
import { Chip, HotkeyRecorder } from '../components/ui';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { startHotkeyRecording, stopHotkeyRecording, onHotkeyRecordingResult, onHotkeyRecordingPartial } from '../lib/electron-api';
import './OnboardingView.css';

const TOP_BAR_BUTTON_LABELS: Record<TopBarButtonGroup, string> = {
  uaToggle: 'UA 切换',
  navBack: '后退',
  navForward: '前进',
  navHome: '主页',
  themeToggle: '主题切换',
  pinToggle: '置顶',
};

const FEATURE_HIGHLIGHTS: Array<{ title: string; desc: string }> = [
  { title: '多标签聚合', desc: '9 个 AI 平台聚合到一个窄长窗口，标签可脱离为独立窗口' },
  { title: '全局热键', desc: 'Alt+Space 呼出主窗、Alt+Q 打开进阶面板、Alt+V 后台语音' },
  { title: '后台语音输入', desc: '按住 Alt+V 直接说话，松开即送，不切窗不打断工作' },
  { title: '8 维指纹伪装', desc: 'Canvas/WebGL/Audio/Fonts 等一致性配置，防关联' },
  { title: '自定义 AI 对话', desc: 'OpenAI/Anthropic/Custom 三协议直连，safeStorage 加密' },
  { title: 'SQLite 持久化', desc: 'FTS5 全文搜索，对话/痕迹全在本地' },
];

const WINDOW_TYPES: Array<{ name: string; id: string; desc: string }> = [
  { name: '主窗口', id: 'windowId=main', desc: '多标签 + 顶栏 + 底栏' },
  { name: '脱离窗口', id: 'windowId=UUID', desc: '标签拖拽脱离的独立窗口' },
  { name: '自定义对话', id: 'mode=chat', desc: 'API 直连 AI 对话' },
  { name: '历史搜索', id: 'mode=history', desc: '全文搜索本地对话' },
  { name: '提示词库', id: 'mode=prompts', desc: '模板管理与注入' },
  { name: '进阶面板', id: 'mode=advanced-panel', desc: '自定义供应商/对话/白板/笔记' },
];

const DEFAULT_GLOBAL_HOTKEYS: Array<{ action: HotkeyAction; label: string; fallback: string }> = [
  { action: 'toggleMainWindow', label: '呼出/隐藏主窗口', fallback: 'Alt+Space' },
  { action: 'toggleDetachedWindows', label: '打开进阶面板', fallback: 'Alt+Q' },
  { action: 'backgroundVoice', label: '后台语音录入（测试）', fallback: 'Alt+V' },
];

const APP_SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: 'Alt + 1~9', action: '切换到第 N 个标签' },
  { keys: 'Ctrl + Tab', action: '循环切换标签' },
  { keys: 'Ctrl + T', action: '脱离当前标签为独立窗口' },
  { keys: 'Ctrl + W', action: '关闭当前标签' },
  { keys: '双击标题', action: '编辑标签标题' },
  { keys: 'F4', action: '后退（当前标签）' },
  { keys: 'F5', action: '刷新当前标签' },
  { keys: 'F6', action: '前进（当前标签）' },
  { keys: 'F10', action: '切换主题' },
  { keys: 'F11', action: '最大化/还原' },
  { keys: 'F12', action: '切换置顶' },
  { keys: 'Ctrl + G', action: '切换空间导航' },
  { keys: '` / ?', action: '呼出快捷键说明' },
];

const TOTAL_PAGES = 4;

export default function OnboardingView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [hotkeyDrafts, setHotkeyDrafts] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, hks, isDone] = await Promise.all([
          getAppSettings(),
          getHotkeys(),
          isOnboardingCompleted(),
        ]);
        setSettings(cfg);
        setHotkeys(hks);
        setCompleted(isDone);
        const drafts: Record<string, string> = {};
        for (const h of hks) drafts[h.action] = h.accelerator;
        setHotkeyDrafts(drafts);
      } catch (e) {
        console.error('[OnboardingView] 加载设置失败:', e);
      }
    })();
  }, []);

  // 引导窗口不需要最大化、最小化和置顶，不监听 F11/F12
  // ESC：关闭引导窗口
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

  const toggleTopBarButton = async (group: TopBarButtonGroup) => {
    if (!settings) return;
    const current = settings.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS];
    const next = current.includes(group)
      ? current.filter((g) => g !== group)
      : [...current, group];
    await updateField('topBarVisibleButtons', next);
  };

  const saveHotkey = async (action: HotkeyAction) => {
    const draft = hotkeyDrafts[action]?.trim();
    if (!draft) return;
    try {
      await setHotkeyFor(action, draft);
      await setHotkeyEnabled(action, true);
      const hks = await getHotkeys();
      setHotkeys(hks);
    } catch (e) {
      console.error('[OnboardingView] 保存热键失败:', action, e);
    }
  };

  // 切换某个内置热键的启用状态（独立开关）
  const toggleHotkeyEnabled = async (action: HotkeyAction, enabled: boolean) => {
    try {
      await setHotkeyEnabled(action, enabled);
      const hks = await getHotkeys();
      setHotkeys(hks);
    } catch (e) {
      console.error('[OnboardingView] 切换热键启用状态失败:', action, e);
    }
  };

  // 数据迁移：从 zip 导入（导入成功后应用自动重启）
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
      // 成功时应用自动重启
    } catch (err) {
      setImportError((err as Error).message);
      setImporting(false);
    }
  };

  const handleFinish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      const patch: Partial<AppSettings> | undefined = settings
        ? {
            uiScale: settings.uiScale,
            closeBehavior: settings.closeBehavior,
            startupOpen: settings.startupOpen,
            topBarVisibleButtons: settings.topBarVisibleButtons,
            autoLaunch: settings.autoLaunch,
            silentStart: settings.silentStart,
          }
        : undefined;
      await completeOnboarding(patch);
    } catch (e) {
      console.error('[OnboardingView] 完成引导失败:', e);
      setFinishing(false);
    }
  };

  if (!settings) {
    return (
      <div className="onboarding-root app-shell app-view-root" data-name="onboarding.loading-container">
        <div className="onboarding-loading" data-name="onboarding.loading">加载中…</div>
      </div>
    );
  }

  return (
    <div className="onboarding-root app-view-root" data-name="onboarding.container">
      {/* 顶栏（仅保留关闭按钮，不提供最小化/最大化/置顶） */}
      <StandaloneWindowHeader
        title="工百窗 · 使用指南"
        showPinButton={false}
        showMinMax={false}
        dataNamePrefix="onboarding"
      />

      {/* 主体（内容溢出时纵向滚动兜底） */}
      <div className="onboarding-body" data-name="onboarding.body">
        {/* 页 0：欢迎 + 核心亮点 */}
        {page === 0 && (
          <div className="onboarding-page" data-name="onboarding.page-1.container">
            <header className="onboarding-header" data-name="onboarding.page-1.header">
              <h1 data-name="onboarding.page-1.title">欢迎使用工百窗</h1>
              <p data-name="onboarding.page-1.subtitle">热键驱动的 AI 调用平台。在任何场景下一句话调出 AI，不打断当前工作流。</p>
            </header>
            <div className="onboarding-feature-grid" data-name="onboarding.page-1.feature-list">
              {FEATURE_HIGHLIGHTS.map((f, idx) => (
                <div
                  key={f.title}
                  className="onboarding-feature-card"
                  data-name={`onboarding.page-1.feature-item-${idx + 1}`}
                  data-index={idx + 1}
                  data-id={f.title}
                >
                  <strong data-name="onboarding.page-1.feature-title">{f.title}</strong>
                  <span data-name="onboarding.page-1.feature-desc">{f.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 页 1：窗口类型 */}
        {page === 1 && (
          <div className="onboarding-page" data-name="onboarding.page-2.container">
            <h2 className="onboarding-page-title" data-name="onboarding.page-2.title">窗口类型</h2>
            <p className="onboarding-page-desc" data-name="onboarding.page-2.desc">URL 查询参数标识不同窗口，了解命名有助理解职责。</p>
            <div className="onboarding-window-grid" data-name="onboarding.page-2.window-list">
              {WINDOW_TYPES.map((w, idx) => (
                <div
                  key={w.id}
                  className="onboarding-window-card"
                  data-name={`onboarding.page-2.window-item-${idx + 1}`}
                  data-index={idx + 1}
                  data-id={w.id}
                >
                  <div className="onboarding-window-name" data-name="onboarding.page-2.window-name">{w.name}</div>
                  <code className="onboarding-window-id" data-name="onboarding.page-2.window-id">{w.id}</code>
                  <div className="onboarding-window-desc" data-name="onboarding.page-2.window-desc">{w.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 页 2：快捷键 */}
        {page === 2 && (
          <div className="onboarding-page" data-name="onboarding.page-3.container">
            <h2 className="onboarding-page-title" data-name="onboarding.page-3.title">快捷键速查</h2>
            <div className="onboarding-shortcut-cols" data-name="onboarding.page-3.shortcut-cols">
              <div className="onboarding-shortcut-col" data-name="onboarding.page-3.app-shortcut-col">
                <h3 className="onboarding-subtitle" data-name="onboarding.page-3.app-shortcut-title">应用内</h3>
                <ul className="onboarding-shortcut-list" data-name="onboarding.page-3.app-shortcut-list">
                  {APP_SHORTCUTS.map((s, idx) => (
                    <li
                      key={s.keys}
                      data-name={`onboarding.page-3.app-shortcut-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={s.keys}
                    >
                      <kbd data-name="onboarding.page-3.app-shortcut-key">{s.keys}</kbd>
                      <span data-name="onboarding.page-3.app-shortcut-action">{s.action}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="onboarding-shortcut-col" data-name="onboarding.page-3.global-hotkey-col">
                <h3 className="onboarding-subtitle" data-name="onboarding.page-3.global-hotkey-title">全局热键</h3>
                <ul className="onboarding-shortcut-list" data-name="onboarding.page-3.global-hotkey-list">
                  {DEFAULT_GLOBAL_HOTKEYS.map((h, idx) => {
                    const cfg = hotkeys.find((x) => x.action === h.action);
                    const keys = cfg?.accelerator || h.fallback;
                    return (
                      <li
                        key={h.action}
                        data-name={`onboarding.page-3.global-hotkey-item-${idx + 1}`}
                        data-index={idx + 1}
                        data-id={h.action}
                      >
                        <kbd data-name="onboarding.page-3.global-hotkey-key">{keys}</kbd>
                        <span data-name="onboarding.page-3.global-hotkey-label">{h.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* 页 3：快速设置 */}
        {page === 3 && (
          <div className="onboarding-page" data-name="onboarding.page-4.container">
            <h2 className="onboarding-page-title" data-name="onboarding.page-4.title">快速设置</h2>
            <p className="onboarding-page-desc" data-name="onboarding.page-4.desc">按习惯配置，稍后可在设置面板修改。</p>
            <div className="onboarding-settings-grid" data-name="onboarding.page-4.settings-grid">
              <div className="onboarding-field" data-name="onboarding.page-4.theme-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.theme-field-label">主题模式</label>
                <div className="onboarding-radio-group" data-name="onboarding.page-4.theme-radio-list">
                  {(['light', 'dark', 'system'] as ThemeMode[]).map((m, idx) => (
                    <label
                      key={m}
                      className={`onboarding-radio${theme === m ? ' is-active' : ''}`}
                      data-name={`onboarding.page-4.theme-radio-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={m}
                    >
                      <input
                        type="radio"
                        name="theme"
                        value={m}
                        checked={theme === m}
                        onChange={() => setTheme(m)}
                        data-name="onboarding.page-4.theme-radio-input"
                      />
                      <span data-name="onboarding.page-4.theme-radio-label">{m === 'light' ? '亮色' : m === 'dark' ? '暗色' : '跟随系统'}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="onboarding-field" data-name="onboarding.page-4.ui-scale-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.ui-scale-field-label">UI 比例</label>
                <div className="onboarding-radio-group" data-name="onboarding.page-4.ui-scale-radio-list">
                  {(['small', 'medium', 'large'] as const).map((s, idx) => (
                    <label
                      key={s}
                      className={`onboarding-radio${settings.uiScale === s ? ' is-active' : ''}`}
                      data-name={`onboarding.page-4.ui-scale-radio-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={s}
                    >
                      <input
                        type="radio"
                        name="uiScale"
                        value={s}
                        checked={settings.uiScale === s}
                        onChange={() => void updateField('uiScale', s)}
                        data-name="onboarding.page-4.ui-scale-radio-input"
                      />
                      <span data-name="onboarding.page-4.ui-scale-radio-label">{s === 'small' ? '紧凑' : s === 'medium' ? '中档' : '大号'}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="onboarding-field" data-name="onboarding.page-4.close-behavior-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.close-behavior-field-label">关闭按钮</label>
                <div className="onboarding-radio-group" data-name="onboarding.page-4.close-behavior-radio-list">
                  {(['minimize', 'close'] as const).map((b, idx) => (
                    <label
                      key={b}
                      className={`onboarding-radio${settings.closeBehavior === b ? ' is-active' : ''}`}
                      data-name={`onboarding.page-4.close-behavior-radio-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={b}
                    >
                      <input
                        type="radio"
                        name="closeBehavior"
                        value={b}
                        checked={settings.closeBehavior === b}
                        onChange={() => void updateField('closeBehavior', b)}
                        data-name="onboarding.page-4.close-behavior-radio-input"
                      />
                      <span data-name="onboarding.page-4.close-behavior-radio-label">{b === 'minimize' ? '最小化到托盘' : '直接退出'}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="onboarding-field" data-name="onboarding.page-4.startup-open-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.startup-open-field-label">启动时打开</label>
                <div className="onboarding-radio-group" data-name="onboarding.page-4.startup-open-radio-list">
                  {(['home', 'lastConversation'] as const).map((s, idx) => (
                    <label
                      key={s}
                      className={`onboarding-radio${settings.startupOpen === s ? ' is-active' : ''}`}
                      data-name={`onboarding.page-4.startup-open-radio-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={s}
                    >
                      <input
                        type="radio"
                        name="startupOpen"
                        value={s}
                        checked={settings.startupOpen === s}
                        onChange={() => void updateField('startupOpen', s)}
                        data-name="onboarding.page-4.startup-open-radio-input"
                      />
                      <span data-name="onboarding.page-4.startup-open-radio-label">{s === 'home' ? '平台首页' : '最近对话'}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="onboarding-field onboarding-field-full" data-name="onboarding.page-4.data-migration-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.data-migration-field-label">数据迁移</label>
                <p className="onboarding-field-hint" data-name="onboarding.page-4.data-migration-hint">从其他设备导入备份（zip），导入后应用自动重启。</p>
                <button
                  type="button"
                  className="btn-primary-flat onboarding-import-btn"
                  onClick={() => void handleImport()}
                  disabled={importing}
                  data-name="onboarding.page-4.import-button"
                >
                  {importing ? '导入中…' : '导入数据'}
                </button>
                {importError && (
                  <div className="onboarding-import-error" data-name="onboarding.page-4.import-error">✗ {importError}</div>
                )}
              </div>
              <div className="onboarding-field onboarding-field-full" data-name="onboarding.page-4.auto-launch-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.auto-launch-field-label">开机自启动</label>
                <div className="onboarding-toggle-group" data-name="onboarding.page-4.auto-launch-toggle-group">
                  <div className="onboarding-toggle-row-inline" data-name="onboarding.page-4.auto-launch-toggle-row">
                    <label className="toggle" data-name="onboarding.page-4.auto-launch-toggle">
                      <input
                        type="checkbox"
                        checked={settings.autoLaunch}
                        onChange={(e) => void updateField('autoLaunch', e.target.checked)}
                        data-name="onboarding.page-4.auto-launch-toggle-input"
                      />
                      <span className="toggle-track" data-name="onboarding.page-4.auto-launch-toggle-track" />
                    </label>
                    <span className="onboarding-toggle-label" data-name="onboarding.page-4.auto-launch-toggle-label">
                      {settings.autoLaunch ? '已启用' : '未启用'}
                    </span>
                  </div>
                  {settings.autoLaunch && (
                    <div className="onboarding-toggle-row-inline" data-name="onboarding.page-4.silent-start-toggle-row">
                      <label className="toggle" data-name="onboarding.page-4.silent-start-toggle">
                        <input
                          type="checkbox"
                          checked={settings.silentStart}
                          onChange={(e) => void updateField('silentStart', e.target.checked)}
                          data-name="onboarding.page-4.silent-start-toggle-input"
                        />
                        <span className="toggle-track" data-name="onboarding.page-4.silent-start-toggle-track" />
                      </label>
                      <span className="onboarding-toggle-label" data-name="onboarding.page-4.silent-start-toggle-label">
                        {settings.silentStart ? '已启用' : '未启用'}
                      </span>
                      <span className="onboarding-toggle-inline-hint" data-name="onboarding.page-4.silent-start-hint">
                        静默启动：开机后隐藏到托盘，不弹出窗口
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="onboarding-field onboarding-field-full" data-name="onboarding.page-4.hotkey-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.hotkey-field-label">全局热键</label>
                <div className="onboarding-hotkey-list" data-name="onboarding.page-4.hotkey-list">
                  {DEFAULT_GLOBAL_HOTKEYS.map((h, idx) => {
                    const cfg = hotkeys.find((x) => x.action === h.action);
                    const enabled = cfg?.enabled ?? true;
                    const draft = hotkeyDrafts[h.action] ?? '';
                    const dirty = draft.trim() !== (cfg?.accelerator ?? '');
                    return (
                      <div
                        key={h.action}
                        className="onboarding-hotkey-item"
                        data-name={`onboarding.page-4.hotkey-item-${idx + 1}`}
                        data-index={idx + 1}
                        data-id={h.action}
                      >
                        <span className="onboarding-hotkey-label" data-name="onboarding.page-4.hotkey-label">{h.label}</span>
                        {/* 独立开关：每个热键单独启用/禁用 */}
                        <label
                          className="toggle"
                          title={enabled ? '已启用' : '已禁用'}
                          data-name="onboarding.page-4.hotkey-toggle"
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => void toggleHotkeyEnabled(h.action, e.target.checked)}
                            data-name="onboarding.page-4.hotkey-toggle-input"
                          />
                          <span className="toggle-track" data-name="onboarding.page-4.hotkey-toggle-track" />
                        </label>
                        <HotkeyRecorder
                          value={draft}
                          placeholder={cfg?.accelerator || h.fallback}
                          className="onboarding-hotkey-input"
                          data-name="onboarding.page-4.hotkey-input"
                          onRecord={(acc) => setHotkeyDrafts((p) => ({ ...p, [h.action]: acc }))}
                          otherHotkeys={DEFAULT_GLOBAL_HOTKEYS
                            .filter((other) => other.action !== h.action)
                            .map((other) => {
                              const otherCfg = hotkeys.find((x) => x.action === other.action);
                              return { label: other.label, accelerator: otherCfg?.accelerator ?? other.fallback };
                            })}
                          startRecording={startHotkeyRecording}
                          stopRecording={stopHotkeyRecording}
                          onRecordingResult={onHotkeyRecordingResult}
                          onRecordingPartial={onHotkeyRecordingPartial}
                        />
                        {dirty && (
                          <button
                            type="button"
                            className="onboarding-hotkey-save"
                            onClick={() => void saveHotkey(h.action)}
                            data-name="onboarding.page-4.hotkey-save-button"
                          >
                            保存
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="onboarding-field onboarding-field-full" data-name="onboarding.page-4.topbar-buttons-field">
                <label className="onboarding-field-label" data-name="onboarding.page-4.topbar-buttons-field-label">顶栏按钮</label>
                <p className="onboarding-field-hint" data-name="onboarding.page-4.topbar-buttons-hint">应用切换器、菜单、刷新、窗口控制始终显示。</p>
                <div className="onboarding-topbar-toggles" data-name="onboarding.page-4.topbar-buttons-list">
                  {ALL_TOP_BAR_BUTTON_GROUPS.map((group, idx) => {
                    const checked = (settings.topBarVisibleButtons ?? []).includes(group);
                    return (
                      <Chip
                        key={group}
                        type="button"
                        selected={checked}
                        className="onboarding-toggle-chip"
                        data-name={`onboarding.page-4.topbar-buttons-chip-${idx + 1}`}
                        data-index={idx + 1}
                        data-id={group}
                        onClick={() => void toggleTopBarButton(group)}
                      >
                        {TOP_BAR_BUTTON_LABELS[group]}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 底部：页码 + 跳过 + 导航 */}
      <footer className="onboarding-footer" data-name="onboarding.footer">
        <div className="onboarding-dots" data-name="onboarding.footer-dots">
          {Array.from({ length: TOTAL_PAGES }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`onboarding-dot${i === page ? ' is-active' : ''}`}
              onClick={() => setPage(i)}
              aria-label={`第 ${i + 1} 页`}
              data-name={`onboarding.footer-dot-${i + 1}`}
              data-index={i + 1}
              data-id={String(i + 1)}
            />
          ))}
        </div>
        <div className="onboarding-nav" data-name="onboarding.footer-button-group">
          <button
            type="button"
            className="onboarding-skip-btn"
            onClick={() => void handleFinish()}
            data-name="onboarding.footer-skip-button"
          >
            跳过
          </button>
          {page > 0 && (
            <button
              type="button"
              className="onboarding-prev-btn"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              data-name="onboarding.footer-prev-button"
            >
              上一步
            </button>
          )}
          {page < TOTAL_PAGES - 1 ? (
            <button
              type="button"
              className="onboarding-next-btn"
              onClick={() => setPage((p) => Math.min(TOTAL_PAGES - 1, p + 1))}
              data-name="onboarding.footer-next-button"
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="onboarding-finish-btn"
              disabled={finishing}
              onClick={() => void handleFinish()}
              data-name="onboarding.footer-finish-button"
            >
              {finishing ? '正在进入…' : completed ? '完成' : '开始使用'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
