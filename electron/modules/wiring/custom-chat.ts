// electron/modules/wiring/custom-chat.ts — 自定义对话 API 模块接线（init / teardown / clearData）
//
// 注意（依赖规则 3.3）：chat.db 底座归基础功能（历史搜索/使用统计仍在用），
// 本模块 teardown 只取消流式请求 + 卸载 AI_PROVIDER_*/CHAT_* 通道 + 关闭对话窗口，
// 不关闭 chat-store 数据库。
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerAIProviderIPC, ensureDefaultProviders } from '../../store/ai-provider-store.js'
import { registerAIChatIPC, cleanupActiveStreams } from '../../ai/handler.js'
import { getChatStore } from '../../store/chat-store.js'
import { BrowserWindow } from 'electron'

/** 模块级 EffectScope */
const scope = new EffectScope('custom-chat', 'custom-chat')

const CUSTOM_CHAT_CHANNELS = [
  IPC_CHANNELS.AI_PROVIDER_LIST,
  IPC_CHANNELS.AI_PROVIDER_CREATE,
  IPC_CHANNELS.AI_PROVIDER_UPDATE,
  IPC_CHANNELS.AI_PROVIDER_DELETE,
  IPC_CHANNELS.AI_PROVIDER_TEST,
  IPC_CHANNELS.AI_PROVIDER_LIST_MODELS,
  IPC_CHANNELS.AI_PROVIDER_EXPORT_ENCRYPTED,
  IPC_CHANNELS.AI_PROVIDER_IMPORT_ENCRYPTED,
  IPC_CHANNELS.AI_PROVIDER_PREVIEW_IMPORT,
  IPC_CHANNELS.AI_PROVIDER_WRITE_EXPORT_FILE,
  IPC_CHANNELS.AI_PROVIDER_READ_IMPORT_FILE,
  IPC_CHANNELS.AI_PROVIDER_SELECT_EXPORT_PATH,
  IPC_CHANNELS.AI_PROVIDER_SELECT_IMPORT_FILE,
  IPC_CHANNELS.CHAT_SEND,
  IPC_CHANNELS.CHAT_CANCEL,
  IPC_CHANNELS.CHAT_UPDATE_MESSAGE,
  IPC_CHANNELS.CHAT_DELETE_MESSAGE,
  IPC_CHANNELS.CHAT_OPEN_WINDOW,
  IPC_CHANNELS.CHAT_LIST_DETACHED,
  IPC_CHANNELS.CHAT_CREATE_DETACHED,
  IPC_CHANNELS.CHAT_UPDATE_DETACHED,
  IPC_CHANNELS.CHAT_REMOVE_DETACHED,
  IPC_CHANNELS.CHAT_SHOW_DETACHED,
  IPC_CHANNELS.CHAT_GET_CONFIG,
]

export function initCustomChatModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 传递 scope 给 store 层注册函数，使其使用 EffectScope 管理 IPC handler
    registerAIProviderIPC(scope)
    ensureDefaultProviders()
    registerAIChatIPC(scope)
  })
}

export function teardownCustomChatModule(): void {
  // 1. 取消所有进行中的流式请求
  cleanupActiveStreams()
  // 2. 关闭自定义对话窗口（mode=chat 的独立窗口，含脱离窗口）
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      if (win.webContents.getURL().includes('mode=chat')) {
        win.close()
      }
    } catch (err) {
      console.warn('[wiring:custom-chat] 关闭对话窗口失败:', err)
    }
  }
  // 3. 卸载通道（chat.db 底座保留给历史搜索/使用统计）
  void scope.dispose()
}

export function clearCustomChatData(): void {
  // 仅删除 source_type='custom' 的会话与消息（messages 表 ON DELETE CASCADE）
  getChatStore().clearCustomChatData()
  console.log('[wiring:custom-chat] 数据已清除')
}
