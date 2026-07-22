/* =====================================================================
   lib/electron-api/core.ts —— 基础工具函数与共享类型 re-export
   通过 preload 暴露的 window.electron 调用主进程 API，类型安全。
   类型来源：electron/shared/types.ts（主进程 / Preload / 渲染进程共享）。
   ===================================================================== */

// 从共享类型定义导入（tsconfig include 含 src 与 electron，相对路径可解析）
import type {
  ElectronAPI,
  Profile,
  DevicePreset,
  AIPlatform,
  FingerprintConfig,
  FingerprintMode,
  PlatformType,
  WindowMode,
  TabState,
  WindowStateData,
  PromptTemplate,
  HotkeyAction,
  HotkeyConfig,
  CustomAIProvider,
  CustomAIProviderInput,
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatRole,
  ChatSendPayload,
  ChatStreamChunk,
  ChatWindowConfig,
  ChatWindowStyle,
  WindowTrace,
  WindowTraceAction,
  LoginTrace,
  VoiceConfig,
  AppSettings,
  PlatformCapabilities,
  TopBarButtonGroup,
  InjectionRecord,
  SimilarInjectionResult,
  Note,
  NoteSaveInput,
  WhiteboardState,
  WhiteboardCard,
  WhiteboardCardInput,
  WhiteboardArrow,
  WhiteboardStroke,
  WhiteboardCardType,
  WhiteboardViewport,
} from '../../../electron/shared/types';

// ALL_TOP_BAR_BUTTON_GROUPS 是 const 值，必须用普通 import（非 import type）才能 re-export
import { ALL_TOP_BAR_BUTTON_GROUPS } from '../../../electron/shared/types';

/** 暴露到 window.electron 的完整 API */
export type {
  ElectronAPI,
  Profile,
  DevicePreset,
  AIPlatform,
  FingerprintConfig,
  FingerprintMode,
  PlatformType,
  WindowMode,
  TabState,
  WindowStateData,
  PromptTemplate,
  HotkeyAction,
  HotkeyConfig,
  CustomAIProvider,
  CustomAIProviderInput,
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatRole,
  ChatSendPayload,
  ChatStreamChunk,
  ChatWindowConfig,
  ChatWindowStyle,
  WindowTrace,
  WindowTraceAction,
  LoginTrace,
  VoiceConfig,
  AppSettings,
  PlatformCapabilities,
  TopBarButtonGroup,
  InjectionRecord,
  SimilarInjectionResult,
  Note,
  NoteSaveInput,
  WhiteboardState,
  WhiteboardCard,
  WhiteboardCardInput,
  WhiteboardArrow,
  WhiteboardStroke,
  WhiteboardCardType,
  WhiteboardViewport,
};

/** 全部顶栏按钮组（默认全选，供设置/引导页默认值使用） */
export {
  ALL_TOP_BAR_BUTTON_GROUPS,
};

/** 全局 Window 扩展 —— 声明 window.electron 由 preload 注入 */
declare global {
  interface Window {
    /** Electron preload 通过 contextBridge 暴露的 API */
    electron: ElectronAPI;
  }
}

/**
 * 安全获取 window.electron —— 在非 Electron 环境（如纯浏览器预览）返回 null
 * 调用方需处理 null 情况，便于开发期降级
 */
export function getElectron(): ElectronAPI | null {
  return typeof window !== 'undefined' ? window.electron ?? null : null;
}

/**
 * 获取 window.electron，不存在则抛错
 * 用于「确定在 Electron 环境」的场景
 */
export function requireElectron(): ElectronAPI {
  const api = getElectron();
  if (!api) {
    throw new Error('window.electron 不可用（未在 Electron 环境运行）');
  }
  return api;
}

/* =====================================================================
   平台统一 API 访问器
   ---------------------------------------------------------------------
   Electron 专属逻辑可继续用 getElectron() / requireElectron()。
   ===================================================================== */

import { PLATFORM, isElectron } from '../platform-detector';

/** 当前平台常量（re-export 供外部同步分支使用） */
export { PLATFORM };

/** 统一 API 类型 = Electron API */
export type UnifiedAPI = ElectronAPI;

/**
 * 统一获取当前平台的 API。
 * - electron 环境 → 返回 window.electron
 * - web 环境     → 返回 null
 */
export async function getAPI(): Promise<UnifiedAPI | null> {
  if (isElectron()) return getElectron();
  return null;
}

/**
 * 统一获取当前平台的 API，不存在则抛错。
 */
export async function requireAPI(): Promise<UnifiedAPI> {
  const api = await getAPI();
  if (!api) {
    throw new Error(
      `当前平台 (${PLATFORM}) 无可用 API：` +
        (isElectron() ? 'window.electron 不可用' : '纯 Web 环境无原生 API'),
    );
  }
  return api;
}
