import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Session, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sessions: new Map<string, EventEmitter>(), windows: new Map<object, object>(),
  ids: new Map<object, string>(), records: new Map<number, object>(), byProfile: new Map(),
  dialog: vi.fn(), add: vi.fn(), update: vi.fn(), serial: 0 }));
vi.mock('electron', () => ({
  session: { fromPartition: (partition: string) => state.sessions.get(partition) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: (host: object) => state.windows.get(host) },
  dialog: { showSaveDialogSync: state.dialog }, app: { getPath: () => 'E:/fixture' },
}));
vi.mock('crypto', () => ({ randomUUID: () => `download-${++state.serial}` }));
vi.mock('../store/app-settings-repository.js', () => ({ readSettingsRaw: () => ({ downloadDir: 'E:/fixture' }) }));
vi.mock('../store/browser-download-store.js', () => ({ browserDownloadStore: { add: state.add, update: state.update } }));
vi.mock('./webview-registry.js', () => ({ getRecordByWebContentsId: (id: number) => state.records.get(id) }));
vi.mock('../window-state.js', () => ({ windowState: { browserWindowsByProfile: state.byProfile } }));
vi.mock('./window-utils.js', () => ({ findWindowIdByWin: (win: object) => state.ids.get(win) }));

import { registerBrowserDownloads } from './browser-downloads';
import { markAskSavePath } from '../utils/ask-save-path';

function requestSave(partition = 'persist:profile', url = 'https://fixture.test/file') {
  markAskSavePath(state.sessions.get(partition)! as unknown as Session, url);
}

function windowFixture(id: string, guestId: number, profileId = 'profile') {
  const host = {};
  const win = { destroyed: false, isDestroyed() { return this.destroyed; } };
  state.windows.set(host, win); state.ids.set(win, id);
  state.records.set(guestId, { windowId: id, profileId }); state.byProfile.set(profileId, win);
  const guest = { id: guestId, hostWebContents: host, isDestroyed: () => false } as unknown as WebContents;
  return { win, guest };
}

function itemFixture() {
  return Object.assign(new EventEmitter(), { getFilename: () => 'file.txt', getURL: () => 'https://fixture.test/file',
    getTotalBytes: () => 10, getReceivedBytes: () => 10, setSavePath: vi.fn(), cancel: vi.fn() });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks(); state.sessions.clear(); state.windows.clear(); state.ids.clear(); state.records.clear(); state.byProfile.clear();
  state.serial = 0; state.dialog.mockReturnValue('E:/fixture/file.txt');
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn() });
  state.sessions.set('persist:profile', session);
});
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('session download ownership', () => {
  it('keeps one listener after reopening and parents downloads to the actual new window', () => {
    const older = windowFixture('old', 1); registerBrowserDownloads('profile'); older.win.destroyed = true;
    const current = windowFixture('new', 2); registerBrowserDownloads('profile'); const item = itemFixture();
    const session = state.sessions.get('persist:profile')!;
    requestSave();
    session.emit('will-download', {}, item, current.guest);
    expect(session.listenerCount('will-download')).toBe(1);
    expect(state.dialog).toHaveBeenCalledWith(current.win, expect.anything());
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ windowId: 'new', profileId: 'profile' }));
    expect(item.cancel).not.toHaveBeenCalled();
  });

  it('uses the initiating host when another same profile window is present', () => {
    const first = windowFixture('first', 1); windowFixture('second', 2); registerBrowserDownloads('profile');
    requestSave();
    state.sessions.get('persist:profile')!.emit('will-download', {}, itemFixture(), first.guest);
    expect(state.dialog).toHaveBeenCalledWith(first.win, expect.anything());
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ windowId: 'first' }));
  });

  it('does not substitute another profile window or pass a destroyed parent', () => {
    const old = windowFixture('old', 1); old.win.destroyed = true; windowFixture('unrelated', 2, 'other'); registerBrowserDownloads('profile');
    const item = itemFixture(); requestSave(); state.sessions.get('persist:profile')!.emit('will-download', {}, item, old.guest);
    expect(state.dialog).toHaveBeenCalledWith(expect.objectContaining({ title: '另存为' }));
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ windowId: '' })); expect(item.cancel).not.toHaveBeenCalled();
  });

  it('retains item progress and completion after its initiating window closes', () => {
    const first = windowFixture('first', 1); registerBrowserDownloads('profile'); const item = itemFixture();
    requestSave();
    state.sessions.get('persist:profile')!.emit('will-download', {}, item, first.guest); first.win.destroyed = true;
    item.emit('updated', {}, 'progressing'); item.emit('done', {}, 'completed');
    expect(item.cancel).not.toHaveBeenCalled(); expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update).toHaveBeenLastCalledWith('download-1', expect.objectContaining({ state: 'completed', receivedBytes: 10 }));
  });

  it('keeps a requested save in its account while another account downloads the same URL normally', () => {
    const first = windowFixture('first', 1); const other = windowFixture('other', 2, 'other');
    state.sessions.set('persist:other', Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn() }));
    registerBrowserDownloads('profile'); registerBrowserDownloads('other'); requestSave();
    const ordinary = itemFixture(); state.sessions.get('persist:other')!.emit('will-download', {}, ordinary, other.guest);
    expect(state.dialog).not.toHaveBeenCalled(); expect(ordinary.setSavePath).toHaveBeenCalledWith(path.join('E:/fixture', 'file.txt'));
    state.sessions.get('persist:profile')!.emit('will-download', {}, itemFixture(), first.guest);
    expect(state.dialog).toHaveBeenCalledTimes(1); expect(state.dialog).toHaveBeenCalledWith(first.win, expect.anything());
  });

  it('uses the original requested URL after redirects and releases a canceled dialog request', () => {
    const first = windowFixture('first', 1); registerBrowserDownloads('profile'); requestSave();
    state.dialog.mockReturnValueOnce(undefined);
    const redirected = Object.assign(itemFixture(), { getURL: () => 'https://cdn.fixture.test/result',
      getURLChain: () => ['https://fixture.test/file', 'https://cdn.fixture.test/result'] });
    state.sessions.get('persist:profile')!.emit('will-download', {}, redirected, first.guest);
    expect(redirected.cancel).toHaveBeenCalledOnce();
    const ordinary = itemFixture(); state.sessions.get('persist:profile')!.emit('will-download', {}, ordinary, first.guest);
    expect(state.dialog).toHaveBeenCalledTimes(1); expect(ordinary.cancel).not.toHaveBeenCalled();
  });
});
