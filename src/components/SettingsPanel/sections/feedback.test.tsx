import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from '../../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../../hooks/draft-hook-test-harness');
  return createHookHarness();
});
const api = vi.hoisted(() => ({
  updateAppSettings: vi.fn(), clearUsageTraces: vi.fn(), cleanCache: vi.fn(),
  estimateCacheSize: vi.fn(), selectDownloadDir: vi.fn(), openDownloadDir: vi.fn(),
}));
vi.mock('react', () => harness.react);
vi.mock('../../../lib/electron-api', () => api);
vi.mock('../../../hooks/useSettingsData', () => ({
  useSettingsDraft: () => ({ draft: {}, setDraft: vi.fn() }),
}));
vi.mock('../../ui/SegmentedControl', () => ({ default: 'segmented-control' }));
vi.mock('../../ui/Toggle', () => ({ default: 'toggle' }));
vi.mock('../../ui', () => ({ SectionTitle: 'section-title', FormRow: 'form-row' }));
import GeneralSection from './GeneralSection';
import CookieSection from './CookieSection';
import StorageSection from './StorageSection';

function find(node: any, name: string): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.['data-name'] === name) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, name);
    if (match) return match;
  }
}
const consumers = [
  { name: 'general', duration: 3000, render: () => GeneralSection({
    general: { usageTrackingEnabled: true } as any, onChange: vi.fn(),
  }), button: 'settings.general.usage-clear-button', feedback: 'settings.general.usage-clear-feedback',
    success: '\u5df2\u6e05\u9664 2 \u6761\u8bb0\u5f55', failure: '\u6e05\u9664\u5931\u8d25',
    fail: () => api.clearUsageTraces.mockResolvedValue({ ok: false }),
  },
  { name: 'cookie', duration: 2500, render: CookieSection,
    button: 'settings.cookie.whitelist-add-button', feedback: 'settings.cookie.feedback',
    success: '\u5df2\u6dfb\u52a0 example.com', failure: '\u4fdd\u5b58\u5931\u8d25',
    fail: () => api.updateAppSettings.mockRejectedValue(new Error('Unavailable')),
  },
  { name: 'storage', duration: 3000, render: StorageSection,
    button: 'settings.storage.clean-button', feedback: 'settings.storage.clean-feedback',
    success: '\u5df2\u6e05\u7406 1.0 KB', failure: '\u6e05\u7406\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7',
    fail: () => api.cleanCache.mockRejectedValue(new Error('Unavailable')),
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  harness.reset();
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.updateAppSettings.mockResolvedValue({});
  api.clearUsageTraces.mockResolvedValue({ ok: true, count: 2 });
  api.cleanCache.mockResolvedValue({ cleanedBytes: 1024 });
  api.estimateCacheSize.mockResolvedValue(1024);
});
afterEach(() => {
  harness.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function act(consumer: typeof consumers[number], view: { current: any }) {
  if (consumer.name === 'cookie') {
    find(view.current, 'settings.cookie.whitelist-input').props.onChange({ target: { value: 'example.com' } });
    await settleHooks();
  }
  await find(view.current, consumer.button).props.onClick();
  await settleHooks();
}

describe.each(consumers)('$name feedback consumer', consumer => {
  it('shows its original success message for its configured duration', async () => {
    const view = harness.mount(consumer.render);
    await settleHooks();
    expect(find(view.current, consumer.feedback)).toBeUndefined();
    await act(consumer, view);
    expect(find(view.current, consumer.feedback).props.children).toBe(consumer.success);
    await vi.advanceTimersByTimeAsync(consumer.duration - 1);
    expect(find(view.current, consumer.feedback)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(find(view.current, consumer.feedback)).toBeUndefined();
  });
  it('preserves failure feedback and cancels its timer on unmount', async () => {
    consumer.fail();
    const view = harness.mount(consumer.render);
    await settleHooks();
    await act(consumer, view);
    expect(find(view.current, consumer.feedback).props.children).toBe(consumer.failure);
    expect(vi.getTimerCount()).toBe(1);
    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('clears previous cache feedback while a new clean operation is pending', async () => {
  const consumer = consumers[2];
  const view = harness.mount(consumer.render);
  await settleHooks();
  await act(consumer, view);
  const pending = deferred<{ cleanedBytes: number }>();
  api.cleanCache.mockReturnValue(pending.promise);
  find(view.current, consumer.button).props.onClick();
  await settleHooks();
  expect(find(view.current, consumer.feedback)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve({ cleanedBytes: 1024 });
  await settleHooks();
  expect(find(view.current, consumer.feedback).props.children).toBe(consumer.success);
  expect(vi.getTimerCount()).toBe(1);
});
