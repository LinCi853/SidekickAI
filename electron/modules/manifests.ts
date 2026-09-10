// electron/modules/manifests.ts — 内置模块 manifest 清单
//
// 声明式字段（id/名称/分类/默认值/入口/热键/安装语义）统一收敛到
// builtin-module-data.ts（见《模块管理系统与安装管控方案》3.2 表格），
// 本文件仅负责绑定各模块的 wiring 生命周期（init/teardown/clearData/capabilities），
// 组装出最终 BUILTIN_MODULES。新增模块只需加 data + wiring 两份。
//
// 注册顺序约束：被依赖模块必须先注册（依赖校验按注册顺序遍历）。

import type { ModuleManifest } from '../shared/types.js'
import { BUILTIN_MODULE_INSTALL_DATA } from './builtin-module-data.js'
import {
  initWhiteboardModule,
  teardownWhiteboardModule,
  clearWhiteboardData,
} from './wiring/whiteboard.js'
import { initNotesModule, teardownNotesModule, clearNotesData } from './wiring/notes.js'
import {
  initPromptLibraryModule,
  teardownPromptLibraryModule,
  clearPromptLibraryData,
} from './wiring/prompt-library.js'
import {
  initCustomChatModule,
  teardownCustomChatModule,
  clearCustomChatData,
} from './wiring/custom-chat.js'
import { initVoiceModule, teardownVoiceModule, clearVoiceData } from './wiring/voice.js'
import { initTtsModule, teardownTtsModule, clearTtsData } from './wiring/tts.js'
import { initBrowserModule, teardownBrowserModule, clearBrowserData } from './wiring/browser.js'
import { initFreezeModule, teardownFreezeModule, clearFreezeData } from './wiring/freeze.js'

/** 模块 id → wiring 生命周期 + 能力声明 */
const WIRING: Record<
  string,
  Pick<ModuleManifest, 'init' | 'teardown' | 'clearData' | 'capabilities'>
> = {
  whiteboard: {
    init: initWhiteboardModule,
    teardown: teardownWhiteboardModule,
    clearData: clearWhiteboardData,
    capabilities: [
      { ownerModule: 'whiteboard', capabilityId: 'whiteboard.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '白板相关 IPC 通道' },
      { ownerModule: 'whiteboard', capabilityId: 'whiteboard.asset-protocol', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '白板图片资产协议' },
    ],
  },
  notes: {
    init: initNotesModule,
    teardown: teardownNotesModule,
    clearData: clearNotesData,
    capabilities: [
      { ownerModule: 'notes', capabilityId: 'notes.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '笔记相关 IPC 通道' },
      { ownerModule: 'notes', capabilityId: 'notes.asset-protocol', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '笔记图片资产协议' },
    ],
  },
  'custom-chat': {
    init: initCustomChatModule,
    teardown: teardownCustomChatModule,
    clearData: clearCustomChatData,
    capabilities: [
      { ownerModule: 'custom-chat', capabilityId: 'custom-chat.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '自定义对话 IPC 通道' },
      { ownerModule: 'custom-chat', capabilityId: 'custom-chat.window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '独立对话窗口' },
    ],
  },
  'prompt-library': {
    init: initPromptLibraryModule,
    teardown: teardownPromptLibraryModule,
    clearData: clearPromptLibraryData,
    capabilities: [
      { ownerModule: 'prompt-library', capabilityId: 'prompt.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '提示词库 IPC 通道' },
      { ownerModule: 'prompt-library', capabilityId: 'prompt.window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '提示词库窗口' },
      { ownerModule: 'prompt-library', capabilityId: 'prompt.injection', kind: 'webview-script', scope: 'document', trigger: 'user-command', reversible: false, description: '提示词注入到页面' },
    ],
  },
  voice: {
    init: initVoiceModule,
    teardown: teardownVoiceModule,
    clearData: clearVoiceData,
    capabilities: [
      { ownerModule: 'voice', capabilityId: 'voice.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '语音相关 IPC 通道' },
      { ownerModule: 'voice', capabilityId: 'voice.hotkey', kind: 'hotkey', scope: 'global', trigger: 'startup', reversible: true, description: 'Alt+V 语音热键' },
      { ownerModule: 'voice', capabilityId: 'voice.preview-window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '录音指示窗' },
    ],
  },
  tts: {
    init: initTtsModule,
    teardown: teardownTtsModule,
    clearData: clearTtsData,
    capabilities: [
      { ownerModule: 'tts', capabilityId: 'tts.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: 'TTS 测试 IPC 通道', dependencies: ['custom-chat.ipc'] },
    ],
  },
  browser: {
    init: initBrowserModule,
    teardown: teardownBrowserModule,
    clearData: clearBrowserData,
    capabilities: [
      { ownerModule: 'browser', capabilityId: 'browser.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '浏览器相关 IPC 通道' },
      { ownerModule: 'browser', capabilityId: 'browser.window', kind: 'window', scope: 'profile', trigger: 'user-command', reversible: true, description: '浏览器窗口创建' },
      { ownerModule: 'browser', capabilityId: 'browser.profile-shortcuts', kind: 'hotkey', scope: 'profile', trigger: 'startup', reversible: true, description: '每应用浏览器快捷键' },
    ],
  },
  freeze: {
    init: initFreezeModule,
    teardown: teardownFreezeModule,
    clearData: clearFreezeData,
    capabilities: [
      { ownerModule: 'freeze', capabilityId: 'freeze.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '冻结相关 IPC 通道' },
      { ownerModule: 'freeze', capabilityId: 'freeze.debugger', kind: 'debugger', scope: 'tab', trigger: 'user-command', reversible: true, description: 'Debugger.pause 冻结页面' },
      { ownerModule: 'freeze', capabilityId: 'freeze.text-layer', kind: 'webview-script', scope: 'tab', trigger: 'user-command', reversible: false, description: '冻结前提取文本层' },
    ],
  },
}

export const BUILTIN_MODULES: ModuleManifest[] = BUILTIN_MODULE_INSTALL_DATA.map((d) => {
  const w = WIRING[d.id] ?? {}
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    sizeLevel: d.sizeLevel,
    testBadge: d.testBadge,
    defaultEnabled: d.defaultEnabled,
    dependencies: d.dependencies,
    entries: d.entries,
    hotkeys: d.hotkeys,
    init: w.init,
    teardown: w.teardown,
    clearData: w.clearData,
    capabilities: w.capabilities,
  }
})