import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  current: null as ReturnType<typeof createWebContents> | null,
}));

vi.mock('electron', () => ({}));
vi.mock('./webview-registry.js', () => ({
  getWebviewByTabId: () => registry.current,
  listRegisteredWebviews: () => registry.current ? [{ webContentsId: registry.current.id }] : [],
}));

function createWebContents() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const debuggerApi = {
    attached: false,
    failResumeOnce: false,
    commands: [] as Array<{ command: string; sessionId?: string }>,
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = listeners.get(event) || new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((handler) => handler(...args));
    },
    isAttached() {
      return this.attached;
    },
    async attach() {
      this.attached = true;
    },
    async detach() {
      this.attached = false;
    },
    async sendCommand(command: string, _params?: unknown, sessionId?: string) {
      this.commands.push({ command, sessionId });
      if (command === 'Debugger.resume' && this.failResumeOnce) {
        this.failResumeOnce = false;
        throw new Error('resume failed');
      }
      return {};
    },
  };
  const owner = {
    id: 1,
    isDestroyed: () => false,
    isFocused: () => true,
    on: vi.fn(),
  };
  return {
    id: 42,
    debugger: debuggerApi,
    isDestroyed: () => false,
    getOwnerBrowserWindow: () => owner,
  };
}

describe('freeze manager transitions', () => {
  beforeEach(async () => {
    vi.resetModules();
    registry.current = createWebContents();
  });

  it('releases the transition lock across freeze, resume, refreeze, and detach', async () => {
    const manager = await import('./freeze-manager.js');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    expect(manager.getFreezeState('tab-1')).toBe('frozen');
    expect(await manager.resumeTab('tab-1')).toBe(true);
    expect(manager.getFreezeState('tab-1')).toBe('attached');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    expect(await manager.detachTab('tab-1')).toBe(true);
    expect(manager.getFreezeState('tab-1')).toBe('idle');
  });

  it('releases the transition lock when resume throws so retry can succeed', async () => {
    const manager = await import('./freeze-manager.js');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    registry.current!.debugger.failResumeOnce = true;
    expect(await manager.resumeTab('tab-1')).toBe(false);
    expect(await manager.resumeTab('tab-1')).toBe(true);
  });

  it('rejects a concurrent transition and accepts the next transition', async () => {
    const manager = await import('./freeze-manager.js');
    let resolvePause: (() => void) | undefined;
    const original = registry.current!.debugger.sendCommand.bind(registry.current!.debugger);
    registry.current!.debugger.sendCommand = async (command: string) => {
      if (command === 'Debugger.pause') {
        await new Promise<void>((resolve) => { resolvePause = resolve; });
      }
      return original(command);
    };
    const first = manager.freezeTab('tab-1');
    await vi.waitFor(() => expect(resolvePause).toBeTypeOf('function'));
    expect(await manager.freezeTab('tab-1')).toBe(false);
    resolvePause!();
    expect(await first).toBe(true);
    expect(await manager.resumeTab('tab-1')).toBe(true);
  });

  it('clears only the session owned by the destroyed guest', async () => {
    const manager = await import('./freeze-manager.js');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    expect(manager.clearDestroyedFreezeSession('tab-1', 999)).toBe(false);
    expect(manager.getFreezeState('tab-1')).toBe('frozen');
    expect(manager.clearDestroyedFreezeSession('tab-1', 42)).toBe(true);
    expect(manager.getFreezeState('tab-1')).toBe('idle');
  });

  it('pauses and resumes attached child debugger sessions', async () => {
    const manager = await import('./freeze-manager.js');
    const freeze = manager.freezeTab('tab-1');
    await vi.waitFor(() => expect(registry.current!.debugger.isAttached()).toBe(true));
    registry.current!.debugger.emit(
      'message',
      {},
      'Target.attachedToTarget',
      { sessionId: 'worker-1' },
      undefined,
    );
    expect(await freeze).toBe(true);
    await vi.waitFor(() => expect(registry.current!.debugger.commands).toContainEqual({
      command: 'Debugger.pause',
      sessionId: 'worker-1',
    }));
    expect(await manager.resumeTab('tab-1')).toBe(true);
    expect(registry.current!.debugger.commands).toContainEqual({
      command: 'Debugger.resume',
      sessionId: 'worker-1',
    });
    expect(registry.current!.debugger.commands).toContainEqual({
      command: 'Target.setAutoAttach',
      sessionId: 'worker-1',
    });
  });

  it('keeps a frozen session when resume and detach both fail', async () => {
    const manager = await import('./freeze-manager.js');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    registry.current!.debugger.failResumeOnce = true;
    registry.current!.debugger.detach = async () => {
      throw new Error('detach failed');
    };
    expect(await manager.detachTab('tab-1')).toBe(false);
    expect(manager.getFreezeState('tab-1')).toBe('frozen');
  });

  it('clears the session when the debugger detaches unexpectedly', async () => {
    const manager = await import('./freeze-manager.js');
    expect(await manager.freezeTab('tab-1')).toBe(true);
    registry.current!.debugger.attached = false;
    registry.current!.debugger.emit('detach', {}, 'target closed');
    expect(manager.getFreezeState('tab-1')).toBe('idle');
  });
});
