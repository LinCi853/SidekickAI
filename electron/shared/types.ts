// shared/types.ts — 主进程 / Preload / 渲染进程共享类型定义
//
// 桶导出（barrel）：保持向后兼容，所有 `from '../shared/types'` / `from './shared/types.js'`
// 引用点无需修改。各类型定义已按领域物理拆分到同目录下的 *.types.ts / ipc-channels.ts。
//
// 拆分清单：
//   fingerprint.types.ts — FingerprintMode / FingerprintConfig
//   profile.types.ts     — PlatformType / DevicePreset / Profile / AIPlatform
//   window.types.ts      — WindowMode / TabState / WindowStateData / ChatWindowConfig / ChatWindowStyle
//   chat.types.ts        — Conversation / ChatMessage / CustomAIProvider / PromptTemplate / 痕迹记录 等
//   ipc-channels.ts      — IPC_CHANNELS 常量
//   api.types.ts         — ProfileAPI / ChatAPI / ElectronAPI 等接口契约

export * from './fingerprint.types.js'
export * from './profile.types.js'
export * from './proxy.types.js'
export * from './window.types.js'
export * from './chat.types.js'
export * from './block-rules.types.js'
export * from './notes.types.js'
export * from './whiteboard.types.js'
export * from './browser.types.js'
export * from './bookmark.types.js'
export * from './ipc-channels.js'
export * from './module-manifest.types.js'
export * from './api.types.js'
