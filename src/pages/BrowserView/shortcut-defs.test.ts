/* =====================================================================
   快捷键 defs 对账测试：
   1. 每个 def 的 accelerator 都能被 parseAccelerator 正确解析出主键
   2. 用模拟 KeyboardEvent 验证 matchAccelerator 对真实按键字段的匹配
   3. defs 表的 action 与主进程转发约定一致（无重复歧义的关键 action）
   ===================================================================== */

import { describe, it, expect } from 'vitest';
import { parseAccelerator, matchAccelerator, type ShortcutEntry } from '../../hooks/useShortcutRegistry';
import { buildShortcutDefs } from './useBrowserKeyboard';

/** 构造模拟 KeyboardEvent（仅匹配所需字段） */
function fakeEvent(key: string, opts: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; repeat?: boolean } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
    metaKey: opts.meta ?? false,
    repeat: opts.repeat ?? false,
  } as KeyboardEvent;
}

const noop = () => {};
const baseOpts = {
  onFocusAddressBar: noop,
  onRefresh: noop,
  onForceRefresh: noop,
  onGoBack: noop,
  onGoForward: noop,
  onStopLoading: noop,
  onMaximize: noop,
  onToggleDevTools: noop,
};

describe('快捷键 defs 表', () => {
  const defs = buildShortcutDefs(baseOpts);

  it('全部 accelerator 均可解析出主键', () => {
    for (const def of defs) {
      const parsed = parseAccelerator(def.accelerator);
      expect(parsed.key, def.accelerator).not.toBe('');
    }
  });

  it('defs 数量符合预期（≥40 条）', () => {
    expect(defs.length).toBeGreaterThanOrEqual(40);
  });

  it('关键快捷键的 accelerator 匹配真实按键事件', () => {
    const cases: Array<[string, KeyboardEvent, boolean]> = [
      ['Ctrl+D', fakeEvent('d', { ctrl: true }), true],
      ['Ctrl+U', fakeEvent('u', { ctrl: true }), true],
      ['Ctrl+Alt+C', fakeEvent('c', { ctrl: true, alt: true }), true],
      ['Alt+P', fakeEvent('p', { alt: true }), true],
      ['F11', fakeEvent('F11'), true],
      ['F12', fakeEvent('F12'), true],
      ['Ctrl+P', fakeEvent('p', { ctrl: true }), true],
      ['Ctrl+S', fakeEvent('s', { ctrl: true }), true],
      ['Ctrl+F', fakeEvent('f', { ctrl: true }), true],
      ['Ctrl+Shift+Delete', fakeEvent('Delete', { ctrl: true, shift: true }), true],
      ['Ctrl+0', fakeEvent('0', { ctrl: true }), true],
      ['Ctrl+=', fakeEvent('=', { ctrl: true }), true],
      ['Ctrl+-', fakeEvent('-', { ctrl: true }), true],
      ['Ctrl+Tab', fakeEvent('Tab', { ctrl: true }), true],
      ['Ctrl+Shift+Tab', fakeEvent('Tab', { ctrl: true, shift: true }), true],
      ['Alt+ArrowLeft', fakeEvent('ArrowLeft', { alt: true }), true],
      ['Alt+1', fakeEvent('1', { alt: true }), true],
      ['Escape', fakeEvent('Escape'), true],
      ['Ctrl+T', fakeEvent('t', { ctrl: true }), true],
      ['Ctrl+W', fakeEvent('w', { ctrl: true }), true],
      ['Ctrl+Shift+T', fakeEvent('t', { ctrl: true, shift: true }), true],
      // 负例：修饰键不匹配不应命中
      ['Ctrl+D', fakeEvent('d'), false],
      ['Ctrl+Alt+C', fakeEvent('c', { ctrl: true }), false],
      ['F11', fakeEvent('F11', { shift: true }), false],
      ['Ctrl+T', fakeEvent('t', { ctrl: true, shift: true }), false],
    ];
    for (const [accelerator, event, expected] of cases) {
      const label = accelerator + " vs key=" + event.key;
      expect(matchAccelerator(event, accelerator), label).toBe(expected);
    }
  });

  it('关键 action 存在且与主进程转发约定一致', () => {
    const actions = new Set(defs.map((d) => d.action).filter(Boolean));
    for (const required of [
      'addBookmark', 'viewSource', 'toggleCloudPc', 'toggleFreeze',
      'print', 'savePageAs', 'findInPage', 'zoomIn', 'zoomOut', 'zoomReset',
      'navBack', 'navForward', 'navRefresh', 'forceRefresh', 'focusCycle',
      'closeTab', 'detachCurrent', 'cycleTab', 'switchTab', 'openHistory',
      'openDownloads', 'focusSearch', 'clearBrowsingData', 'reopenClosed',
      'toggleBookmarkBar', 'focusAddressBar',
    ]) {
      expect(actions.has(required), "缺少 action: " + required).toBe(true);
    }
  });
});

describe('通用组件长按（hold）能力类型', () => {
  it('ShortcutEntry 支持 holdMs / onHoldStart / onHoldEnd 声明', () => {
    // 编译期验证：以下声明若类型不支持将无法通过 typecheck
    const entry: ShortcutEntry = {
      accelerator: 'Tab',
      holdMs: 500,
      onHoldStart: () => {},
      onHoldEnd: () => {},
      handler: () => {},
    };
    expect(entry.holdMs).toBe(500);
  });
});
