import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../lib/electron-api';
import type { AssetConversationGraph } from '../../../electron/shared/ai-assets.types';
import { DEFAULT_ASSET_SETTINGS } from '../../../electron/shared/asset-settings';
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../../hooks/draft-hook-test-harness')).createHookHarness());
const api = vi.hoisted(() => ({ graph: vi.fn(), details: vi.fn(), usage: vi.fn(), selectBranch: vi.fn(), deleteMessage: vi.fn(), deleteConversation: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../lib/electron-api/core', () => ({ requireElectron: () => ({ aiAssets: api }) }));
vi.mock('../../lib/electron-api', () => ({ exportConversation: vi.fn(), updateMessage: vi.fn(), openExternal: vi.fn() }));
vi.mock('../../components/ui', () => ({ Button: 'button', IconButton: 'button', EmptyState: 'empty-state' }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ default: 'confirm-dialog' }));
vi.mock('./AssetFileCard', () => ({ default: 'asset-file' }));
vi.mock('./AssetMarkdown', () => ({ default: 'asset-markdown' }));
import AssetConversation from './AssetConversation';

function graph(id: string, suffix = ''): AssetConversationGraph {
  return { nodes: [
    { id: `${id}-message`, conversationId: id, sourceKey: `${id}-message`, versionKey: '', role: 'user', content: `${id} text${suffix}`, createdAt: 1, branchIndex: 1, branchCount: 2, locallyEdited: false },
    { id: `${id}-alternative`, conversationId: id, sourceKey: `${id}-alternative`, versionKey: '', role: 'user', content: `${id} alternative`, createdAt: 1, branchIndex: 2, branchCount: 2, locallyEdited: false },
  ], path: [`${id}-message`], sourcePath: [`${id}-message`] };
}
const conversation = (id: string): Conversation => ({ id, title: id, sourceId: 'source', sourceType: 'webview', createdAt: 1, updatedAt: 1 });
let key: string | null | undefined;
let jobs: Promise<void>[];
const refresh = vi.fn();
const prompt = vi.fn();
function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function mount(id: string, revision = 0, extra: Partial<Parameters<typeof AssetConversation>[0]> = {}) {
  const props = { conversation: conversation(id), revision, attachments: [], settings: DEFAULT_ASSET_SETTINGS,
    onAction: (operation: () => Promise<void>) => { jobs.push(operation()); }, onRefresh: refresh, onPrompt: prompt, onConversation: () => {}, ...extra };
  const outer = harness.mount(() => AssetConversation(props));
  const element = outer.current as ReactElement<any>;
  if (typeof element.type !== 'function') return outer;
  // Model keyed reconciliation; actual React behavior is checked by the browser fixture.
  if (key !== element.key) { harness.unmount(); harness.reset(); key = element.key; }
  return harness.mount(() => (element.type as (props: unknown) => ReactElement)(props));
}
function messages(view: { current: unknown }) { return nodes(view.current).filter(node => node.props?.['data-name'] === 'assets.message'); }
function nextBranch(view: { current: unknown }) { nodes(view.current).find(node => node.props?.['aria-label'] === '下一个分支')!.props.onClick(); }

beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); key = undefined; jobs = [];
  api.graph.mockImplementation(async id => graph(id)); api.details.mockResolvedValue([]); api.usage.mockResolvedValue(undefined);
  api.selectBranch.mockImplementation(async id => ({ ...graph(id), path: [`${id}-alternative`] })); refresh.mockResolvedValue(undefined); prompt.mockResolvedValue(undefined);
});
afterEach(async () => { harness.unmount(); await settleHooks(); vi.unstubAllGlobals(); });

describe('asset conversation operation ownership', () => {
  it('does not expose message or conversation operations while initially loading', async () => {
    const pending = deferred<AssetConversationGraph>(); api.graph.mockReturnValueOnce(pending.promise);
    const view = mount('A');
    expect(messages(view)).toEqual([]);
    expect(nodes(view.current).some(node => node.props?.children === '删除对话')).toBe(false);
    pending.resolve(graph('A')); await settleHooks(); expect(messages(view)).toHaveLength(1);
  });

  it('removes old messages and confirmation immediately when switching conversations', async () => {
    let view = mount('A'); await settleHooks();
    nodes(view.current).find(node => node.props?.['aria-label'] === '删除消息')!.props.onClick(); await settleHooks();
    expect(nodes(view.current).find(node => node.type === 'confirm-dialog')?.props.open).toBe(true);
    const pending = deferred<AssetConversationGraph>(); api.graph.mockReturnValueOnce(pending.promise);
    view = mount('B');
    expect(messages(view)).toEqual([]);
    expect(nodes(view.current).find(node => node.type === 'confirm-dialog')?.props.open ?? false).toBe(false);
    pending.resolve(graph('B')); await settleHooks();
    expect(messages(view).map(node => node.props['data-id'])).toEqual(['B-message']);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps a failed new conversation free of old actionable messages', async () => {
    mount('A'); await settleHooks(); api.graph.mockRejectedValueOnce(new Error('B unavailable'));
    const view = mount('B'); await settleHooks();
    expect(messages(view)).toEqual([]);
    expect(nodes(view.current).some(node => typeof node.props?.children === 'string' && node.props.children.includes('B unavailable'))).toBe(true);
    expect(nodes(view.current).some(node => node.props?.children === '删除对话')).toBe(false);
  });

  it('rejects a branch result from a previously selected conversation', async () => {
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    const a = mount('A'); await settleHooks(); nextBranch(a);
    const b = mount('B'); await settleHooks(); pending.resolve({ ...graph('A'), path: ['A-alternative'] });
    await Promise.all(jobs); await settleHooks();
    expect(messages(b).map(node => node.props['data-id'])).toEqual(['B-message']);
  });

  it('consumes a late old branch failure without reporting it into another conversation', async () => {
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    const a = mount('A'); await settleHooks(); nextBranch(a); const b = mount('B'); await settleHooks();
    pending.reject(new Error('A branch unavailable'));
    expect((await Promise.allSettled(jobs)).map(result => result.status)).toEqual(['fulfilled']); await settleHooks();
    expect(messages(b).map(node => node.props['data-id'])).toEqual(['B-message']);
    expect(nodes(b.current).some(node => node.props?.role === 'alert')).toBe(false);
  });

  it('does not let an old branch overwrite a newer refresh of the same conversation', async () => {
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    const first = mount('A'); await settleHooks(); nextBranch(first);
    api.graph.mockResolvedValueOnce(graph('A', ' refreshed')); const current = mount('A', 1); await settleHooks();
    pending.resolve({ ...graph('A'), path: ['A-alternative'] }); await Promise.all(jobs); await settleHooks();
    const rendered = nodes(current.current).find(node => node.type === 'asset-markdown')!;
    expect(rendered.props.content).toBe('A text refreshed');
  });

  it('reports a current branch failure and preserves its conversation content', async () => {
    api.selectBranch.mockRejectedValueOnce(new Error('Branch unavailable'));
    const view = mount('A'); await settleHooks(); nextBranch(view);
    expect((await Promise.allSettled(jobs)).map(result => result.status)).toEqual(['fulfilled']); await settleHooks();
    expect(messages(view).map(node => node.props['data-id'])).toEqual(['A-message']);
    expect(nodes(view.current).some(node => typeof node.props?.children === 'string' && node.props.children.includes('Branch unavailable'))).toBe(true);
  });
});

