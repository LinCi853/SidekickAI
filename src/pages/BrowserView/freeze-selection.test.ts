import { describe, expect, it } from 'vitest';
import type { TextLayer, TextLayerGrapheme, TextLayerItem } from '../../lib/electron-api';
import {
  buildSelectedRuns,
  countGraphemes,
  flattenGraphemes,
  getLayerScale,
  isTextLayerSelectable,
  nearestAnchorBoundary,
  nearestBoundary,
  selectedText,
  selectGraphemes,
  toGuestPoint,
} from './freeze-selection';

function item(
  text: string,
  y: number,
  options: { x?: number; line?: number; breakBefore?: boolean; direction?: string } = {},
): TextLayerItem {
  const x = options.x ?? 0;
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text));
  let offset = 0;
  const graphemes: TextLayerGrapheme[] = segments.map(({ segment }, index) => {
    const start = offset;
    offset += segment.length;
    return {
      text: segment,
      start,
      end: offset,
      x: x + index * 10,
      y,
      w: 10,
      h: 20,
      line: options.line ?? 0,
    };
  });
  return {
    text,
    x,
    y,
    w: Math.max(10, graphemes.length * 10),
    h: 20,
    line: options.line ?? 0,
    breakBefore: options.breakBefore,
    direction: options.direction,
    graphemes,
  };
}

function layer(items: TextLayerItem[]): TextLayer {
  return {
    version: 2,
    coordinateSpace: 'guest-visual-viewport-css-px-v2',
    items,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    contentWidth: 400,
    contentHeight: 800,
    viewportWidth: 200,
    viewportHeight: 400,
    visualScale: 1,
    devicePixelRatio: 1,
    documentRevision: 0,
    nestedScrollRegions: [],
    quality: 'glyph',
    truncated: false,
  };
}

