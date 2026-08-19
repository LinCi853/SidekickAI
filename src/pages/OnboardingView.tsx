/* =====================================================================
   pages/OnboardingView.tsx —— 使用指南（分页式，紧凑布局，用户视角流程）
   架构：
   - 顶栏：标题 + 窗口控制（关闭）
   - 主体：单页渲染，翻页切换；内容较多的页面可滚动
      0. 欢迎（视觉主图 + 一句话定位 + 三大价值，通用文案不绑定内置平台数量）
      1. 认识窗口（窗口地图卡片，模块开关直接内嵌到对应窗口卡片：
            主窗口→提示词库；进阶面板→白板/笔记/自定义对话 API；
            浏览器窗口→浏览器/页面冻结；不依附窗口的模块（语音/TTS）单独列出并介绍）
      2. 个性化（Oxy 界面系统开关；经典版主题/界面大小；关闭行为/启动时打开；
            系统级快捷键开关、屏蔽国外模型、顶栏按钮、默认桌面 UA、导入智能体 API）
      3. 上手动作（3 个全局热键动态显示 + 高频窗口操作，平铺三段式行布局与 ShortcutsModal 视觉一致；
            完整速查指向 ` 呼出的 ShortcutsModal）
      4. 开始使用（祝福 + 行动卡片：导入备份 / 深入设置 / 随时回顾）
   - 底部：页码指示 + 跳过 + 上一步/下一步/完成
   快捷键静态数据与 ShortcutsModal 共享 lib/shortcut-reference.ts，避免双维护。
   开机自启/静默启动不在引导页配置（由安装版/便携版各自决定）。
   ===================================================================== */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
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
  openAiAppEditor,
  listPresets,
  ALL_TOP_BAR_BUTTON_GROUPS,
  type AppSettings,
  type HotkeyConfig,
  type HotkeyAction,
  type TopBarButtonGroup,
  type DevicePreset,
} from '../lib/electron-api';
import { useThemeStore, type ThemeMode } from '../store/useThemeStore';
import { useModuleStore } from '../store/useModuleStore';
import { useUiVersionStore } from '../store/useUiVersionStore';
import { Toggle, Chip } from '../components/ui';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { readUserUiScale } from '../lib/oxy-design-system';
import {
  GLOBAL_HOTKEY_META,
  APP_SHORTCUTS,
  ONBOARDING_SHORTCUT_KEYS,
  formatAcc,
} from '../lib/shortcut-reference';
import './OnboardingView.css';

// ==================== 数据定义 ====================

const PAGES = [
  { id: 'welcome', title: '欢迎' },
  { id: 'windows', title: '认识窗口' },
  { id: 'personalize', title: '个性化' },
  { id: 'actions', title: '上手动作' },
  { id: 'finish', title: '开始使用' },
] as const;

const TOTAL_PAGES = PAGES.length;

/** 窗口卡片 → 内嵌模块开关（按模块主要使用位置归属） */
const WINDOW_MODULE_MAP: Record<string, string[]> = {
  main: ['prompt-library'],
  panel: ['custom-chat', 'whiteboard', 'notes'],
  browser: ['browser', 'freeze'],
};

/** 模块 → 用户价值描述（覆盖 manifest 中的技术描述；未覆盖时回退 manifest.description） */
const MODULE_VALUE_DESC: Record<string, string> = {
  'custom-chat': '接入 OpenAI 兼容协议的自定义 AI 服务，流式直连对话',
  'prompt-library': '常用提示词模板集中管理，热键一键注入',
  notes: '灵感笔记：任务列表、代码块、图片，随用随记',
  whiteboard: '无限画布白板，对话内容和截图都能推到白板',
  voice: '按住 Alt+V 说话、松开发送，后台语音输入',
  tts: '自定义供应商 TTS 语音合成',
  browser: 'Chrome 风格多标签浏览器窗口，可脱离/回归',
  freeze: '冻结 AI 页面防止对方撤回/删除内容，可选中复制',
};

/** 顶栏按钮组 → 展示名 */
const TOP_BAR_BUTTON_LABELS: Record<TopBarButtonGroup, string> = {
  uaToggle: 'UA 切换',
  navBack: '后退',
  navForward: '前进',
  navHome: '主页',
  themeToggle: '主题',
  pinToggle: '置顶',
};

