/* =====================================================================
   components/AppSwitcher.tsx —— 应用切换下拉菜单
   点击顶栏图标展开，AI 应用按最近使用时间排序：
   自定义 AI Provider（最近使用优先）+ 内置 AI 平台，统一展示。
   自定义供应商点击打开 进阶面板；内置平台点击切换/新建标签。
   平台列表由父组件（MainView）过滤后传入，保证与底栏同步。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AIPlatform, CustomAIProvider, Profile } from '../lib/electron-api';
import {
  listAIProviders,
  openAdvancedPanelWindow,
} from '../lib/electron-api';
import { onWindowHidden } from '../lib/electron-api/window';
import { useProfileStore } from '../store/useProfileStore';
import { useTabStore } from '../store/useTabStore';
import { findAiAppProfiles } from '../lib/shared-utils';
import { useAiAppDrag } from '../hooks/useAiAppDrag';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import { getPlatformColors } from '../pages/MainView/utils';
import './AppSwitcher.css';

/** pending 关闭确认超时时间（ms）：超时未第二次点击则取消关闭 */
const PENDING_CLOSE_TIMEOUT_MS = 3000

export interface AppSwitcherProps {
  /** 已过滤的 AI 平台列表（由父组件 MainView 传入，与底栏保持一致；仅用于反向查找平台元数据如颜色/名称） */
  platforms: AIPlatform[];
  /** 打开主窗口设置面板 */
  onOpenSettings?: () => void;
  /** 点击内置 AI 应用的回调（由 MainView 传入，统一走 handleAppClick 逻辑，含 appClickBehavior） */
  onAppClick?: (profile: Profile) => void;
  /** 点击已打开应用时的行为：switch=跳转 / close=关闭（close 模式下点击当前激活应用需二次确认） */
  appClickBehavior?: 'switch' | 'close';
  /** 当前激活标签对应的 profileId（无激活标签时为 null） */
  activeProfileId?: string | null;
}

