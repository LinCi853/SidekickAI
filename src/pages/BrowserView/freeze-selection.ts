import type { TextLayer, TextLayerItem } from '../../lib/electron-api';

export interface LayerPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GuestPoint {
  x: number;
  y: number;
}

export interface FlatGrapheme {
  order: number;
  itemIndex: number;
  graphemeIndex: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
  direction: string;
  breakBefore: boolean;
}

export interface SelectedRun {
  itemIndex: number;
  startX: number;
  endX: number;
  y: number;
  h: number;
}

export function getLayerScale(layer: TextLayer, layerPos: LayerPosition | null) {
  const scaleX = layerPos && layer.viewportWidth > 0 ? layerPos.width / layer.viewportWidth : 1;
  const scaleY = layerPos && layer.viewportHeight > 0 ? layerPos.height / layer.viewportHeight : 1;
  return {
    x: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
    y: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
  };
}

/** 文本层是否可选择：glyph 和 domsnapshot 质量都支持基本选择 */
export function isTextLayerSelectable(layer: TextLayer): boolean {
  return layer.quality === 'glyph' || layer.quality === 'domsnapshot';
}

/** 获取文本层质量级别，用于UI提示 */
export function getTextLayerQuality(layer: TextLayer): 'high' | 'medium' | 'none' {
  if (layer.quality === 'glyph') return 'high';
  if (layer.quality === 'domsnapshot') return 'medium';
  return 'none';
}

export function toGuestPoint(
  clientX: number,
  clientY: number,
  layerPos: LayerPosition,
  layer: TextLayer,
): GuestPoint {
  const scale = getLayerScale(layer, layerPos);
  return {
    x: (clientX - layerPos.left) / scale.x,
    y: (clientY - layerPos.top) / scale.y,
  };
}

/**
 * Grapheme data is emitted in DOM order. Keep that order for copying; visual
 * coordinates are only used to locate the nearest caret boundary.
 */
export function flattenGraphemes(layer: TextLayer, wheelX: number, wheelY: number): FlatGrapheme[] {
  if (!isTextLayerSelectable(layer)) return [];
  const flat: FlatGrapheme[] = [];
  const isGlyphQuality = layer.quality === 'glyph';

  layer.items.forEach((item, itemIndex) => {
    // Range client rects are already in post-transform viewport coordinates.
    // Only vertical writing needs a different caret-axis algorithm.
    if (item.verticalWriting) return;
    const offsetX = item.viewportFixed ? 0 : wheelX;
    const offsetY = item.viewportFixed ? 0 : wheelY;

    if (isGlyphQuality && item.graphemes && item.graphemes.length > 0) {
      // Glyph质量：使用精确的grapheme数据
      item.graphemes.forEach((grapheme, graphemeIndex) => {
        if (!grapheme.text || grapheme.w <= 0 || grapheme.h <= 0) return;
        flat.push({
          order: flat.length,
          itemIndex,
          graphemeIndex,
          text: grapheme.text,
          x: grapheme.x - offsetX,
          y: grapheme.y - offsetY,
          w: grapheme.w,
          h: grapheme.h,
          line: grapheme.line,
          direction: item.direction || 'ltr',
          breakBefore: graphemeIndex === 0 && Boolean(item.breakBefore),
        });
      });
    } else if (item.text && item.w > 0 && item.h > 0) {
      // DOMSnapshot质量：将整个item文本作为一个可选择的文本块
      // 坐标已由主进程正确计算（quad解析），直接使用
      flat.push({
        order: flat.length,
        itemIndex,
        graphemeIndex: 0,
        text: item.text,
        x: item.x - offsetX,
        y: item.y - offsetY,
        w: item.w,
        h: item.h,
        line: item.line,
        direction: item.direction || 'ltr',
        breakBefore: Boolean(item.breakBefore),
      });
    }
  });
  return flat;
}

function verticalDistance(grapheme: FlatGrapheme, point: GuestPoint): number {
  if (point.y < grapheme.y) return grapheme.y - point.y;
  if (point.y > grapheme.y + grapheme.h) return point.y - (grapheme.y + grapheme.h);
  return 0;
}

