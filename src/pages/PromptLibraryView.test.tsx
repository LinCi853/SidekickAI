import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptTemplate } from '../lib/electron-api';
import { settleHooks } from '../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ init: vi.fn(), save: vi.fn(), remove: vi.fn(), toast: vi.fn(), prompts: [] as PromptTemplate[] }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../store/usePromptStore', () => ({ usePromptStore: (select: (value: unknown) => unknown) => select({ init: state.init, save: state.save, remove: state.remove, prompts: state.prompts }) }));
vi.mock('../lib/electron-api', () => ({ requestPromptInject: vi.fn(), onPromptInjectResult: () => () => {}, exportPrompts: vi.fn(), importPrompts: vi.fn() }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ toast: null, showToast: state.toast }) }));
vi.mock('../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../components/WindowResizeHandles', () => ({ default: 'resize-handles' }));
vi.mock('../components/StandaloneWindowHeader', () => ({ default: 'window-header' }));
vi.mock('../components/ui', () => ({ Button: 'button', IconButton: 'icon-button', EmptyState: 'empty-state' }));
vi.mock('../components/PromptEditorForm', () => ({ default: 'prompt-form' }));
import PromptLibraryView from './PromptLibraryView';

const template: PromptTemplate = { id: 'template-a', title: 'Original title', content: 'Original text', category: 'Original category', hotkey: 'Ctrl+Shift+P', createdAt: 1, updatedAt: 1 };
function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function editor(view: { current: unknown }) { return nodes(view.current).find(node => node.type === 'prompt-form')!.props; }
function command(view: { current: unknown }, suffix: string) { return nodes(view.current).find(node => node.props?.['data-name'] === `prompts.editor-${suffix}-button`)!.props.onClick(); }
function opened(view: { current: unknown }) { return nodes(view.current).find(node => node.props?.['data-name'] === 'prompts.editor-overlay')!.props['aria-hidden'] === false; }
async function mountEditor() {
  const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
  nodes(view.current).find(node => node.props?.['data-name']?.endsWith('-edit-button'))!.props.onClick({ stopPropagation() {} }); await settleHooks();
  return view;
}
beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.prompts = [template];
  state.init.mockResolvedValue(undefined); state.save.mockResolvedValue(template); state.remove.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { harness.unmount(); await settleHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('prompt persistence failure feedback', () => {
  it('retains the edited fields and reports a failed save, then permits a direct retry', async () => {
    state.save.mockRejectedValueOnce(new Error('Persistence unavailable'));
    const view = await mountEditor();
    editor(view).onTitleChange('Edited title'); editor(view).onContentChange('Edited content'); await settleHooks();
    command(view, 'save'); await settleHooks();
    expect(opened(view)).toBe(true); expect(editor(view).title).toBe('Edited title'); expect(editor(view).content).toBe('Edited content');
    expect(state.toast).toHaveBeenLastCalledWith(expect.stringMatching(/保存失败/));
    expect(state.toast).not.toHaveBeenCalledWith('已更新');
    command(view, 'save'); await settleHooks();
    expect(state.save).toHaveBeenCalledTimes(2); expect(opened(view)).toBe(false); expect(state.toast).toHaveBeenLastCalledWith('已更新');
  });

  it('keeps the template and editor after a failed delete, then permits a direct retry', async () => {
    state.remove.mockRejectedValueOnce(new Error('Deletion unavailable'));
    const view = await mountEditor(); command(view, 'delete'); await settleHooks();
    expect(opened(view)).toBe(true); expect(editor(view).content).toBe(template.content);
    expect(state.toast).toHaveBeenLastCalledWith(expect.stringMatching(/删除失败/));
    expect(state.toast).not.toHaveBeenCalledWith('已删除');
    command(view, 'delete'); await settleHooks();
    expect(state.remove).toHaveBeenCalledTimes(2); expect(opened(view)).toBe(false); expect(state.toast).toHaveBeenLastCalledWith('已删除');
  });
});
