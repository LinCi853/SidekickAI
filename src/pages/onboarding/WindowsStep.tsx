import type { ReactNode } from 'react';
import type { HotkeyConfig, ModuleInfo } from '../../lib/electron-api';
import { Toggle } from '../../components/ui';
import { ICONS, OnboardIcon } from './OnboardIcon';
import { resolveHotkey } from './onboardingData';

/** 窗口卡片 → 内嵌模块开关（按模块主要使用位置归属） */
const WINDOW_MODULE_MAP: Record<string, string[]> = {
  main: [],
  assets: ['prompt-library', 'freeze'],
  panel: ['custom-chat', 'whiteboard', 'notes'],
  browser: ['browser'],
};

/** 模块 → 用户价值描述（覆盖 manifest 中的技术描述；未覆盖时回退 manifest.description） */
const MODULE_VALUE_DESC: Record<string, string> = {
  'custom-chat': '接入 OpenAI 兼容协议的自定义 AI 服务，流式直连对话',
  'prompt-library': '集中收纳对话、提示词、资料与原件，查看文本用量',
  notes: '灵感笔记：任务列表、代码块、图片，随用随记',
  whiteboard: '无限画布白板，对话内容和截图都能推到白板',
  voice: '按住 Alt+V 说话、松开发送，后台语音输入',
  tts: '自定义供应商 TTS 语音合成',
  browser: 'Chrome 风格多标签浏览器窗口，可脱离/回归',
  freeze: '冻结 AI 页面防止对方撤回/删除内容，可选中复制',
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

interface WindowsStepProps {
  modules: ModuleInfo[];
  hotkeys: HotkeyConfig[];
  recommendMsg: string | null;
  moduleError: string | null;
  onApplyRecommended: () => void;
  onModuleToggle: (id: string, enabled: boolean) => Promise<void>;
}

export default function WindowsStep({
  modules,
  hotkeys,
  recommendMsg,
  moduleError,
  onApplyRecommended,
  onModuleToggle,
}: WindowsStepProps) {
  const browserEnabled = modules.find((m) => m.id === 'browser')?.enabled ?? false;
  const hkMain = resolveHotkey(hotkeys, 'toggleMainWindow', 'Alt + Space');
  const hkPanel = resolveHotkey(hotkeys, 'toggleDetachedWindows', 'Alt + Q');
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
      id: 'assets',
      icon: ICONS.appWindow,
      name: 'AI资产',
      entry: { keys: '主窗口菜单', enabled: true },
      desc: '对话、提示词和资料集中收纳，原件保存在本地；手动页面冻结也在这里管理。',
      tags: ['对话与修订', '提示词管理', '资料原件', '文本用量'],
      moduleIds: WINDOW_MODULE_MAP.assets,
    },
    {
      id: 'browser',
      icon: ICONS.globe,
      name: '浏览器窗口',
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

  const renderWindowModuleRow = (m: ModuleInfo) => (
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
        onChange={(v) => void onModuleToggle(m.id, v)}
        aria-label={'启用 ' + m.name}
      />
    </div>
  );

  const renderModuleCard = (m: ModuleInfo) => (
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
        onChange={(v) => void onModuleToggle(m.id, v)}
        aria-label={'启用 ' + m.name}
      />
    </div>
  );

  return (
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
          onClick={() => onApplyRecommended()}
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

      {/* Independent capabilities */}
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
  );
}
