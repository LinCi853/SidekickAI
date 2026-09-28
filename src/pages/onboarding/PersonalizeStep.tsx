/* =====================================================================
   pages/onboarding/PersonalizeStep.tsx —— 引导页 2：个性化
   职责：Oxy 界面系统开关（开启后主题/界面大小由系统自动管理，关闭时恢复手动配置）；
   经典版主题/界面大小；关闭行为/启动时打开；屏蔽国外模型、顶栏按钮显隐、
   默认桌面 UA 预设、导入智能体 API 入口。
   从 pages/OnboardingView.tsx 拆出，仅通过 props 回调操作状态，不改变任何行为。
   ===================================================================== */

import {
  ALL_TOP_BAR_BUTTON_GROUPS,
  openAiAppEditor,
  type AppSettings,
  type DevicePreset,
  type TopBarButtonGroup,
} from '../../lib/electron-api';
import type { ThemeMode } from '../../store/useThemeStore';
import { Chip, Toggle } from '../../components/ui';

/** 顶栏按钮组 → 展示名 */
const TOP_BAR_BUTTON_LABELS: Record<TopBarButtonGroup, string> = {
  uaToggle: 'UA 切换',
  navBack: '后退',
  navForward: '前进',
  navHome: '主页',
  themeToggle: '主题',
  pinToggle: '置顶',
};

interface PersonalizeStepProps {
  settings: AppSettings;
  presets: DevicePreset[];
  isOxy: boolean;
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  /** Oxy 界面系统开关（开启后主题/界面大小由系统自动管理；关闭时恢复用户手动比例） */
  onOxyToggle: (next: boolean) => Promise<void>;
  updateField: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  toggleTopBarGroup: (group: TopBarButtonGroup) => void;
}

export default function PersonalizeStep({
  settings,
  presets,
  isOxy,
  theme,
  setTheme,
  onOxyToggle,
  updateField,
  toggleTopBarGroup,
}: PersonalizeStepProps) {
  const desktopPresets = presets.filter((p) => p.platform === 'desktop');

  return (
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
            onChange={(v) => void onOxyToggle(v)}
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
  );
}
