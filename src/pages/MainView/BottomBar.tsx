import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PromptLibrary from '../../components/PromptLibrary';
import { GearIcon } from '../../components/icons';
import type { AIPlatform, CustomAIProvider, Profile, PromptTemplate } from '../../lib/electron-api';
import {
  triggerVoiceStart,
  triggerVoiceStop,
  listAIProviders,
  openAdvancedPanelWindow,
} from '../../lib/electron-api';
import { useTabStore } from '../../store/useTabStore';
import { useModuleStore } from '../../store/useModuleStore';
import { useProfileStore } from '../../store/useProfileStore';
import { findAiAppProfiles } from '../../lib/shared-utils';
import { useAiAppDrag } from '../../hooks/useAiAppDrag';
import { getPlatformColors } from './utils';

/* =====================================================================
   BottomBar —— 底栏（抽屉式）
   - 折叠态：仅露 8px 渐变手柄
   - 展开态：AI 应用网格（内置 Profile + 自定义供应商）+ 提示词库 + 操作按钮 + 手柄
   纯 UI 子组件，所有状态留在 index.tsx，通过 props 传递。
   内置 AI 应用按 profile 遍历（支持同一平台多实例），可拖拽排序。
   ===================================================================== */

// 底栏回调集合（统一对象，避免 props 数量过多）
export interface BottomBarCallbacks {
  onAppClick: (profile: Profile) => void;
  // 需求 1：onInjectPrompt 接收完整 PromptTemplate，由 MainView 执行 composeFinalText 后注入
  onInjectPrompt: (template: PromptTemplate) => Promise<{ success: boolean; platformName?: string }>;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onToggle: () => void;
  onHandleClick: (e: React.MouseEvent) => void;
}

export interface BottomBarProps {
  expanded: boolean;
  height: number;
  /** 已过滤的 AI 平台列表（用于反向查找平台元数据：颜色/名称） */
  platforms: AIPlatform[];
  openProfileIds: Set<string>;
  callbacks: BottomBarCallbacks;
  /** 点击已打开应用时的行为：switch=跳转 / close=关闭（close 模式下点击当前激活应用需二次确认） */
  appClickBehavior: 'switch' | 'close';
  /** 当前激活标签对应的 profileId（无激活标签时为 null） */
  activeProfileId: string | null;
}

/** pending 关闭确认超时时间（ms）：超时未第二次点击则取消关闭 */
const PENDING_CLOSE_TIMEOUT_MS = 3000;

