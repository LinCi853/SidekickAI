// electron/freeze/debugger-session.ts — CDP debugger 会话机制层
//
// 从 freeze-manager.ts 拆分的 Debugger 机制：
//   - Debugger.attach / detach
//   - Target.setAutoAttach 递归 attach 子目标（iframe / Worker / Service Worker）
//   - Debugger.pause / resume 的对称回滚（任一步骤失败时恢复原状态）
//   - 意外 detach 通过 freeze-manager 注入的回调清理冻结会话并广播 idle

import { type WebContents } from 'electron'

interface DebuggerRuntime {
  childSessions: Set<string>
  pausedChildSessions: Set<string>
  waitingChildSessions: Set<string>
  desiredState: 'running' | 'paused'
  childOperation: Promise<void>
  childOperationError: unknown | null
  messageHandler: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void
  detachHandler: () => void
}

export const debuggerRuntimes = new Map<number, DebuggerRuntime>()
export const expectedDebuggerDetaches = new Set<number>()

/** 意外 detach 处理回调（freeze-manager 注入：清理冻结会话并广播 idle） */
let unexpectedDetachHandler: ((webContentsId: number) => void) | null = null

export function setUnexpectedDetachHandler(cb: (webContentsId: number) => void): void {
  unexpectedDetachHandler = cb
}

function queueChildOperation(
  runtime: DebuggerRuntime,
  operation: () => Promise<void>,
): Promise<void> {
  const pending = runtime.childOperation.then(operation)
  runtime.childOperation = pending.catch((err) => {
    runtime.childOperationError ??= err
  })
  return pending
}

async function drainChildOperations(runtime: DebuggerRuntime): Promise<void> {
  while (true) {
    const pending = runtime.childOperation
    await pending
    await Promise.resolve()
    if (pending === runtime.childOperation) break
  }
  if (runtime.childOperationError) throw runtime.childOperationError
}

export function cleanupDebuggerRuntime(wc: WebContents): void {
  const runtime = debuggerRuntimes.get(wc.id)
  if (!runtime) return
  wc.debugger.removeListener('message', runtime.messageHandler)
  wc.debugger.removeListener('detach', runtime.detachHandler)
  debuggerRuntimes.delete(wc.id)
}

function handleUnexpectedDebuggerDetach(
  webContentsId: number,
  onUnexpectedDetach: (webContentsId: number) => void,
): void {
  onUnexpectedDetach(webContentsId)
}

function ensureDebuggerRuntime(wc: WebContents): DebuggerRuntime {
  const current = debuggerRuntimes.get(wc.id)
  if (current) return current

  const runtime = {} as DebuggerRuntime
  runtime.childSessions = new Set<string>()
  runtime.pausedChildSessions = new Set<string>()
  runtime.waitingChildSessions = new Set<string>()
  runtime.desiredState = 'running'
  runtime.childOperation = Promise.resolve()
  runtime.childOperationError = null
  runtime.messageHandler = (_event, method, params) => {
    if (method === 'Target.detachedFromTarget') {
      const detachedId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (detachedId) {
        runtime.childSessions.delete(detachedId)
        runtime.pausedChildSessions.delete(detachedId)
        runtime.waitingChildSessions.delete(detachedId)
      }
      return
    }
    if (method !== 'Target.attachedToTarget') return
    const childId = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!childId) return
    runtime.childSessions.add(childId)
    if (params.waitingForDebugger === true) runtime.waitingChildSessions.add(childId)
    void queueChildOperation(runtime, async () => {
      if (!runtime.childSessions.has(childId)) return
      await wc.debugger.sendCommand('Debugger.enable', {}, childId)
      await wc.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: runtime.desiredState === 'paused',
        flatten: true,
      }, childId)
      if (runtime.desiredState === 'paused') {
        if (!runtime.waitingChildSessions.has(childId)) {
          await wc.debugger.sendCommand('Debugger.pause', {}, childId)
          runtime.pausedChildSessions.add(childId)
        }
      } else {
        await wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, childId).catch(() => undefined)
        runtime.waitingChildSessions.delete(childId)
      }
    }).catch((err) => {
      console.warn(`[freeze] 子目标 ${childId} 初始化失败:`, err)
    })
  }
  runtime.detachHandler = () => {
    cleanupDebuggerRuntime(wc)
    if (!expectedDebuggerDetaches.has(wc.id) && unexpectedDetachHandler) {
      handleUnexpectedDebuggerDetach(wc.id, unexpectedDetachHandler)
    }
  }
  wc.debugger.on('message', runtime.messageHandler)
  wc.debugger.on('detach', runtime.detachHandler)
  debuggerRuntimes.set(wc.id, runtime)
  return runtime
}

