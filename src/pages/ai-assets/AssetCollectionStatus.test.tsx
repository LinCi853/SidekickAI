import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssetCollectionIssue } from '../../../electron/shared/ai-assets.types';
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ listener: undefined as undefined | ((issues: AssetCollectionIssue[]) => void), off: vi.fn() }));
const api = vi.hoisted(() => ({ collectionIssues: vi.fn(), focusPage: vi.fn(), onCollectionIssuesChanged: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../lib/electron-api/core', () => ({ requireElectron: () => ({ aiAssets: api }) }));
vi.mock('../../components/ui', () => ({ Button: 'button' }));
import AssetCollectionStatus from './AssetCollectionStatus';

const issue = { webContentsId: 5, profileId: 'account-a', profileName: 'Account A', failures: 1, updatedAt: 1 };
beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.listener = undefined;
  api.collectionIssues.mockResolvedValue([]);
  api.onCollectionIssuesChanged.mockImplementation(listener => { state.listener = listener; return state.off; });
});
afterEach(async () => { harness.unmount(); await settleHooks(); vi.unstubAllGlobals(); });
it('keeps a new failure visible when a stale initial read returns empty', async () => {
  const pending = deferred<AssetCollectionIssue[]>(); api.collectionIssues.mockReturnValueOnce(pending.promise);
  const view = harness.mount(() => AssetCollectionStatus({ onAction: () => {} }));
  state.listener!([issue]); pending.resolve([]); await settleHooks();
  expect(JSON.stringify(view.current)).toContain('Account A');
});
it('keeps a recovered source clear when an older failed snapshot arrives', async () => {
  const pending = deferred<AssetCollectionIssue[]>(); api.collectionIssues.mockReturnValueOnce(pending.promise);
  const view = harness.mount(() => AssetCollectionStatus({ onAction: () => {} }));
  state.listener!([]); pending.resolve([issue]); await settleHooks();
  expect(view.current).toBeNull();
});
it('reports an unreadable state and releases the event subscription on close', async () => {
  api.collectionIssues.mockRejectedValueOnce(new Error('Private filesystem path'));
  const view = harness.mount(() => AssetCollectionStatus({ onAction: () => {} })); await settleHooks();
  expect(JSON.stringify(view.current)).toContain('暂时无法读取收纳状态');
  expect(JSON.stringify(view.current)).not.toContain('Private filesystem');
  harness.unmount(); expect(state.off).toHaveBeenCalledTimes(1);
});