export default function BottomBar({
  expanded,
  height,
  platforms,
  openProfileIds,
  callbacks,
  appClickBehavior,
  activeProfileId,
}: BottomBarProps) {
  // 模块门控：语音模块关闭时隐藏语音按钮（11.10 跨位置无注入）
  const voiceEnabled = useModuleStore((s) => s.isEnabled('voice'));
  const promptLibraryEnabled = useModuleStore((s) => s.isEnabled('prompt-library'));

  const {
    onAppClick,
    onInjectPrompt,
    onOpenSettings,
    onOpenShortcuts,
    onToggle,
    onHandleClick,
  } = callbacks;

  // close 模式下点击当前激活应用的「二次确认」状态：记录待关闭的 profileId
  // 第一次点击设置 pending + 显示覆盖的关闭图标提示，3 秒内再次点击才执行关闭
  const [pendingCloseProfileId, setPendingCloseProfileId] = useState<string | null>(null);
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 从 ProfileStore 读取 Profile 列表（由父组件 App.tsx 加载）
  const profiles = useProfileStore((s) => s.profiles);
  // 扁平遍历所有 AI 应用 Profile（按 order 升序），支持同一平台多实例
  // 同时应用 hideForeignModels + hiddenPlatforms 过滤：父组件传入的 platforms 是已过滤列表，
  // 一个 profile 可见当且仅当其对应的平台在过滤后的 platforms 列表中（按 id 或 url 反向匹配）
  const aiAppProfiles = useMemo(() => {
    const all = findAiAppProfiles(profiles);
    if (platforms.length === 0) return [];
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

  /**
   * 应用按钮点击包装：
   * - close 模式 + 点击的是当前激活应用：第一次点击进入 pending（显示关闭提示），
   *   3 秒内再次点击才真正调用 onAppClick（执行关闭）；超时自动取消 pending
   * - 其它情况（switch 模式 / 非当前应用）：直接调用 onAppClick
   */
  const handleAppClickWithConfirm = useCallback(
    (profile: Profile) => {
      const isCurrentActive =
        appClickBehavior === 'close' &&
        profile.id === activeProfileId;
      if (isCurrentActive) {
        if (pendingCloseProfileId === profile.id) {
          // 3 秒内第二次点击：执行关闭
          clearPendingClose();
          onAppClick(profile);
        } else {
          // 第一次点击：设置 pending 状态，3 秒后超时取消
          setPendingCloseProfileId(profile.id);
          if (pendingCloseTimerRef.current) clearTimeout(pendingCloseTimerRef.current);
          pendingCloseTimerRef.current = setTimeout(() => {
            pendingCloseTimerRef.current = null;
            setPendingCloseProfileId(null);
          }, PENDING_CLOSE_TIMEOUT_MS);
        }
      } else {
        // 非当前应用或 switch 模式：清除 pending 并直接点击
        clearPendingClose();
        onAppClick(profile);
      }
    },
    [appClickBehavior, activeProfileId, pendingCloseProfileId, onAppClick, clearPendingClose],
  );

  // 底栏显示状态：仅由 expanded 控制（与原 index.tsx 中 bottomVisible 一致）
  const visible = expanded;

  // 自定义 AI Provider 列表（与内置平台合并展示在「AI 应用」网格中）
  const [aiProviders, setAiProviders] = useState<CustomAIProvider[]>([]);

  // 展开时刷新自定义 AI Provider 列表
  useEffect(() => {
    if (!expanded) return;
    listAIProviders()
      .then(setAiProviders)
      .catch((e) => console.error('底栏加载 AI Provider 列表失败:', e));
  }, [expanded]);

  // 展开内容容器 ref，用于测量自然高度
  const contentRef = useRef<HTMLDivElement>(null);

  // 计算底栏目标展开高度：clamp(内容自然高度, 25% 窗口高度, 65% 窗口高度)
  // 内容在 [25%, 65%] 内时展开到自然高度（完全可见）；< 25% 展开到 25%（仍完全可见）；
  // > 65% 展开到 65%（内部滚动）。bottom-handle 为 absolute 负 top，不占 bottom-bar 高度。
  const computeTargetHeight = useCallback(() => {
    const el = contentRef.current;
    if (!el) return null;
    const winH = window.innerHeight;
    const minH = winH * 0.25;
    const maxH = winH * 0.65;
    const natural = el.scrollHeight;
    return Math.max(minH, Math.min(maxH, natural));
  }, []);

  // 展开时测量并写入 store；ResizeObserver 兜底内容异步加载后重新计算
  useEffect(() => {
    if (!expanded) return;
    const measure = () => {
      const target = computeTargetHeight();
      if (target != null) {
        useTabStore.getState().setBottomBarHeight(target);
      }
    };
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    if (contentRef.current) ro.observe(contentRef.current);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [expanded, computeTargetHeight]);

  /**
   * 点击自定义 AI Provider：打开 进阶面板（单例），可选定位到该供应商
   */
  const handleOpenProvider = (provider: CustomAIProvider) => {
    void openAdvancedPanelWindow(provider.id).catch((e) =>
      console.error('[BottomBar] 打开 进阶面板失败:', e),
    );
  };

  return (
    <div className="bottom-region" data-name="main.bottom-bar.region-container">
      <div
        className={`bottom-bar${visible ? ' visible' : ''}`}
        style={expanded ? { height } : undefined}
        data-name="main.bottom-bar.container"
      >
        {/* 展开态：AI 应用网格 + 提示词 + 操作 */}
        {expanded && (
          <div className="bottom-bar-expanded" ref={contentRef} data-name="main.bottom-bar.expanded-container">
            {/* AI 应用网格：先渲染自定义供应商（虚线边框区分），再渲染内置 Profile（可拖拽） */}
            <div data-name="main.bottom-bar.app-section">
              <div className="bottom-section-title" data-name="main.bottom-bar.app-section-title">AI 应用</div>
              {aiAppProfiles.length === 0 && aiProviders.length === 0 ? (
                <div className="bottom-section-empty" data-name="main.bottom-bar.app-section-empty">暂无 AI 应用</div>
              ) : (
              <div className="app-grid" data-name="main.bottom-bar.app-grid-list">
                {/* 自定义 AI 供应商 */}
                {aiProviders.map((p, idx) => {
                  const isMimo = p.apiEndpoint.includes('mimo') || p.model.includes('mimo');
                  const accent = isMimo ? 'var(--accent-bright)' : 'var(--info)';
                  const accentForeground = isMimo ? 'var(--accent-bright-foreground)' : 'var(--info-foreground)';
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="app-grid-item app-grid-item-provider"
                      onClick={() => handleOpenProvider(p)}
                      title={`打开「${p.name}」（${p.model}）`}
                      data-name={`main.bottom-bar.ai-provider-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={p.id}
                    >
                      <span
                        className="app-grid-icon"
                        style={{ background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 87%, transparent))`, color: accentForeground }}
                        aria-hidden="true"
                        data-name={`main.bottom-bar.ai-provider-item-${idx + 1}-icon`}
                      >
                        {p.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="app-grid-name" data-name={`main.bottom-bar.ai-provider-item-${idx + 1}-name`}>{p.name}</span>
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
                  const isOpen = openProfileIds.has(profile.id);
                  // close 模式下，当前激活应用处于 pending 确认状态时显示覆盖的关闭图标提示
                  const isPendingClose = pendingCloseProfileId === profile.id;
                  const isDragging = draggingId === profile.id;
                  const isHover = hoverId === profile.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      draggable
                      onDragStart={(e) => onDragStart(e, profile.id)}
                      onDragOver={(e) => onDragOver(e, profile.id)}
                      onDrop={(e) => onDrop(e, profile.id)}
                      onDragEnd={onDragEnd}
                      className={`app-grid-item${isOpen ? ' open' : ''}${isPendingClose ? ' pending-close' : ''}${isDragging ? ' dragging' : ''}${isHover ? ' drag-hover' : ''}`}
                      onClick={() => handleAppClickWithConfirm(profile)}
                      style={{
                        position: 'relative',
                        opacity: isDragging ? 0.4 : undefined,
                      }}
                      title={
                        isPendingClose
                          ? '再次点击关闭'
                          : `打开 ${displayName}`
                      }
                      data-name={`main.bottom-bar.ai-app-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={profile.id}
                    >
                      <span
                        className="app-grid-icon"
                        style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
                        aria-hidden="true"
                        data-name={`main.bottom-bar.ai-app-item-${idx + 1}-icon`}
                      >
                        {displayName.charAt(0).toUpperCase()}
                      </span>
                      <span className="app-grid-name" data-name={`main.bottom-bar.ai-app-item-${idx + 1}-name`}>{displayName}</span>
                      {/* pending 状态下覆盖关闭图标提示（hover 显示「再次点击关闭」） */}
                      {isPendingClose && (
                        <span
                          className="app-grid-close-overlay"
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
                          data-name={`main.bottom-bar.ai-app-item-${idx + 1}-close-overlay`}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            style={{ width: '40%', height: '40%' }}
                            data-name={`main.bottom-bar.ai-app-item-${idx + 1}-close-icon`}
                          >
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              )}
            </div>

            {/* 提示词模板库 */}
            {promptLibraryEnabled && <PromptLibrary onInject={onInjectPrompt} />}

            {/* 操作按钮 */}
            <div className="bottom-expanded-actions" data-name="main.bottom-bar.actions-group">
              <button
                type="button"
                className="expanded-btn"
                onClick={onOpenSettings}
                data-name="main.bottom-bar.settings-button"
              >
                <GearIcon className="icon-svg-sm" />
                设置
              </button>
              <button
                type="button"
                className="expanded-btn"
                onClick={onOpenShortcuts}
                data-name="main.bottom-bar.shortcuts-button"
              >
                <svg className="icon-svg-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.bottom-bar.shortcuts-icon">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
                </svg>
                快捷键
              </button>
              {voiceEnabled && (
              <button
                type="button"
                className="expanded-btn"
                onMouseDown={() => void triggerVoiceStart()}
                onMouseUp={() => void triggerVoiceStop()}
                onMouseLeave={() => void triggerVoiceStop()}
                onTouchStart={() => void triggerVoiceStart()}
                onTouchEnd={() => void triggerVoiceStop()}
                title="按住说话，松开发送（Alt+V）"
                data-name="main.bottom-bar.voice-button"
              >
                <svg className="icon-svg-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.bottom-bar.voice-icon">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                语音
              </button>
              )}
              <button
                type="button"
                className="expanded-btn"
                onClick={onToggle}
                title="收起底栏"
                data-name="main.bottom-bar.collapse-button"
              >
                <svg className="icon-svg-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="main.bottom-bar.collapse-icon">
                  <path d="m18 15-6-6-6 6" />
                </svg>
                收起
              </button>
            </div>
          </div>
        )}

        {/* 抽屉红色短横手柄（始终可见，点击展开/收起） */}
        <div
          className="bottom-handle"
          onClick={onHandleClick}
          data-dom-id="aw-main-bottom-handle"
          title={expanded ? '收起底栏' : '展开底栏'}
          data-name="main.bottom-bar.handle"
        >
          <div className="bottom-handle-bar" data-name="main.bottom-bar.handle-bar" />
        </div>
      </div>
    </div>
  );
}
