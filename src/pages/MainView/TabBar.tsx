import { useEffect, useMemo, useRef, useState } from 'react';
import type { TabState, Profile, AIPlatform } from '../../lib/electron-api';
import { IconButton } from '../../components/ui';
import { getPlatformColors } from './utils';

/* =====================================================================
   TabBar —— 标签栏（tab-chip 列表 + 拖拽排序 + 颜色指示器）
   纯 UI 子组件，所有状态留在 index.tsx，通过 props 传递。
   收起态支持「呼吸效果」提示当前区域（AI 主题色）；
   收起行为受 collapsed 设置控制：true=收起+hover 展开（带延时），
   false=常驻显示。
   ===================================================================== */

export interface TabBarData {
  /** 标签列表 */
  tabs: TabState[];
  /** 激活标签 id */
  activeTabId: string | null;
  /** 正在拖拽的标签 id */
  draggingTabId: string | null;
  /** 拖拽悬停的目标标签 id */
  hoverTabId: string | null;
  /** 是否启用收起（hover 才展开）。false 时常驻显示 */
  collapsed: boolean;
  /** 内置 AI 平台列表（用于查找 themeColor，驱动呼吸动画与图标背景） */
  platforms: AIPlatform[];
  /** 标签栏最大行数（默认 1，Oxy 模式传 2 支持两行换行） */
  maxRows?: number;
}

export interface TabBarActions {
  /** 按 profileId 查找 Profile */
  getProfile: (profileId: string) => Profile | null;
  /** 切换激活标签 */
  setActiveTab: (id: string) => void;
  /** 关闭标签 */
  closeTab: (id: string) => void;
  /** 右键菜单 */
  onTabContextMenu: (e: React.MouseEvent, tabId: string) => void;
  /** 拖拽开始 */
  onTabDragStart: (e: React.DragEvent, tabId: string) => void;
  /** 拖拽悬停 */
  onTabDragOver: (e: React.DragEvent, tabId: string) => void;
  /** 拖拽释放 */
  onTabDrop: (e: React.DragEvent, tabId: string) => void;
  /** 拖拽结束 */
  onTabDragEnd: (e: React.DragEvent) => void;
}

export interface TabBarProps {
  data: TabBarData;
  actions: TabBarActions;
}

// hover 展开/收起延时（ms）：进入极快响应（掠过即显示），离开延时较长（滞留，避免误触隐藏）
const EXPAND_DELAY = 20;
const COLLAPSE_DELAY = 800;

