import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookHarness, settleHooks } from '../hooks/draft-hook-test-harness';

const fixture = vi.hoisted(() => ({
  runtime: null as any,
  navigate: null as any,
  esc: null as any,
  modules: [] as any[],
  close: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (...args: any[]) => fixture.runtime.react.useRef(...args),
  useState: (...args: any[]) => fixture.runtime.react.useState(...args),
  useCallback: (...args: any[]) => fixture.runtime.react.useCallback(...args),
  useEffect: (...args: any[]) => fixture.runtime.react.useEffect(...args),
  useMemo: (factory: () => any, deps: any[]) => {
    const ref = fixture.runtime.react.useRef(null);
    if (!ref.current || deps.some((value, index) => value !== ref.current.deps[index])) ref.current = { value: factory(), deps };
    return ref.current.value;
  },
}));
vi.mock('../components/WindowResizeHandles', () => ({ default: 'resize-handles' }));
vi.mock('../store/useChatStore', () => ({ useChatStore: { getState: () => ({ setCurrentProvider: () => {} }) } }));
vi.mock('../store/useModuleStore', () => ({ useModuleStore: (selector: any) => selector({ modules: fixture.modules, initialized: true }) }));
vi.mock('../lib/electron-api', () => ({
  minimizeWindow: async () => {}, closeCurrentWindow: fixture.close,
  onAdvancedPanelNavigate: (callback: any) => { fixture.navigate = callback; return () => {}; },
  getAppSettings: async () => ({}), onAppSettingsChanged: () => () => {},
}));
vi.mock('../components/ui/Badge', () => ({ default: 'badge' }));
vi.mock('../components/ui', () => ({ Button: 'button', IconButton: 'button', SegmentedControl: 'tabs', TitleBar: 'title-bar', Combobox: 'combo-box' }));
vi.mock('../components/icons', () => ({ GearIcon: 'gear' }));
vi.mock('../components/AdvancedPanelSettingsPanel', () => ({ default: 'settings' }));
vi.mock('../components/SidebarShell', () => ({ default: 'sidebar' }));
vi.mock('./MessageBubble', () => ({ MessageBubble: 'message' }));
vi.mock('./WhiteboardView', () => ({ default: 'whiteboard' }));
vi.mock('./NotesView', () => ({ default: 'notes' }));
vi.mock('../hooks/useWindowMaximizedAndPinned', () => ({ useWindowMaximizedAndPinned: () => ({}) }));
vi.mock('../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: (options: any) => { fixture.esc = options; } }));
vi.mock('../lib/shared-utils', () => ({ isTypingTarget: () => false }));
import AdvancedPanelView from './AdvancedPanelView';

function find(node: any, type: string): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, type);
    if (match) return match;
  }
  // TitleBar accepts its tab control in the center slot.
  return find(node.props?.center, type);
}

beforeEach(() => {
  fixture.modules = ['custom-chat', 'whiteboard', 'notes'].map(id => ({ id, enabled: true }));
  fixture.close.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  const harness = createHookHarness();
  harness.reset();
  Object.assign(window, { location: { search: '?tab=whiteboard' } });
  const render = () => { fixture.runtime = harness; return AdvancedPanelView(); };
  const view = harness.mount(render);
  await settleHooks();
  return { view, rerender: () => harness.mount(render) };
}

function key(key: string, modifiers: Record<string, boolean>) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...modifiers });
  window.dispatchEvent(event);
}

describe('advanced panel draft consumer', () => {
  it.each(['tabs', 'ipc', 'keyboard', 'close', 'escape', 'ctrl-w', 'module'])(
    'keeps the mounted whiteboard when its guard refuses %s navigation', async (source) => {
      const mounted = await mount();
      const guard = vi.fn().mockResolvedValue(undefined); // A refused flush never calls commit.
      find(mounted.view.current, 'whiteboard').props.onBeforeLeaveReady(guard);
      if (source === 'tabs') find(mounted.view.current, 'tabs').props.onChange('notes');
      if (source === 'ipc') fixture.navigate({ tab: 'notes' });
      if (source === 'keyboard') key('3', { ctrlKey: true });
      if (source === 'close') find(mounted.view.current, 'title-bar').props.onClose();
      if (source === 'escape') fixture.esc.onEsc({ preventDefault() {} });
      if (source === 'ctrl-w') key('w', { ctrlKey: true });
      if (source === 'module') {
        fixture.modules = fixture.modules.map(module => ({ ...module, enabled: module.id !== 'whiteboard' }));
        mounted.rerender();
      }
      await settleHooks();
      expect(guard).toHaveBeenCalledOnce();
      expect(find(mounted.view.current, 'whiteboard')).not.toBeNull();
      expect(fixture.close).not.toHaveBeenCalled();
    },
  );

  it('commits the requested tab only after its registered guard permits it', async () => {
    const mounted = await mount();
    let commit: (() => void) | undefined;
    find(mounted.view.current, 'whiteboard').props.onBeforeLeaveReady(async (next: () => void) => { commit = next; });
    find(mounted.view.current, 'tabs').props.onChange('notes');
    await settleHooks();
    expect(find(mounted.view.current, 'whiteboard')).not.toBeNull();
    commit?.();
    await settleHooks();
    expect(find(mounted.view.current, 'whiteboard')).toBeNull();
    expect(find(mounted.view.current, 'notes')?.props.onBeforeLeaveReady).toBeTypeOf('function');
  });
});