describe('freeze selection mapping', () => {
  it('maps host coordinates to guest CSS pixels', () => {
    const textLayer = layer([]);
    const position = { left: 40, top: 20, width: 400, height: 800 };
    expect(getLayerScale(textLayer, position)).toEqual({ x: 2, y: 2 });
    expect(toGuestPoint(140, 120, position, textLayer)).toEqual({ x: 50, y: 50 });
  });

  it('selects the same logical graphemes in both drag directions', () => {
    const textLayer = layer([item('abcdef', 10)]);
    const flat = flattenGraphemes(textLayer, 0, 0);
    const forward = selectGraphemes(flat, 2, 5);
    const reverse = selectGraphemes(flat, 5, 2);
    expect(selectedText(forward)).toBe('cde');
    expect(selectedText(reverse)).toBe('cde');
    expect(buildSelectedRuns(textLayer, forward)[0]).toMatchObject({ startX: 20, endX: 50 });
  });

  it('preserves soft wraps and inserts only semantic block breaks', () => {
    const textLayer = layer([
      item('soft', 10, { line: 0 }),
      item('wrap', 30, { line: 1 }),
      item('next', 60, { line: 2, breakBefore: true }),
    ]);
    const flat = flattenGraphemes(textLayer, 0, 0);
    expect(selectedText(flat)).toBe('softwrap\nnext');
  });

  it('keeps emoji and combining marks as single graphemes', () => {
    const text = 'A👨‍👩‍👧‍👦e\u0301🇨🇳Z';
    const textLayer = layer([item(text, 0)]);
    const flat = flattenGraphemes(textLayer, 0, 0);
    expect(flat.map((grapheme) => grapheme.text)).toEqual(['A', '👨‍👩‍👧‍👦', 'e\u0301', '🇨🇳', 'Z']);
    expect(countGraphemes(text)).toBe(5);
  });

  it('uses visual RTL positions for caret hit testing while preserving DOM order', () => {
    const rtlItem = item('אבג', 0, { direction: 'rtl' });
    rtlItem.graphemes = rtlItem.graphemes?.map((grapheme, index, all) => ({
      ...grapheme,
      x: (all.length - index - 1) * 10,
    }));
    const flat = flattenGraphemes(layer([rtlItem]), 0, 0);
    expect(nearestBoundary(flat, { x: 29, y: 10 })).toBe(0);
    expect(nearestBoundary(flat, { x: 1, y: 10 })).toBe(3);
    expect(selectedText(selectGraphemes(flat, 0, 3))).toBe('אבג');
  });

  it('exposes DOMSnapshot boxes to selection as whole items', () => {
    const fallback = item('fallback', 20);
    delete fallback.graphemes;
    const textLayer = layer([fallback]);
    textLayer.quality = 'domsnapshot';
    const flat = flattenGraphemes(textLayer, 5, 10);
    // DOMSnapshot质量返回item级别选择（整个文本块作为一个单元）
    expect(flat.length).toBe(1);
    expect(flat[0].text).toBe('fallback');
    expect(flat[0].x).toBe(-5); // 0 - 5 offset
    expect(flat[0].w).toBe(fallback.w);
  });

  it('uses shared visual-line ids for DOMSnapshot caret hit testing', () => {
    const first = item('first', 20, { x: 0, line: 4 });
    const second = item('second', 20, { x: 70, line: 4 });
    delete first.graphemes;
    delete second.graphemes;
    const textLayer = layer([first, second]);
    textLayer.quality = 'domsnapshot';
    const flat = flattenGraphemes(textLayer, 0, 0);
    expect(nearestBoundary(flat, { x: 90, y: 25 })).toBe(1);
    expect(selectedText(selectGraphemes(flat, 0, 2))).toBe('firstsecond');
  });

  it('preserves fallback line breaks without splitting inline boxes', () => {
    const first = item('inline ', 20, { line: 1 });
    const second = item('fragment', 20, { x: 70, line: 1 });
    const next = item('next', 50, { line: 2, breakBefore: true });
    delete first.graphemes;
    delete second.graphemes;
    delete next.graphemes;
    const textLayer = layer([first, second, next]);
    textLayer.quality = 'domsnapshot';
    expect(selectedText(flattenGraphemes(textLayer, 0, 0))).toBe('inline fragment\nnext');
  });

  it('enables selection for glyph and domsnapshot quality', () => {
    const fallback = layer([item('fallback', 20)]);
    fallback.quality = 'domsnapshot';
    expect(isTextLayerSelectable(fallback)).toBe(true);
    fallback.quality = 'none';
    expect(isTextLayerSelectable(fallback)).toBe(false);
    fallback.quality = 'glyph';
    expect(isTextLayerSelectable(fallback)).toBe(true);
  });

  it('handles glyph runs without character boundaries as whole items', () => {
    const first = item('inline ', 20);
    const second = item('fragment', 20, { x: 70 });
    delete first.graphemes;
    delete second.graphemes;
    const flat = flattenGraphemes(layer([first, second]), 0, 0);
    // 没有graphemes时，每个item作为一个整体选择单元
    expect(flat.length).toBe(2);
    expect(flat[0].text).toBe('inline ');
    expect(flat[1].text).toBe('fragment');
  });

  it('keeps viewport-fixed text stationary during root scrolling', () => {
    const normal = item('normal', 100);
    const fixed = item('fixed', 10);
    fixed.viewportFixed = true;
    const flat = flattenGraphemes(layer([normal, fixed]), 0, 40);
    expect(flat[0].y).toBe(60);
    expect(flat[normal.graphemes!.length].y).toBe(10);
  });

  it('does not snap a selection anchor from unsupported distant content', () => {
    const flat = flattenGraphemes(layer([item('known', 10)]), 0, 0);
    expect(nearestAnchorBoundary(flat, { x: 200, y: 200 })).toBeNull();
    expect(nearestAnchorBoundary(flat, { x: 15, y: 15 })).not.toBeNull();
  });

  it('keeps transformed Range geometry while skipping vertical writing', () => {
    const transformed = item('translated', 10);
    const vertical = item('vertical', 30);
    transformed.transformed = true;
    vertical.verticalWriting = true;
    const textLayer = layer([transformed, vertical]);
    const flat = flattenGraphemes(textLayer, 0, 0);
    expect(flat.map((grapheme) => grapheme.text).join('')).toBe('translated');
    expect(buildSelectedRuns(textLayer, flat)).toEqual([{
      itemIndex: 0,
      startX: 0,
      endX: 100,
      y: 10,
      h: 20,
    }]);
  });
});
