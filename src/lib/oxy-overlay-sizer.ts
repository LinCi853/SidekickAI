/* =====================================================================
   Oxy Overlay Sizer — 二级页面/遮罩自动尺寸计算
   为右键菜单、模态对话框、浮层提示等提供 JS 驱动的尺寸计算。
   ===================================================================== */

import { OXY_OVERLAYS } from './oxy-config';

/** 父窗口尺寸 */
export interface ParentSize {
  width: number;
  height: number;
}

/* ===== 右键菜单 ===== */

/**
 * 计算右键菜单的最佳尺寸。
 * @param itemTexts 所有菜单项文本（用于计算最大宽度）
 * @param itemCount 菜单项总数
 * @param separatorCount 分隔线数量
 * @param itemHeight 单项高度（px）
 * @param parent 父窗口尺寸
 */
export function computeContextMenuSize(
  itemTexts: string[],
  itemCount: number,
  separatorCount: number,
  itemHeight: number,
  parent: ParentSize,
): { width: number; height: number } {
  const cfg = OXY_OVERLAYS.contextMenu;

  // 宽度：最长文本宽度 + icon 区域 + padding
  const iconArea = 24 + 8; // icon 24px + gap 8px
  const padding = 16; // 左右 padding
  const maxTextWidth = Math.max(...itemTexts.map((t) => estimateTextWidth(t, 14)), 0);
  const computedWidth = maxTextWidth + iconArea + padding * 2;
  const width = Math.max(cfg.widthMin, Math.min(computedWidth, parent.width * cfg.parentRatio));

  // 高度：项数 × 单项高度 + 分隔线高度 + padding
  const separatorHeight = 1 + 8; // 1px 线 + 上下 margin 4px
  const computedHeight = itemCount * itemHeight + separatorCount * separatorHeight + padding;
  const height = Math.max(100, Math.min(computedHeight, parent.height * cfg.parentRatio));

  return { width: Math.round(width), height: Math.round(height) };
}

/* ===== 模态对话框 ===== */

/**
 * 计算模态对话框的最佳尺寸。
 * @param contentHeight 内容实测高度（通过 ResizeObserver 获取）
 * @param parent 父窗口尺寸
 */
export function computeModalSize(
  contentHeight: number,
  parent: ParentSize,
): { width: number; height: number } {
  const cfg = OXY_OVERLAYS.modal;

  const width = Math.max(cfg.widthMin, Math.min(parent.width * cfg.parentRatio, cfg.widthMax));

  const padding = 48; // 上下 padding + header/footer
  const computedHeight = contentHeight + padding;
  const height = Math.max(cfg.heightMin, Math.min(computedHeight, parent.height * cfg.heightParentRatio));

  return { width: Math.round(width), height: Math.round(height) };
}

/* ===== 浮层提示 ===== */

/**
 * 计算浮层提示的最佳尺寸。
 * @param contentWidth 内容实测宽度
 * @param parent 父窗口尺寸
 */
export function computeTooltipSize(
  contentWidth: number,
  parent: ParentSize,
): { width: number; height: 'auto' } {
  const cfg = OXY_OVERLAYS.tooltip;
  const padding = 24;
  const computedWidth = contentWidth + padding;
  const width = Math.max(cfg.widthMin, Math.min(computedWidth, parent.width * cfg.parentRatio));
  return { width: Math.round(width), height: 'auto' };
}

/* ===== 辅助函数 ===== */

/**
 * 估算文本渲染宽度（与 window-size.ts estimateTextWidth 同逻辑）。
 */
function estimateTextWidth(text: string, fontSize: number): number {
  if (!text) return 0;
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef);
    width += isCJK ? fontSize : fontSize * 0.6;
  }
  return width;
}

/**
 * 获取父窗口尺寸（用于 overlay 计算）。
 */
export function getParentSize(): ParentSize {
  if (typeof window === 'undefined') return { width: 1920, height: 1080 };
  return { width: window.innerWidth, height: window.innerHeight };
}