export async function pauseDebuggerTargets(wc: WebContents): Promise<void> {
  const runtime = ensureDebuggerRuntime(wc)
  runtime.desiredState = 'paused'
  runtime.childOperationError = null
  try {
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    await queueChildOperation(runtime, async () => {
      const results = await Promise.allSettled(Array.from(runtime.childSessions, async (sessionId) => {
        await wc.debugger.sendCommand('Debugger.enable', {}, sessionId)
        if (!runtime.pausedChildSessions.has(sessionId) && !runtime.waitingChildSessions.has(sessionId)) {
          await wc.debugger.sendCommand('Debugger.pause', {}, sessionId)
          runtime.pausedChildSessions.add(sessionId)
        }
      }))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    await wc.debugger.sendCommand('Debugger.pause')
    await drainChildOperations(runtime)
  } catch (err) {
    runtime.desiredState = 'running'
    await drainChildOperations(runtime).catch(() => undefined)
    await Promise.allSettled(Array.from(runtime.pausedChildSessions, async (sessionId) => {
      await wc.debugger.sendCommand('Debugger.resume', {}, sessionId)
      runtime.pausedChildSessions.delete(sessionId)
    }))
    await wc.debugger.sendCommand('Debugger.resume').catch(() => undefined)
    await Promise.allSettled(Array.from(runtime.waitingChildSessions, async (sessionId) => {
      await wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId)
      runtime.waitingChildSessions.delete(sessionId)
    }))
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => undefined)
    throw err
  }
}

export async function resumeDebuggerTargets(wc: WebContents): Promise<void> {
  const runtime = debuggerRuntimes.get(wc.id)
  if (!runtime) {
    await wc.debugger.sendCommand('Debugger.resume')
    return
  }
  runtime.desiredState = 'running'
  runtime.childOperationError = null
  try {
    await queueChildOperation(runtime, async () => {
      const results = await Promise.allSettled(Array.from(runtime.pausedChildSessions, async (sessionId) => {
        await wc.debugger.sendCommand('Debugger.resume', {}, sessionId)
        runtime.pausedChildSessions.delete(sessionId)
        await wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
      }))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    await wc.debugger.sendCommand('Debugger.resume')
    await Promise.allSettled(Array.from(runtime.waitingChildSessions, async (sessionId) => {
      await wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId)
      runtime.waitingChildSessions.delete(sessionId)
    }))
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    await drainChildOperations(runtime)
  } catch (err) {
    runtime.desiredState = 'paused'
    await drainChildOperations(runtime).catch(() => undefined)
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }).catch(() => undefined)
    await wc.debugger.sendCommand('Debugger.pause').catch(() => undefined)
    await Promise.allSettled(Array.from(runtime.childSessions, async (sessionId) => {
      if (!runtime.pausedChildSessions.has(sessionId) && !runtime.waitingChildSessions.has(sessionId)) {
        await wc.debugger.sendCommand('Debugger.pause', {}, sessionId)
        runtime.pausedChildSessions.add(sessionId)
      }
    }))
    throw err
  }
}

/** 附加调试器并启用递归子目标 attach（不 pause） */
export async function attach(wc: WebContents): Promise<void> {
  if (!wc.debugger.isAttached()) await wc.debugger.attach('1.3')
  ensureDebuggerRuntime(wc)
  await wc.debugger.sendCommand('Debugger.enable')
  // 递归 attach 子目标（iframe / Worker / Service Worker），否则冻结不彻底
  await wc.debugger.sendCommand('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
}