export default function TabBar({ data, actions }: TabBarProps) {
  const { tabs, activeTabId, draggingTabId, hoverTabId, collapsed, platforms, maxRows = 1 } = data;
  const {
    getProfile,
    setActiveTab,
    closeTab,
    onTabContextMenu,
    onTabDragStart,
    onTabDragOver,
    onTabDrop,
    onTabDragEnd,
  } = actions;

  // JS 控制的展开态：collapsed=true 时由 mouseenter/leave 驱动（带延时）
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 初始展示计时器：挂载/开启收起时展示 2 秒让用户感知"这里有顶栏"
  const initialShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (initialShowTimer.current) clearTimeout(initialShowTimer.current);
    };
  }, []);

  // 初始展示：collapsed=true 时挂载/开启收起后展示 2 秒，让用户感知"这里有顶栏"
  useEffect(() => {
    if (!collapsed) return;
    setHoverExpanded(true);
    initialShowTimer.current = setTimeout(() => {
      setHoverExpanded(false);
      initialShowTimer.current = null;
    }, 2000);
    return () => {
      if (initialShowTimer.current) {
        clearTimeout(initialShowTimer.current);
        initialShowTimer.current = null;
      }
    };
  }, [collapsed]);

  // 平台查找表：通过 aiPlatformId 快速查找 platform 对象
  const platformMap = useMemo(() => {
    const m = new Map<string, AIPlatform>();
    for (const p of platforms) m.set(p.id, p);
    return m;
  }, [platforms]);

  /** 按 profile 查找对应的内置 AI 平台（与 index.tsx 中 webview 查找规则一致） */
  const findPlatform = (profile: Profile | null): AIPlatform | undefined => {
    if (!profile?.isAIPlatform) return undefined;
    if (profile.aiPlatformId) {
      const p = platformMap.get(profile.aiPlatformId);
      if (p) return p;
    }
    if (profile.aiPlatformUrl) {
      return platforms.find((p) => p.url === profile.aiPlatformUrl);
    }
    return undefined;
  };

  // 当前激活 tab 对应平台的 themeColor（用于收起态呼吸动画的 CSS 变量 --tab-breath-color）
  const breathColor = useMemo(() => {
    if (!activeTabId) return undefined;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return undefined;
    const profile = getProfile(tab.profileId);
    const platform = findPlatform(profile);
    return getPlatformColors(profile, platform, tab.profileId).themeColor;
    // getProfile 来自 actions，理论上稳定引用；findPlatform 依赖 platformMap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs, getProfile, platformMap]);

  const handleMouseEnter = () => {
    if (!collapsed) return;
    // 用户主动 hover，取消初始展示的自动收起，交由 hover 机制接管
    if (initialShowTimer.current) {
      clearTimeout(initialShowTimer.current);
      initialShowTimer.current = null;
    }
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    if (hoverExpanded) return;
    enterTimer.current = setTimeout(() => setHoverExpanded(true), EXPAND_DELAY);
  };

  const handleMouseLeave = () => {
    if (!collapsed) return;
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    if (!hoverExpanded) return;
    // 离开延时收起：避免鼠标短暂移出即隐藏
    leaveTimer.current = setTimeout(() => setHoverExpanded(false), COLLAPSE_DELAY);
  };

  // 实际是否展开：collapsed=false 常驻展开；collapsed=true 看 hoverExpanded
  const expanded = !collapsed || hoverExpanded;

  // 收起态呼吸动画颜色：通过 CSS 变量 --tab-breath-color 注入到 keyframe
  const barStyle = breathColor
    ? ({ ['--tab-breath-color' as string]: breathColor } as React.CSSProperties)
    : undefined;

  // Oxy 模式（maxRows > 1）：JS 计算标签栏展开高度（CSS-in-JS，不依赖浏览器 CSS 布局算法）
  // 原理：测量每个标签的实际 offsetTop，统计真实行数，限制最多 maxRows 行
  const barRef = useRef<HTMLDivElement>(null);
  const [oxyHeight, setOxyHeight] = useState<number | null>(null);
  useEffect(() => {
    if (maxRows <= 1 || !expanded) {
      setOxyHeight(null);
      return;
    }
    const bar = barRef.current;
    if (!bar) return;

    const compute = () => {
      const chips = bar.querySelectorAll<HTMLElement>('.tab-chip');
      if (chips.length === 0) return;

      const style = getComputedStyle(bar);
      const padT = parseFloat(style.paddingTop) || 0;
      const padB = parseFloat(style.paddingBottom) || 0;
      const gapY = parseFloat(style.rowGap) || 0;

      // 按实际 offsetTop 分组统计真实行数
      const rowsMap = new Map<number, HTMLElement[]>();
      chips.forEach((chip) => {
        const top = chip.offsetTop;
        if (!rowsMap.has(top)) rowsMap.set(top, []);
        rowsMap.get(top)!.push(chip);
      });

      // 取前 maxRows 行参与高度计算
      const sortedTops = Array.from(rowsMap.keys()).sort((a, b) => a - b).slice(0, maxRows);
      if (sortedTops.length === 0) return;

      let totalHeight = 0;
      sortedTops.forEach((top, idx) => {
        const rowChips = rowsMap.get(top)!;
        // 该行实际最大高度
        const rowH = Math.max(...rowChips.map((chip) => chip.getBoundingClientRect().height));
        totalHeight += rowH;
        if (idx < sortedTops.length - 1) totalHeight += gapY;
      });

      const h = totalHeight + padT + padB;
      setOxyHeight(h);
    };

    requestAnimationFrame(compute);
    const ro = new ResizeObserver(compute);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [maxRows, expanded, tabs.length]);

  // 合并 style：呼吸色 + Oxy JS 计算高度
  const containerStyle: React.CSSProperties = {
    ...barStyle,
    ...(oxyHeight != null ? { height: `${oxyHeight}px`, minHeight: `${oxyHeight}px` } : {}),
  };

  return (
    <div
      ref={barRef}
      className={`tab-bar${expanded ? ' is-expanded' : ''}${collapsed ? ' is-collapsible' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={containerStyle}
      data-oxy-rows={maxRows > 1 ? String(maxRows) : undefined}
      data-name="main.tab-bar.container"
    >
      {tabs.map((tab, idx) => {
        const profile = getProfile(tab.profileId);
        const platform = findPlatform(profile);
        const { themeColor: c1, gradientColor: c2 } = getPlatformColors(profile, platform, tab.profileId);
        const isActive = tab.id === activeTabId;
        const url = tab.url || profile?.aiPlatformUrl || '';
        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            className={`tab-chip${isActive ? ' active' : ''}${draggingTabId === tab.id ? ' dragging' : ''}${hoverTabId === tab.id ? ' hover' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(tab.id); } }}
            onContextMenu={(e) => onTabContextMenu(e, tab.id)}
            onDragStart={(e) => onTabDragStart(e, tab.id)}
            onDragOver={(e) => onTabDragOver(e, tab.id)}
            onDrop={(e) => onTabDrop(e, tab.id)}
            onDragEnd={onTabDragEnd}
            draggable
            title={`${tab.title}\n${url}`}
            data-name={`main.tab-bar.tab-${idx + 1}`}
            data-index={idx + 1}
            data-id={tab.id}
          >
            <span
              className="tab-chip-icon"
              style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
              aria-hidden="true"
              data-name={`main.tab-bar.tab-${idx + 1}-icon`}
            >
              {(profile?.name ?? '?').charAt(0).toUpperCase()}
            </span>
            <span className="tab-chip-text" data-name={`main.tab-bar.tab-${idx + 1}-text`}>
              <span className="tab-chip-name" data-name={`main.tab-bar.tab-${idx + 1}-name`}>{tab.title}</span>
            </span>
            {/* 关闭按钮：常驻在标签右侧，激活标签始终可见，其它 hover 显示 */}
            <IconButton
              type="button"
              className="tab-action"
              aria-label="关闭标签"
              title="关闭标签"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
              data-name={`main.tab-bar.tab-${idx + 1}-close-icon-button`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" data-name={`main.tab-bar.tab-${idx + 1}-close-icon`}>
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </IconButton>
          </div>
        );
      })}
      {/* 收起态指示器：所有标签使用同一颜色（muted），仅 active 位置以主题色高亮 + 呼吸动画。
          避免颜色过多让用户难以定位"当前所在"。 */}
      <div className="tab-indicators" data-name="main.tab-bar.indicators-group">
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          return (
            <span
              key={tab.id}
              className={`tab-indicator${isActive ? ' active' : ''}`}
              data-name={`main.tab-bar.indicator-${idx + 1}`}
              data-index={idx + 1}
              data-id={tab.id}
            />
          );
        })}
      </div>
    </div>
  );
}