/** 欢迎页三大价值（通用文案，不绑定具体平台数量） */
const VALUE_POINTS = [
  {
    icon: 'layers',
    title: '聚合',
    desc: '内置常用 AI 平台，也支持手动添加任意 AI 服务；多账号互相隔离，可多开',
  },
  {
    icon: 'mute',
    title: '安静',
    desc: '自动屏蔽下载引导、升级横幅与原生弹窗，专注对话不被打断',
  },
  {
    icon: 'lock',
    title: '本地',
    desc: '对话、笔记、白板全部本地存储，语音识别数据不出本机',
  },
] as const;

/** 全局热键 → 展示（动态读取用户自定义 accelerator 与启用状态） */
function resolveHotkey(hotkeys: HotkeyConfig[], action: HotkeyAction, fallback: string): {
  keys: string;
  enabled: boolean;
} {
  const cfg = hotkeys.find((h) => h.action === action);
  if (!cfg) return { keys: fallback, enabled: true };
  if (!cfg.enabled) return { keys: fallback, enabled: false };
  if (!cfg.accelerator) return { keys: fallback, enabled: true };
  return { keys: formatAcc(cfg.accelerator), enabled: true };
}

// ==================== 内联图标（与项目 SVG 风格一致，不引入图标库） ====================

function OnboardIcon({ children, size = 15 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  layers: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  mute: (
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  appWindow: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01" />
    </>
  ),
  panels: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  pip: (
    <>
      <path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4" />
      <rect x="12" y="13" width="10" height="7" rx="2" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  book: (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
};

/** 认识窗口页卡片定义 */
interface WindowCardDef {
  id: string;
  icon: ReactNode;
  name: string;
  entry: { keys: string; enabled: boolean };
  desc: string;
  tags: string[];
  moduleIds: string[];
  experimental?: boolean;
  extra?: string;
}

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

  const browserEnabled = modules.find((m) => m.id === 'browser')?.enabled ?? false;
  const hkMain = resolveHotkey(hotkeys, 'toggleMainWindow', 'Alt + Space');
  const hkPanel = resolveHotkey(hotkeys, 'toggleDetachedWindows', 'Alt + Q');
  const hkVoice = resolveHotkey(hotkeys, 'backgroundVoice', 'Alt + V');
  const frequentShortcuts = APP_SHORTCUTS.filter((s) => ONBOARDING_SHORTCUT_KEYS.includes(s.keys));
  const desktopPresets = presets.filter((p) => p.platform === 'desktop');
  /** 未挂到任何窗口卡片的模块（单独列出并介绍） */
  const onCardModuleIds = new Set(Object.values(WINDOW_MODULE_MAP).flat());
  const extraModules = modules.filter((m) => !onCardModuleIds.has(m.id));

  const windowCards: WindowCardDef[] = [
    {
      id: 'main',
      icon: ICONS.appWindow,
      name: '主窗口',
      entry: hkMain,
      desc: '所有 AI 应用聚合在一个窄长窗口，多标签并存、切换不丢状态。',
      tags: ['多标签聚合', '应用切换', '提示词注入', '文件拖入'],
      moduleIds: WINDOW_MODULE_MAP.main,
    },
    {
      id: 'panel',
      icon: ICONS.panels,
      name: '进阶面板',
      entry: hkPanel,
      desc: '对话 / 白板 / 笔记三大工作区：直连自定义 AI，随手画、随手记。',
      tags: ['自定义对话', '白板', '灵感笔记', '截图到白板'],
      moduleIds: WINDOW_MODULE_MAP.panel,
    },
    {
      id: 'browser',
      icon: ICONS.globe,
      name: '浏览器窗口',
      experimental: true,
      entry: browserEnabled
        ? { keys: '按应用设置', enabled: true }
        : { keys: '未启用', enabled: false },
      desc: 'Chrome 风格多标签浏览器，标签可在主窗口与浏览器之间脱离/回归。',
      tags: ['多标签', '书签', '下载', '历史'],
      moduleIds: WINDOW_MODULE_MAP.browser,
      extra: browserEnabled
        ? '可在浏览器设置中为每个应用配置脱离快捷键'
        : undefined,
    },
  ];

  const renderWindowModuleRow = (m: (typeof modules)[number]) => (
    <div
      key={m.id}
      className={`onboarding-window-module-row${m.enabled ? ' is-enabled' : ''}${!m.installed ? ' is-missing' : ''}`}
    >
      <span className="onboarding-window-module-name">
        {m.name}
        {m.testBadge && <em className="onboarding-module-badge">测试</em>}
      </span>
      <Toggle
        checked={m.enabled}
        disabled={!m.installed}
        onChange={(v) => void handleModuleToggle(m.id, v)}
        aria-label={'启用 ' + m.name}
      />
    </div>
  );

  const renderModuleCard = (m: (typeof modules)[number]) => (
    <div
      key={m.id}
      className={`onboarding-module-card${m.enabled ? ' is-enabled' : ''}${!m.installed ? ' is-missing' : ''}`}
    >
      <div className="onboarding-module-card-info">
        <span className="onboarding-module-card-name">
          {m.name}
          {m.testBadge && <em className="onboarding-module-badge">测试</em>}
        </span>
        <span className="onboarding-module-card-desc">
          {m.installed ? (MODULE_VALUE_DESC[m.id] ?? m.description) : '未安装'}
        </span>
      </div>
      <Toggle
        checked={m.enabled}
        disabled={!m.installed}
        onChange={(v) => void handleModuleToggle(m.id, v)}
        aria-label={'启用 ' + m.name}
      />
    </div>
  );

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
        {page === 0 && (
          <div className="onboarding-page onboarding-welcome" data-name="onboarding.page-welcome">
            <svg
              className="onboarding-welcome-hero-svg"
              viewBox="0 0 260 150"
              fill="none"
              aria-hidden="true"
              data-name="onboarding.welcome.hero"
            >
              {/* 主窗口（窄长形态） */}
              <rect x="40" y="12" width="100" height="126" rx="8" className="ob-hero-window" />
              <rect x="40" y="12" width="100" height="20" rx="8" className="ob-hero-titlebar" />
              <rect x="48" y="17" width="18" height="10" rx="3" className="ob-hero-chip" />
              <rect x="70" y="17" width="18" height="10" rx="3" className="ob-hero-chip is-active" />
              <rect x="92" y="17" width="18" height="10" rx="3" className="ob-hero-chip" />
              <rect x="50" y="42" width="80" height="54" rx="4" className="ob-hero-content" />
              <line x1="50" y1="104" x2="130" y2="104" className="ob-hero-line" />
              <line x1="50" y1="114" x2="112" y2="114" className="ob-hero-line" />
              <line x1="50" y1="124" x2="122" y2="124" className="ob-hero-line" />
              {/* 进阶面板浮窗 */}
              <rect x="158" y="56" width="86" height="64" rx="8" className="ob-hero-panel" />
              <rect x="158" y="56" width="86" height="16" rx="8" className="ob-hero-panel-bar" />
              <rect x="166" y="80" width="32" height="32" rx="4" className="ob-hero-panel-cell" />
              <rect x="204" y="80" width="32" height="32" rx="4" className="ob-hero-panel-cell" />
              {/* 独立窗口 + 脱离虚线 */}
              <rect x="168" y="14" width="56" height="26" rx="6" className="ob-hero-detached" />
              <rect x="168" y="14" width="56" height="9" rx="4.5" className="ob-hero-detached-bar" />
              <path d="M140 42 q14 16 28 16" className="ob-hero-link" strokeDasharray="3 3" />
            </svg>
            <div className="onboarding-welcome-hero">
              <h1 className="onboarding-welcome-title">工百窗</h1>
              <p className="onboarding-welcome-tagline">热键驱动的 AI 聚合工作台</p>
            </div>
            <div className="onboarding-welcome-points">
              {VALUE_POINTS.map((p) => (
                <div key={p.title} className="onboarding-welcome-point">
                  <span className="onboarding-welcome-point-icon">
                    <OnboardIcon>{ICONS[p.icon]}</OnboardIcon>
                  </span>
                  <strong>{p.title}</strong>
                  <span>{p.desc}</span>
                </div>
              ))}
            </div>
            <p className="onboarding-welcome-hint">共 {TOTAL_PAGES} 步 · 可随时跳过 · 之后可从设置菜单再次打开本指南</p>
          </div>
        )}

        {/* 页 1：认识窗口（开关内嵌窗口卡片，其余模块单独列出） */}
        {page === 1 && (
          <div className="onboarding-page onboarding-page-scrollable" data-name="onboarding.page-windows">
            <div className="onboarding-page-head-row">
              <div>
                <h2 className="onboarding-page-title">认识窗口</h2>
                <p className="onboarding-page-desc">
                  工百窗由几个窗口组成，各司其职。每个窗口的功能开关就在卡片里，按需启用。
                </p>
              </div>
              <button
                type="button"
                className="onboarding-btn-secondary onboarding-recommend-btn"
                onClick={() => void applyRecommended()}
                data-name="onboarding.recommend-button"
              >
                使用推荐配置
              </button>
            </div>
            <div className="onboarding-window-grid">
              {windowCards.map((c, idx) => (
                <div key={c.id} className="onboarding-window-card" data-name={`onboarding.window-card-${idx}`}>
                  <div className="onboarding-window-card-head">
                    <span className="onboarding-window-card-icon">
                      <OnboardIcon size={16}>{c.icon}</OnboardIcon>
                    </span>
                    <strong>{c.name}</strong>
                    {c.experimental && <em className="onboarding-module-badge">实验</em>}
                    <kbd className={`onboarding-window-entry${c.entry.enabled ? '' : ' is-disabled'}`}>
                      {c.entry.enabled ? c.entry.keys : `${c.entry.keys}（热键已禁用）`}
                    </kbd>
                  </div>
                  <p className="onboarding-window-desc">{c.desc}</p>
                  <div className="onboarding-window-tags">
                    {c.tags.map((t) => (
                      <span key={t} className="onboarding-window-tag">{t}</span>
                    ))}
                  </div>
                  {c.moduleIds.length > 0 && (
                    <div className="onboarding-window-modules">
                      {c.moduleIds.map((id) => {
                        const m = modules.find((x) => x.id === id);
                        return m ? renderWindowModuleRow(m) : null;
                      })}
                    </div>
                  )}
                  {c.extra && <p className="onboarding-window-extra">{c.extra}</p>}
                </div>
              ))}
            </div>

            {/* 不依附窗口的模块：单独列出并介绍 */}
            {extraModules.length > 0 && (
              <div className="onboarding-module-block" data-name="onboarding.module-block">
                <div className="onboarding-module-block-head">
                  <h3 className="onboarding-module-block-title">其他功能</h3>
                  <span className="onboarding-module-block-hint">不依附于某个窗口，随时可用</span>
                </div>
                <div className="onboarding-module-grid">
                  {extraModules.map(renderModuleCard)}
                </div>
              </div>
            )}
            {recommendMsg && <p className="onboarding-success">{recommendMsg}</p>}
            {moduleError && <p className="onboarding-error">{moduleError}</p>}
          </div>
        )}

        {/* 页 2：个性化（Oxy + 常用配置） */}
        {page === 2 && (
          <div className="onboarding-page onboarding-page-scrollable" data-name="onboarding.page-personalize">
            <h2 className="onboarding-page-title">个性化</h2>
            <p className="onboarding-page-desc">按你的习惯调整，稍后可在设置中修改。</p>
            <div className="onboarding-settings-grid">
              {/* Oxy 界面系统（跨两列） */}
              <div className="onboarding-setting-item onboarding-setting-row-wide">
                <div className="onboarding-setting-text">
                  <label className="onboarding-setting-label">Oxy 界面系统</label>
                  <span className="onboarding-setting-hint">
                    {isOxy
                      ? '已开启：主题与界面大小由系统自动管理'
                      : '开启后自动管理主题、界面大小与整体布局'}
                  </span>
                </div>
                <Toggle
                  checked={isOxy}
                  onChange={(v) => void handleOxyToggle(v)}
                  aria-label="Oxy 界面系统"
                />
              </div>
              {/* Oxy 关闭时：主题与界面大小手动配置 */}
              {!isOxy && (
                <>
                  <div className="onboarding-setting-item">
                    <label className="onboarding-setting-label">主题</label>
                    <div className="onboarding-radio-row">
                      {(['light', 'dark', 'system'] as ThemeMode[]).map((m) => (
                        <label key={m} className={`onboarding-radio${theme === m ? ' is-active' : ''}`}>
                          <input type="radio" name="theme" checked={theme === m} onChange={() => setTheme(m)} />
                          <span>{m === 'light' ? '亮色' : m === 'dark' ? '暗色' : '跟随系统'}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="onboarding-setting-item">
                    <label className="onboarding-setting-label">界面大小</label>
                    <div className="onboarding-radio-row">
                      {(['small', 'medium', 'large'] as const).map((s) => (
                        <label key={s} className={`onboarding-radio${settings.uiScale === s ? ' is-active' : ''}`}>
                          <input type="radio" name="uiScale" checked={settings.uiScale === s} onChange={() => void updateField('uiScale', s)} />
                          <span>{s === 'small' ? '紧凑' : s === 'medium' ? '标准' : '大号'}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {/* 关闭按钮 */}
              <div className="onboarding-setting-item">
                <label className="onboarding-setting-label">关闭按钮</label>
                <div className="onboarding-radio-row">
                  {(['minimize', 'close'] as const).map((b) => (
                    <label key={b} className={`onboarding-radio${settings.closeBehavior === b ? ' is-active' : ''}`}>
                      <input type="radio" name="closeBehavior" checked={settings.closeBehavior === b} onChange={() => void updateField('closeBehavior', b)} />
                      <span>{b === 'minimize' ? '最小化到托盘' : '直接退出'}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* 启动时打开 */}
              <div className="onboarding-setting-item">
                <label className="onboarding-setting-label">启动时打开</label>
                <div className="onboarding-radio-row">
                  {(['home', 'lastConversation'] as const).map((s) => (
                    <label key={s} className={`onboarding-radio${settings.startupOpen === s ? ' is-active' : ''}`}>
                      <input type="radio" name="startupOpen" checked={settings.startupOpen === s} onChange={() => void updateField('startupOpen', s)} />
                      <span>{s === 'home' ? '平台首页' : '最近对话'}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* 屏蔽国外模型 */}
              <div className="onboarding-setting-item onboarding-setting-row">
                <div className="onboarding-setting-text">
                  <label className="onboarding-setting-label">屏蔽国外模型</label>
                  <span className="onboarding-setting-hint">平台列表中隐藏国外模型</span>
                </div>
                <Toggle
                  checked={settings.hideForeignModels}
                  onChange={(v) => void updateField('hideForeignModels', v)}
                  aria-label="屏蔽国外模型"
                />
              </div>
              {/* 顶栏按钮 */}
              <div className="onboarding-setting-item onboarding-setting-row-wide">
                <div className="onboarding-setting-text">
                  <label className="onboarding-setting-label">顶栏按钮</label>
                  <span className="onboarding-setting-hint">选择主窗口顶栏显示的按钮组</span>
                </div>
                <div className="onboarding-chip-row">
                  {ALL_TOP_BAR_BUTTON_GROUPS.map((group, idx) => (
                    <Chip
                      key={group}
                      selected={settings.topBarVisibleButtons.includes(group)}
                      onClick={() => toggleTopBarGroup(group)}
                      data-name={`onboarding.topbar-chip-${idx + 1}`}
                      data-id={group}
                    >
                      {TOP_BAR_BUTTON_LABELS[group]}
                    </Chip>
                  ))}
                </div>
              </div>
              {/* 默认桌面 UA */}
              <div className="onboarding-setting-item onboarding-setting-row-wide">
                <div className="onboarding-setting-text">
                  <label className="onboarding-setting-label">默认桌面 UA</label>
                  <span className="onboarding-setting-hint">新建应用的默认桌面 User-Agent 预设，顶栏可随时切换</span>
                </div>
                <div className="onboarding-chip-row">
                  {desktopPresets.map((p, idx) => (
                    <Chip
                      key={p.id}
                      selected={settings.defaultDesktopUaPreset === p.id}
                      onClick={() => void updateField('defaultDesktopUaPreset', p.id)}
                      data-name={`onboarding.ua-chip-${idx + 1}`}
                      data-id={p.id}
                    >
                      {p.name}
                    </Chip>
                  ))}
                </div>
              </div>
              {/* 导入智能体 API */}
              <div className="onboarding-setting-item onboarding-setting-row-wide">
                <div className="onboarding-setting-text">
                  <label className="onboarding-setting-label">导入智能体 API</label>
                  <span className="onboarding-setting-hint">添加自定义 AI 应用，接入 OpenAI 兼容协议等任意服务</span>
                </div>
                <button
                  type="button"
                  className="onboarding-btn-secondary"
                  onClick={() => void openAiAppEditor({ mode: 'create' })}
                  data-name="onboarding.add-ai-app-button"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 页 3：上手动作（平铺三段式行，与 ShortcutsModal 视觉一致） */}
        {page === 3 && (
          <div className="onboarding-page" data-name="onboarding.page-actions">
            <h2 className="onboarding-page-title">上手动作</h2>
            <p className="onboarding-page-desc">记住三个全局热键，任何窗口都能随手呼出工百窗。</p>
            <div className="onboarding-shortcut-panel" data-name="onboarding.shortcut-panel">
              <div className="onboarding-shortcut-panel-head">
                <h3 className="onboarding-shortcut-panel-title">全局热键</h3>
                <span className="onboarding-shortcut-panel-hint">可在设置中自定义</span>
              </div>
              <div className="onboarding-shortcut-rows">
                {GLOBAL_HOTKEY_META.map((meta) => {
                  const d = resolveHotkey(hotkeys, meta.action, meta.fallbackKeys);
                  const toggleFn = meta.action === 'toggleMainWindow'
                    ? handleMainHotkeyToggle
                    : meta.action === 'toggleDetachedWindows'
                      ? handlePanelHotkeyToggle
                      : handleVoiceHotkeyToggle;
                  return (
                    <div
                      key={meta.action}
                      className={`onboarding-shortcut-row${d.enabled ? '' : ' is-disabled'}`}
                      data-name={`onboarding.shortcut-row-${meta.action}`}
                    >
                      <span className="onboarding-shortcut-keys">{d.keys}</span>
                      <span className="onboarding-shortcut-action">
                        {meta.actionText}
                      </span>
                      <Toggle
                        checked={d.enabled}
                        onChange={(v) => void toggleFn(v)}
                        aria-label={meta.actionText}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="onboarding-shortcut-panel-head">
                <h3 className="onboarding-shortcut-panel-title">高频窗口操作</h3>
              </div>
              <div className="onboarding-shortcut-rows">
                {frequentShortcuts.map((s) => (
                  <div key={s.keys} className="onboarding-shortcut-row" data-name={`onboarding.shortcut-row-${s.keys}`}>
                    <span className="onboarding-shortcut-keys">{s.keys}</span>
                    <span className="onboarding-shortcut-action">{s.action}</span>
                    <span className={`onboarding-scope-badge ${s.scope === '窗口内' ? 'is-window' : 'is-app'}`}>
                      {s.scope}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="onboarding-shortcut-callout" data-name="onboarding.shortcut-callout">
              随时按 <kbd>`</kbd> 呼出<strong>完整快捷键速查</strong>（含各页面专属快捷键）。
            </p>
          </div>
        )}

        {/* 页 4：开始使用 */}
        {page === 4 && (
          <div className="onboarding-page onboarding-finish" data-name="onboarding.page-finish">
            <div className="onboarding-finish-content">
              <h2 className="onboarding-finish-title">一切就绪</h2>
              <p className="onboarding-finish-desc">祝你使用愉快！</p>
              <div className="onboarding-finish-cards">
                <button
                  type="button"
                  className="onboarding-finish-card"
                  onClick={() => void handleImport()}
                  disabled={importing}
                  data-name="onboarding.finish-import"
                >
                  <span className="onboarding-finish-card-icon">
                    <OnboardIcon size={16}>{ICONS.download}</OnboardIcon>
                  </span>
                  <strong>{importing ? '导入中...' : '导入备份数据'}</strong>
                  <span>从旧电脑迁移对话、登录状态与设置</span>
                </button>
                <button
                  type="button"
                  className="onboarding-finish-card"
                  onClick={() => void handleFinishAndOpenSettings()}
                  disabled={finishing}
                  data-name="onboarding.finish-settings"
                >
                  <span className="onboarding-finish-card-icon">
                    <OnboardIcon size={16}>{ICONS.sliders}</OnboardIcon>
                  </span>
                  <strong>深入设置</strong>
                  <span>完成引导并打开完整设置</span>
                </button>
                <div className="onboarding-finish-card is-static" data-name="onboarding.finish-revisit">
                  <span className="onboarding-finish-card-icon">
                    <OnboardIcon size={16}>{ICONS.book}</OnboardIcon>
                  </span>
                  <strong>随时回顾</strong>
                  <span>本指南可从设置菜单再次打开</span>
                </div>
              </div>
              {importError && <span className="onboarding-error">{importError}</span>}
            </div>
          </div>
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