/** Return a logical boundary before or after the visually nearest grapheme. */
export function nearestBoundary(flat: FlatGrapheme[], point: GuestPoint): number {
  if (!flat.length) return 0;
  let nearest = flat[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const grapheme of flat) {
    const distance = verticalDistance(grapheme, point) * 4
      + Math.abs(point.x - (grapheme.x + grapheme.w / 2));
    if (distance < nearestDistance) {
      nearest = grapheme;
      nearestDistance = distance;
    }
  }

  const line = flat.filter((grapheme) => grapheme.line === nearest.line);
  const visualLine = line.length ? line : [nearest];
  visualLine.sort((a, b) => a.x - b.x || a.order - b.order);

  if (point.x <= visualLine[0].x) {
    const first = visualLine[0];
    return first.direction === 'rtl' ? first.order + 1 : first.order;
  }
  for (const grapheme of visualLine) {
    if (point.x < grapheme.x + grapheme.w / 2) {
      return grapheme.direction === 'rtl' ? grapheme.order + 1 : grapheme.order;
    }
  }
  const last = visualLine[visualLine.length - 1];
  return last.direction === 'rtl' ? last.order : last.order + 1;
}

/** Selection must start near extracted text; omitted iframe/canvas text must not snap elsewhere. */
export function nearestAnchorBoundary(flat: FlatGrapheme[], point: GuestPoint): number | null {
  if (!flat.length) return null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest: FlatGrapheme | undefined;
  for (const grapheme of flat) {
    const dx = point.x < grapheme.x
      ? grapheme.x - point.x
      : point.x > grapheme.x + grapheme.w
        ? point.x - (grapheme.x + grapheme.w)
        : 0;
    const dy = verticalDistance(grapheme, point);
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = grapheme;
    }
  }
  if (!nearest || nearestDistance > Math.max(12, nearest.h * 0.75)) return null;
  return nearestBoundary(flat, point);
}

export function selectGraphemes(flat: FlatGrapheme[], anchor: number, focus: number): FlatGrapheme[] {
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return flat.filter((grapheme) => grapheme.order >= start && grapheme.order < end);
}

export function buildSelectedRuns(layer: TextLayer, selected: FlatGrapheme[]): SelectedRun[] {
  const byItem = new Map<number, FlatGrapheme[]>();
  for (const grapheme of selected) {
    const list = byItem.get(grapheme.itemIndex) || [];
    list.push(grapheme);
    byItem.set(grapheme.itemIndex, list);
  }
  const runs: SelectedRun[] = [];
  for (const [itemIndex, graphemes] of byItem) {
    const item = layer.items[itemIndex];
    if (!item || !graphemes.length) continue;
    const visual = [...graphemes].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const grapheme of visual) {
      const current = runs[runs.length - 1];
      const sameVisualRun = current?.itemIndex === itemIndex
        && Math.abs(current.y - grapheme.y) <= 1
        && grapheme.x <= current.endX + 1;
      if (sameVisualRun) {
        current.startX = Math.min(current.startX, grapheme.x);
        current.endX = Math.max(current.endX, grapheme.x + grapheme.w);
        current.y = Math.min(current.y, grapheme.y);
        current.h = Math.max(current.h, grapheme.h);
      } else {
        runs.push({
          itemIndex,
          startX: grapheme.x,
          endX: grapheme.x + grapheme.w,
          y: grapheme.y,
          h: grapheme.h,
        });
      }
    }
  }
  return runs;
}

export function selectedText(selected: FlatGrapheme[]): string {
  let result = '';
  let previous: FlatGrapheme | undefined;
  for (const grapheme of selected) {
    if (previous && grapheme.breakBefore) {
      result += '\n';
    }
    result += grapheme.text;
    previous = grapheme;
  }
  return result;
}

export function countGraphemes(text: string): number {
  try {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;
  } catch {
    return Array.from(text).length;
  }
}