describe('asset source navigation and prompt examples', () => {
  it('passes an exact message identity with its prompt example', async () => {
    const view = mount('A'); await settleHooks();
    nodes(view.current).find(node => node.props?.['aria-label'] === '存为提示词')!.props.onClick();
    await Promise.all(jobs);
    expect(prompt).toHaveBeenCalledWith('A text', { conversationId: 'A', messageId: 'A-message' });
  });

  it.each([['A-message', 'A-message', 'A-message'], ['A-message', 'A-alternative', undefined]])('associates a text selection with the appropriate source: %s / %s', async (anchorId, focusId, messageId) => {
    const view = mount('A'); await settleHooks();
    const scroll = nodes(view.current).find(node => node.props?.className === 'asset-chat-scroll')!;
    scroll.ref.current = { contains: () => true };
    const endpoint = (id: string) => ({ nodeType: 3, parentElement: { closest: () => ({ dataset: { id } }) } });
    vi.stubGlobal('Node', { ELEMENT_NODE: 1 });
    Object.assign(window, { getSelection: () => ({ anchorNode: endpoint(anchorId), focusNode: endpoint(focusId), toString: () => 'Selected text' }) });
    scroll.props.onMouseUp({ target: { closest: () => null } }); await settleHooks();
    nodes(view.current).find(node => node.props?.['aria-label'] === '选中内容存为提示词')!.props.onClick();
    await Promise.all(jobs);
    expect(prompt).toHaveBeenCalledWith('Selected text', { conversationId: 'A', messageId });
  });

  it('switches to a collected source branch before scrolling to its message', async () => {
    const view = mount('A'); await settleHooks();
    const scroll = nodes(view.current).find(node => node.props?.className === 'asset-chat-scroll')!;
    const element = { dataset: { id: 'A-alternative' }, closest: () => null, scrollIntoView: vi.fn() };
    scroll.ref.current = { querySelectorAll: () => [element] };
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    const target = { revision: 1, messageId: 'A-alternative' };
    const current = mount('A', 0, { target }); await settleHooks();
    expect(api.selectBranch).toHaveBeenCalledWith('A', 'A-alternative');
    expect(element.scrollIntoView).not.toHaveBeenCalled();
    pending.resolve({ ...graph('A'), path: ['A-alternative'] }); await settleHooks();
    expect(messages(current).map(node => node.props['data-id'])).toEqual(['A-alternative']);
    expect(element.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('keeps the conversation available when the source message is gone', async () => {
    const view = mount('A', 0, { target: { revision: 1, messageId: 'deleted-message' } }); await settleHooks();
    expect(messages(view).map(node => node.props['data-id'])).toEqual(['A-message']);
    expect(api.selectBranch).not.toHaveBeenCalled();
    expect(nodes(view.current).some(node => node.props?.role === 'status' && node.props.children.includes('原消息已不可用'))).toBe(true);
  });

  it('ignores source branch completion after changing conversations', async () => {
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    mount('A', 0, { target: { revision: 1, messageId: 'A-alternative' } }); await settleHooks();
    const current = mount('B'); await settleHooks();
    pending.resolve({ ...graph('A'), path: ['A-alternative'] }); await settleHooks();
    expect(messages(current).map(node => node.props['data-id'])).toEqual(['B-message']);
  });

  it('retries source navigation when a refresh supersedes its pending branch request', async () => {
    const pending = deferred<AssetConversationGraph>(); api.selectBranch.mockReturnValueOnce(pending.promise);
    const target = { revision: 1, messageId: 'A-alternative' };
    mount('A', 0, { target }); await settleHooks();
    const current = mount('A', 1, { target }); await settleHooks();
    pending.resolve({ ...graph('A'), path: ['A-message'] }); await settleHooks();
    expect(api.selectBranch).toHaveBeenCalledTimes(2);
    expect(messages(current).map(node => node.props['data-id'])).toEqual(['A-alternative']);
  });
});
