import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptTemplate } from '../lib/electron-api';
import { settleHooks } from '../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ init: vi.fn(), save: vi.fn(), remove: vi.fn(), inject: vi.fn(), toast: vi.fn(), prompts: [] as PromptTemplate[] }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../store/usePromptStore', () => ({ usePromptStore: (select: (value: unknown) => unknown) => select({ init: state.init, save: state.save, remove: state.remove, prompts: state.prompts }) }));
vi.mock('../lib/electron-api', () => ({ requestPromptInject: state.inject, onPromptInjectResult: () => () => {}, exportPrompts: vi.fn(), importPrompts: vi.fn() }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ toast: null, showToast: state.toast }) }));
vi.mock('../hooks/useEscToCloseWindow', () => ({ useEscToCloseOverlay: vi.fn() }));
vi.mock('../components/WindowResizeHandles', () => ({ default: 'resize-handles' }));
vi.mock('../components/StandaloneWindowHeader', () => ({ default: 'window-header' }));
vi.mock('../components/ui', () => ({ Button: 'button', IconButton: 'icon-button', EmptyState: 'empty-state', ConfirmDialog: 'confirm-dialog' }));
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
function byName(view: { current: unknown }, name: string) { return nodes(view.current).find(node => node.props?.['data-name'] === name)!; }
function card(view: { current: unknown }, id: string) { return nodes(view.current).find(node => node.type === 'article' && node.props['data-id'] === id)!; }
function cardCommand(view: { current: unknown }, id: string, commandName: string) { return nodes(card(view, id)).find(node => node.props?.['data-name']?.endsWith(`-${commandName}-button`))!; }
async function confirmDelete(view: { current: unknown }) { command(view, 'delete'); await settleHooks(); const dialog = nodes(view.current).find(node => node.type === 'confirm-dialog')!; expect(dialog.props.open).toBe(true); await dialog.props.onConfirm(); await settleHooks(); }
async function mountEditor() {
  const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
  nodes(view.current).find(node => node.props?.['data-name']?.endsWith('-edit-button'))!.props.onClick({ currentTarget: { focus: vi.fn() } }); await settleHooks();
  return view;
}
beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.prompts = [template];
  state.init.mockResolvedValue(undefined); state.save.mockResolvedValue(template); state.remove.mockResolvedValue(undefined);
  state.inject.mockResolvedValue(undefined);
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
    const view = await mountEditor(); await confirmDelete(view);
    expect(opened(view)).toBe(true); expect(editor(view).content).toBe(template.content);
    expect(state.toast).toHaveBeenLastCalledWith(expect.stringMatching(/删除失败/));
    expect(state.toast).not.toHaveBeenCalledWith('已删除');
    await confirmDelete(view);
    expect(state.remove).toHaveBeenCalledTimes(2); expect(opened(view)).toBe(false); expect(state.toast).toHaveBeenLastCalledWith('已删除');
  });
});