export default function AppSwitcher({
  platforms: platformsProp,
  onAppClick,
  appClickBehavior = 'switch',
  activeProfileId = null,
}: AppSwitcherProps) {
  // 防御性默认值：HMR 热更新或父组件未传入时回退到空数组，避免白屏
  const platforms = platformsProp ?? [];
  const [isOpen, setIsOpen] = useState(false);
  const [aiProviders, setAiProviders] = useState<CustomAIProvider[]>([]);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // close 模式下点击当前激活应用的「二次确认」状态（与 BottomBar 逻辑一致）
  const [pendingCloseProfileId, setPendingCloseProfileId] = useState<string | null>(null);
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const profiles = useProfileStore((s) => s.profiles);
  const addTab = useTabStore((s) => s.addTab);
  // 读取当前标签与激活态：用于「已打开高亮」与「再点当前应用关闭」的等价规则
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);

  // 清理 pending 状态（取消定时器 + 重置 state）
  const clearPendingClose = useCallback(() => {
    if (pendingCloseTimerRef.current) {
      clearTimeout(pendingCloseTimerRef.current);
      pendingCloseTimerRef.current = null;
    }
    setPendingCloseProfileId(null);
  }, []);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (pendingCloseTimerRef.current) {
        clearTimeout(pendingCloseTimerRef.current);
        pendingCloseTimerRef.current = null;
      }
    };
  }, []);

  // 下拉打开时刷新自定义 AI Provider 列表
  useEffect(() => {
    if (!isOpen) return;
    listAIProviders()
      .then(setAiProviders)
      .catch((e) => console.error('加载自定义 AI Provider 列表失败:', e));
  }, [isOpen]);

  // 启动时也加载一次（防止外部直接修改 aiProviders 后下拉未打开时显示陈旧数据）
  useEffect(() => {
    listAIProviders()
      .then(setAiProviders)
      .catch((e) => console.error('[app-switcher] 加载 AI Providers 失败:', e));
  }, []);

  // 窗口隐藏时自动关闭下拉菜单，防止下次显示时仍残留
  useEffect(() => {
    const off = onWindowHidden(() => {
      setIsOpen(false);
    });
    return () => { off(); };
  }, []);

  // ESC 关闭下拉菜单
  useEscToCloseOverlay(isOpen, () => setIsOpen(false));

  // 当前激活 tab 对应的内置 AI 平台（用于左上角按钮显示首字母 + 主题色背景）
  const activePlatform = useMemo(() => {
    if (!activeTabId) return undefined;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return undefined;
    const profile = profiles.find((p) => p.id === tab.profileId);
    if (!profile?.isAIPlatform) return undefined;
    if (profile.aiPlatformId) {
      const p = platforms.find((pp) => pp.id === profile.aiPlatformId);
      if (p) return p;
    }
    if (profile.aiPlatformUrl) {
      return platforms.find((pp) => pp.url === profile.aiPlatformUrl);
    }
    return undefined;
  }, [activeTabId, tabs, profiles, platforms]);

  // 下拉菜单位置：使用 fixed 定位脱离父级 stacking-context，避免被 overlay/webview 遮挡
  useEffect(() => {
    if (!isOpen || !wrapRef.current) return;
    const updatePos = () => {
      if (!wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    return () => window.removeEventListener('resize', updatePos);
  }, [isOpen]);

  // 点击外部关闭（遮罩层 onClick 处理，无需 document 监听）

  // 已打开标签的 profileId 集合（用于「已打开」高亮，与底栏一致）
  const openProfileIds = new Set(tabs.map((t) => t.profileId));

  // 扁平遍历所有 AI 应用 Profile（按 order 升序），支持同一平台多实例
  // 同时应用 hideForeignModels + hiddenPlatforms 过滤：父组件传入的 platforms 是已过滤列表，
  // 一个 profile 可见当且仅当其对应的平台在过滤后的 platforms 列表中（按 id 或 url 反向匹配）
  const aiAppProfiles = useMemo(() => {
    const all = findAiAppProfiles(profiles);
    if (platforms.length === 0) return [];
    // 构建 platforms 的 id 集合 + url 集合，O(1) 查找
    const platformIdSet = new Set(platforms.map((p) => p.id));
    const platformUrlSet = new Set(platforms.map((p) => p.url));
    return all.filter((profile) => {
      if (profile.aiPlatformId) return platformIdSet.has(profile.aiPlatformId);
      if (profile.aiPlatformUrl) return platformUrlSet.has(profile.aiPlatformUrl);
      return false;
    });
  }, [profiles, platforms]);
  // 拖拽排序 hook（onDrop 时调用 useProfileStore.reorderProfiles 持久化）
  const { draggingId, hoverId, onDragStart, onDragOver, onDrop, onDragEnd } = useAiAppDrag(aiAppProfiles);

  // 自定义 AI Provider 按最近使用时间排序（最近使用的排在前面）
  const sortedProviders = useMemo(() => {
    return [...aiProviders].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1));
  }, [aiProviders]);

  // 点击应用：统一走 onAppClick 回调（与底栏完全等价的打开/关闭规则，含 appClickBehavior）
  //  - close 模式 + 点击当前激活应用：第一次点击进入 pending（显示关闭提示），
  //    3 秒内再次点击才真正调用 onAppClick（执行关闭）；超时自动取消 pending
  //  - switch 模式 / 非当前应用：直接调用 onAppClick，并收起下拉
  //  - 若父组件未传入 onAppClick，回退到本地逻辑：仅 addTab（内部会切换到已存在标签或新建），不关闭当前标签
  const handleSelect = (profile: Profile) => {
    const isCurrentActive =
      appClickBehavior === 'close' &&
      profile.id === activeProfileId;

    if (isCurrentActive) {
      // close 模式下点击当前激活应用：二次确认
      if (pendingCloseProfileId === profile.id) {
        // 3 秒内第二次点击：执行关闭
        clearPendingClose();
        if (onAppClick) {
          onAppClick(profile);
        } else {
          // 本地回退无 close 逻辑，仅收起
        }
        setIsOpen(false);
      } else {
        // 第一次点击：设置 pending 状态，3 秒后超时取消（不收起下拉，让用户看到提示）
        setPendingCloseProfileId(profile.id);
        if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current);
        pendingCloseTimerRef.current = setTimeout(() => {
          pendingCloseTimerRef.current = null;
          setPendingCloseProfileId(null);
        }, PENDING_CLOSE_TIMEOUT_MS);
      }
      return;
    }

    // 非当前应用或 switch 模式：清除 pending 并直接点击
    clearPendingClose();
    if (onAppClick) {
      onAppClick(profile);
    } else {
      // 本地回退：onAppClick 未传入时，仅切换/新建，不关闭（与 handleAppClick switch 模式一致）
      void addTab(profile);
    }
    setIsOpen(false);
  };

  /**
   * 点击自定义 AI Provider：打开 进阶面板（单例），可选定位到该供应商。
   */
  const handleOpenProvider = (provider: CustomAIProvider) => {
    void openAdvancedPanelWindow(provider.id).catch((e) =>
      console.error('[AppSwitcher] 打开 进阶面板失败:', e),
    );
    setIsOpen(false);
  };

  return (
    <>
      {/* 遮罩层：下拉打开时覆盖全屏，点击收起（webview 原生组件不冒泡，遮罩可拦截） */}
      {isOpen && (
        <div
          className="app-switcher-overlay"
          data-name="component.app-switcher.overlay"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="app-switcher-wrap" ref={wrapRef} data-name="component.app-switcher.wrapper">
        <button
          type="button"
          className={`app-switcher-btn${isOpen ? ' open' : ''}`}
          data-name={`component.app-switcher.toggle-button${isOpen ? '-active' : '-inactive'}`}
          aria-label="切换应用"
          title="切换应用"
          onClick={() => setIsOpen((v) => !v)}
          style={
            activePlatform
              ? { background: `linear-gradient(135deg, ${activePlatform.themeColor}, ${activePlatform.gradientColor})` }
              : undefined
          }
        >
          {activePlatform ? activePlatform.name.charAt(0).toUpperCase() : 'A'}
        </button>
      </div>
      {isOpen && createPortal(
        <div
          className="app-switcher-dropdown"
          role="menu"
          data-name="component.app-switcher.dropdown"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {/* AI 应用：自定义供应商（常用+非常用）+ 内置平台 Profile，统一展示（不再单独分组） */}
          <div
            className="app-switcher-section-label"
            data-name="component.app-switcher.section-label-ai-app"
          >
            AI 应用
          </div>
          {sortedProviders.length === 0 && aiAppProfiles.length === 0 ? (
            <div
              className="app-switcher-empty"
              data-name="component.app-switcher.empty"
            >
              暂无 AI 应用
            </div>
          ) : (
            <>
              {/* 自定义 AI 供应商（按最近使用排序） */}
              {sortedProviders.map((p, idx) => {
                const isMimo = p.apiEndpoint.includes('mimo') || p.model.includes('mimo');
                const accent = isMimo ? 'var(--accent-bright)' : 'var(--info)';
                const accentForeground = isMimo ? 'var(--accent-bright-foreground)' : 'var(--info-foreground)';
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="app-switcher-item chat"
                    data-name={`component.app-switcher.provider-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={p.id}
                    onClick={() => handleOpenProvider(p)}
                    title={`打开「${p.name}」（${p.model}）`}
                  >
                    <span
                      className="app-switcher-item-icon"
                      data-name={`component.app-switcher.provider-item-icon-${idx + 1}`}
                      style={{ background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 87%, transparent))`, color: accentForeground }}
                      aria-hidden="true"
                    >
                      {p.name.charAt(0).toUpperCase()}
                    </span>
                    <span
                      className="app-switcher-item-name"
                      data-name={`component.app-switcher.provider-item-name-${idx + 1}`}
                    >
                      {p.name}
                    </span>
                  </button>
                );
              })}

              {/* 内置 AI 应用 Profile 列表（按 profile 遍历，支持同一平台多实例；可拖拽排序） */}
              {aiAppProfiles.map((profile, idx) => {
                // 反向查找平台元数据（颜色/名称）：profile.aiPlatformId 优先，旧数据回退 aiPlatformUrl
                const platform = profile.aiPlatformId
                  ? platforms.find((pp) => pp.id === profile.aiPlatformId)
                  : platforms.find((pp) => pp.url === profile.aiPlatformUrl);
                const { themeColor: c1, gradientColor: c2 } = platform
                  ? getPlatformColors(profile, platform, platform.id)
                  : { themeColor: 'var(--accent)', gradientColor: 'var(--accent)' };
                const displayName = platform?.name ?? profile.name ?? 'AI';
                const isPlatformOpen = openProfileIds.has(profile.id);
                const isPlatformActive = isPlatformOpen && tabs.find((t) => t.profileId === profile.id)?.id === activeTabId;
                const isPendingClose = pendingCloseProfileId === profile.id;
                const isDragging = draggingId === profile.id;
                const isHover = hoverId === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    draggable
                    data-name={`component.app-switcher.profile-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={profile.id}
                    onDragStart={(e) => onDragStart(e, profile.id)}
                    onDragOver={(e) => onDragOver(e, profile.id)}
                    onDrop={(e) => onDrop(e, profile.id)}
                    onDragEnd={onDragEnd}
                    className={`app-switcher-item${isPlatformOpen ? ' open' : ''}${isPlatformActive ? ' active' : ''}${isPendingClose ? ' pending-close' : ''}${isDragging ? ' dragging' : ''}${isHover ? ' drag-hover' : ''}`}
                    onClick={() => handleSelect(profile)}
                    style={isDragging ? { opacity: 0.4 } : undefined}
                    title={
                      isPendingClose
                        ? '再次点击关闭'
                        : isPlatformActive && appClickBehavior === 'close'
                          ? `关闭 ${displayName}`
                          : `打开 ${displayName}`
                    }
                  >
                    <span
                      className="app-switcher-item-icon"
                      data-name={`component.app-switcher.profile-item-icon-${idx + 1}`}
                      style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
                      aria-hidden="true"
                    >
                      {displayName.charAt(0).toUpperCase()}
                    </span>
                    <span
                      className="app-switcher-item-name"
                      data-name={`component.app-switcher.profile-item-name-${idx + 1}`}
                    >
                      {displayName}
                    </span>
                    {/* pending 状态下覆盖关闭图标提示 */}
                    {isPendingClose && (
                      <span
                        className="app-switcher-item-close-overlay"
                        data-name={`component.app-switcher.profile-item-close-overlay-${idx + 1}`}
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'rgba(220, 38, 38, 0.65)',
                          borderRadius: 'inherit',
                          pointerEvents: 'none',
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          data-name={`component.app-switcher.profile-item-close-icon-${idx + 1}`}
                          style={{ width: '40%', height: '40%' }}
                        >
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
