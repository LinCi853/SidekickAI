// electron/modules/wiring/prompt-library.ts — 提示词库模块接线（init / teardown / clearData）
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerPromptIPC, promptStore, ensureDefaultPrompts } from '../../store/prompt-store.js'
import { registerPromptIpc } from '../../ipc/prompt-ipc.js'
import { registerInjectionIpc } from '../../ai/handler.js'
import { injectionHistoryStore } from '../../store/injection-history-store.js'
import { showPromptWindow } from '../../window-factory.js'
import { windowState } from '../../window-state.js'

/** 模块级 EffectScope */
const scope = new EffectScope('prompt-library', 'prompt-library')

const PROMPT_CHANNELS = [
  IPC_CHANNELS.PROMPT_LIST,
  IPC_CHANNELS.PROMPT_SAVE,
  IPC_CHANNELS.PROMPT_DELETE,
  IPC_CHANNELS.PROMPT_EXPORT,
  IPC_CHANNELS.PROMPT_IMPORT,
  IPC_CHANNELS.PROMPT_OPEN_WINDOW,
  IPC_CHANNELS.PROMPT_INJECT_REQUEST,
  IPC_CHANNELS.PROMPT_INJECT_RESULT,
  IPC_CHANNELS.INJECTION_LOG,
  IPC_CHANNELS.INJECTION_LIST_RECENT,
  IPC_CHANNELS.INJECTION_FIND_SIMILAR,
  IPC_CHANNELS.INJECTION_CLEAR,
]

export function initPromptLibraryModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 首次启动填充预置提示词模板
    ensureDefaultPrompts()
    // 传递 scope 给 store 层注册函数，使其使用 EffectScope 管理 IPC handler
    registerPromptIPC(scope)
    registerInjectionIpc(scope)
    // 传递 scope 给 registerPromptIpc，使其使用 EffectScope 管理 IPC handler
    registerPromptIpc({
      showPromptWindow,
      getMainWindow: () => windowState.mainWindow,
      getPromptWindow: () => windowState.promptWindow,
    }, scope)
  })
}

export function teardownPromptLibraryModule(): void {
  // 关闭提示词库窗口（若有）
  const win = windowState.promptWindow
  if (win && !win.isDestroyed()) {
    win.close()
  }
  void scope.dispose()
}

export function clearPromptLibraryData(): void {
  for (const t of promptStore.list()) {
    promptStore.delete(t.id)
  }
  // 注入历史（预览 + Jaccard 去重）随提示词库数据一并清除
  try {
    injectionHistoryStore.clear()
  } catch (err) {
    console.warn('[wiring:prompt-library] 清除注入历史失败:', err)
  }
  console.log('[wiring:prompt-library] 数据已清除')
}