describe('optional prompt faces', () => {
  const example = { content: 'Example snapshot', conversationId: 'conversation-a', messageId: 'message-a' };
  const dual = { ...template, example };
  const caseOnly = { ...template, id: 'case-only', title: 'Case only', content: '', example };

  it('keeps use separate from flipping and always sends the general template', async () => {
    state.prompts = [dual];
    const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
    expect(card(view, dual.id).props['data-face']).toBe('example');
    cardCommand(view, dual.id, 'flip').props.onClick(); await settleHooks();
    expect(card(view, dual.id).props['data-face']).toBe('general');
    cardCommand(view, dual.id, 'flip').props.onClick(); await settleHooks();
    expect(card(view, dual.id).props['data-face']).toBe('example'); expect(state.inject).not.toHaveBeenCalled();
    await cardCommand(view, dual.id, 'use').props.onClick(); await settleHooks();
    expect(state.inject).toHaveBeenCalledWith(dual);
    expect(nodes(card(view, dual.id)).filter(node => node.type === 'button')).toHaveLength(1);
  });

  it('shows single faces without a flip control and refuses a case-only use handler', async () => {
    state.prompts = [template, caseOnly];
    const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
    expect(cardCommand(view, template.id, 'flip')).toBeUndefined(); expect(cardCommand(view, caseOnly.id, 'flip')).toBeUndefined();
    expect(card(view, caseOnly.id).props['data-face']).toBe('example');
    expect(cardCommand(view, caseOnly.id, 'use').props.disabled).toBe(true);
    await cardCommand(view, caseOnly.id, 'use').props.onClick(); await settleHooks();
    expect(state.inject).not.toHaveBeenCalled(); expect(state.toast).toHaveBeenCalledWith('请先编写通用提示词');
  });

  it('flips all stored dual templates through filtering and normalizes a mixed state to general', async () => {
    const hidden = { ...dual, id: 'hidden', title: 'Hidden' };
    state.prompts = [dual, hidden, caseOnly];
    let query = template.title;
    const view = harness.mount(() => PromptLibraryView({ embedded: true, query })); await settleHooks();
    byName(view, 'prompts.flip-all-button').props.onClick(); await settleHooks();
    expect(card(view, dual.id).props['data-face']).toBe('general'); expect(card(view, hidden.id)).toBeUndefined();
    query = ''; harness.mount(() => PromptLibraryView({ embedded: true, query })); await settleHooks();
    expect(card(view, hidden.id).props['data-face']).toBe('general');
    cardCommand(view, hidden.id, 'flip').props.onClick(); await settleHooks();
    expect(byName(view, 'prompts.flip-all-button').props['aria-label']).toBe('全部切到通用');
    byName(view, 'prompts.flip-all-button').props.onClick(); await settleHooks();
    expect(card(view, dual.id).props['data-face']).toBe('general'); expect(card(view, hidden.id).props['data-face']).toBe('general');
    expect(card(view, caseOnly.id).props['data-face']).toBe('example');
  });

  it('opens a case draft with empty general text and saves edited text with its original identities', async () => {
    const view = harness.mount(() => PromptLibraryView({ embedded: true, draft: { revision: 1, example, title: 'From message' } })); await settleHooks();
    expect(editor(view).content).toBe(''); expect(editor(view).example).toEqual(example);
    editor(view).onExampleContentChange('Edited example'); await settleHooks(); command(view, 'save'); await settleHooks();
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'From message', content: '', example: { ...example, content: 'Edited example' } }));
    expect(opened(view)).toBe(false);
  });

  it('retains example and metadata on a failed edit and restores focus after cancel', async () => {
    state.prompts = [dual]; state.save.mockRejectedValueOnce(new Error('Write failed'));
    const focus = vi.fn(); const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
    cardCommand(view, dual.id, 'edit').props.onClick({ currentTarget: { focus } }); await settleHooks();
    editor(view).onContentChange('Updated general'); editor(view).onExampleContentChange('Updated snapshot'); await settleHooks();
    command(view, 'save'); await settleHooks();
    expect(opened(view)).toBe(true); expect(editor(view).example).toEqual({ ...example, content: 'Updated snapshot' });
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ category: template.category, hotkey: template.hotkey, example: { ...example, content: 'Updated snapshot' } }));
    command(view, 'cancel'); await settleHooks(); expect(focus).toHaveBeenCalledOnce();
  });

  it('retains snapshots when their source is missing and enables exact identities for existing sources', async () => {
    state.prompts = [dual]; const openSource = vi.fn();
    const view = harness.mount(() => PromptLibraryView({ embedded: true, onOpenSource: openSource, sourceConversationIds: [] })); await settleHooks();
    expect(cardCommand(view, dual.id, 'source').props.disabled).toBe(true); expect(cardCommand(view, dual.id, 'source').props.title).toBe('原对话不可用');
    harness.mount(() => PromptLibraryView({ embedded: true, onOpenSource: openSource, sourceConversationIds: ['conversation-a'] })); await settleHooks();
    cardCommand(view, dual.id, 'source').props.onClick(); expect(openSource).toHaveBeenCalledWith(example);
  });

  it('requires at least one nonblank face and does not delete before confirmation', async () => {
    const view = await mountEditor(); editor(view).onContentChange('  '); editor(view).onExampleContentChange('  '); await settleHooks();
    command(view, 'save'); await settleHooks(); expect(state.save).not.toHaveBeenCalled();
    command(view, 'delete'); await settleHooks(); expect(state.remove).not.toHaveBeenCalled();
    nodes(view.current).find(node => node.type === 'confirm-dialog')!.props.onCancel(); await settleHooks(); expect(state.remove).not.toHaveBeenCalled(); expect(opened(view)).toBe(true);
  });

  it('supports imported categories matching object prototype names', async () => {
    state.prompts = [{ ...template, category: '__proto__' }, { ...template, id: 'constructor', category: 'constructor' }];
    const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
    expect(card(view, template.id)).toBeDefined(); expect(card(view, 'constructor')).toBeDefined();
  });

  it('flips valid imported template identifiers matching object prototype names', async () => {
    state.prompts = [{ ...dual, id: '__proto__', title: 'Prototype' }, { ...dual, id: 'constructor', title: 'Constructor' }];
    const view = harness.mount(() => PromptLibraryView({ embedded: true })); await settleHooks();
    expect(card(view, '__proto__').props['data-face']).toBe('example'); expect(card(view, 'constructor').props['data-face']).toBe('example');
    byName(view, 'prompts.flip-all-button').props.onClick(); await settleHooks();
    expect(card(view, '__proto__').props['data-face']).toBe('general'); expect(card(view, 'constructor').props['data-face']).toBe('general');
    cardCommand(view, '__proto__', 'flip').props.onClick(); await settleHooks();
    expect(card(view, '__proto__').props['data-face']).toBe('example'); expect(card(view, 'constructor').props['data-face']).toBe('general');
    expect(byName(view, 'prompts.flip-all-button').props['aria-label']).toBe('全部切到通用');
    byName(view, 'prompts.flip-all-button').props.onClick(); await settleHooks();
    expect(card(view, '__proto__').props['data-face']).toBe('general'); expect(card(view, 'constructor').props['data-face']).toBe('general');
    byName(view, 'prompts.flip-all-button').props.onClick(); await settleHooks();
    expect(card(view, '__proto__').props['data-face']).toBe('example'); expect(card(view, 'constructor').props['data-face']).toBe('example');
  });

  it('shows an initialization failure and permits retry without clearing search', async () => {
    state.init.mockRejectedValueOnce(new Error('Read failed'));
    const view = harness.mount(() => PromptLibraryView({ embedded: true, query: template.title })); await settleHooks();
    expect(byName(view, 'prompts.retry-load-button')).toBeDefined();
    await byName(view, 'prompts.retry-load-button').props.onClick(); await settleHooks();
    expect(state.init).toHaveBeenCalledTimes(2); expect(byName(view, 'prompts.retry-load-button')).toBeUndefined(); expect(card(view, template.id)).toBeDefined();
  });
});
