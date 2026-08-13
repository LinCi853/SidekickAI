import { describe, expect, it } from 'vitest';
import type { TextLayer, TextLayerGrapheme, TextLayerItem } from '../../lib/electron-api';
import {
  buildSelectedRuns,
  countGraphemes,
  flattenGraphemes,
  getLayerScale,
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

  it('allows coarse whole-run selection for DOMSnapshot fallback', () => {
    const fallback = item('fallback', 20);
    delete fallback.graphemes;
    const flat = flattenGraphemes(layer([fallback]), 5, 10);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ text: 'fallback', x: -5, y: 10, fallback: true });
    expect(selectedText(selectGraphemes(flat, 0, 1))).toBe('fallback');
  });

  it('does not invent line breaks between adjacent fallback boxes', () => {
    const first = item('inline ', 20);
    const second = item('fragment', 20, { x: 70 });
    delete first.graphemes;
    delete second.graphemes;
    const flat = flattenGraphemes(layer([first, second]), 0, 0);
    expect(selectedText(flat)).toBe('inline fragment');
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

  it('omits transformed and vertical-writing runs instead of mis-mapping them', () => {
    const transformed = item('rotated', 10);
    const vertical = item('vertical', 30);
    transformed.transformed = true;
    vertical.verticalWriting = true;
    expect(flattenGraphemes(layer([transformed, vertical]), 0, 0)).toEqual([]);
  });
});
