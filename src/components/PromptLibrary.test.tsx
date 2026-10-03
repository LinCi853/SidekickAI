import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptTemplate } from '../lib/electron-api';
import { settleHooks } from '../hooks/draft-hook-test-harness';
const harness = await vi.hoisted(async () => (await import('../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ prompts: [] as PromptTemplate[], collapse: vi.fn(), manage: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../store/usePromptStore', () => ({ usePromptStore: (selector: (value: unknown) => unknown) => selector({ prompts: state.prompts }) }));
vi.mock('../store/useTabStore', () => ({ useTabStore: { getState: () => ({ setBottomBarExpanded: state.collapse }) } }));
vi.mock('../lib/electron-api', () => ({ openPromptWindow: state.manage }));
vi.mock('./ui/Button', () => ({ default: 'button' }));
import PromptLibrary from './PromptLibrary';
function nodes(value: any): any[] { return !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]; }
beforeEach(() => { harness.reset(); vi.resetAllMocks(); });
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); });
describe('quick prompt use', () => {
  it('disables example-only templates and rejects stale calls while preserving general content', async () => {
    const exampleOnly: PromptTemplate = { id: 'example', title: 'Example', content: '', example: { content: 'Private snapshot' }, createdAt: 1, updatedAt: 1 };
    const general = { ...exampleOnly, id: 'general', content: 'Use this general text' };
    state.prompts = [exampleOnly, general]; const inject = vi.fn().mockResolvedValue({ success: true });
    const view = harness.mount(() => PromptLibrary({ onInject: inject })); await settleHooks();
    let chips = nodes(view.current).filter(node => node.props?.['data-name']?.match(/chip-\d+$/));
    expect(chips[0].props.disabled).toBe(true); await chips[0].props.onClick(); await settleHooks(); expect(inject).not.toHaveBeenCalled();
    chips = nodes(view.current).filter(node => node.props?.['data-name']?.match(/chip-\d+$/));
    await chips[1].props.onClick(); await settleHooks(); expect(inject).toHaveBeenCalledWith(general); expect(state.collapse).toHaveBeenCalledWith(false);
  });
});
