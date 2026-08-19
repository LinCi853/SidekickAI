// electron/modules/manifests.ts — 内置模块 manifest 清单
//
// 7 个可选模块的声明（元数据）。声明内容（名称/分类/默认值/入口/热键）与
// 《模块管理系统与安装管控方案》3.2 表格一致。
//
// init / teardown / clearData 在 main.ts 模块化接线阶段逐模块接入
// （见方案文档第 11 章《模块实现统一设计规范》）。
//
// 注册顺序约束：被依赖模块必须先注册（依赖校验按注册顺序遍历）。

import type { ModuleManifest } from '../shared/types.js'
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


export const BUILTIN_MODULES: ModuleManifest[] = [
  {
    id: 'whiteboard',
    name: '画板/白板',
    description: 'Excalidraw 无限画布：多白板管理、SQLite 持久化、截图推送到白板',
    category: 'stable',
    sizeLevel: 'large',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['进阶面板「白板」标签页', '主窗口「截图推送到白板」'],
    hotkeys: [],
    init: initWhiteboardModule,
    teardown: teardownWhiteboardModule,
    clearData: clearWhiteboardData,
    capabilities: [
      { ownerModule: 'whiteboard', capabilityId: 'whiteboard.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '白板相关 IPC 通道' },
      { ownerModule: 'whiteboard', capabilityId: 'whiteboard.asset-protocol', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '白板图片资产协议' },
    ],
  },
  {
    id: 'notes',
    name: '笔记',
    description: 'Tiptap 富文本灵感笔记：任务列表、代码块、图片，全文搜索（FTS5）',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['进阶面板「笔记」标签页', '笔记「发送到 AI」', '笔记「存为提示词」（提示词库启用时）'],
    hotkeys: [],
    init: initNotesModule,
    teardown: teardownNotesModule,
    clearData: clearNotesData,
    capabilities: [
      { ownerModule: 'notes', capabilityId: 'notes.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '笔记相关 IPC 通道' },
      { ownerModule: 'notes', capabilityId: 'notes.asset-protocol', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '笔记图片资产协议' },
    ],
  },
  {
    id: 'custom-chat',
    name: '自定义对话 API',
    description: 'OpenAI / Anthropic / Custom 三协议直连：自定义供应商、SSE 流式对话、SQLite 会话持久化',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['进阶面板「自定义供应商 / 对话」', '独立对话窗口', '设置「供应商」分区'],
    hotkeys: [],
    init: initCustomChatModule,
    teardown: teardownCustomChatModule,
    clearData: clearCustomChatData,
    capabilities: [
      { ownerModule: 'custom-chat', capabilityId: 'custom-chat.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '自定义对话 IPC 通道' },
      { ownerModule: 'custom-chat', capabilityId: 'custom-chat.window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '独立对话窗口' },
    ],
  },
  {
    id: 'prompt-library',
    name: '提示词库',
    description: '提示词模板管理、热键注入、注入历史去重',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['抽屉菜单「提示词」', '提示词库窗口', '笔记「存为提示词」'],
    hotkeys: ['提示词注入热键（用户自定义）'],
    init: initPromptLibraryModule,
    teardown: teardownPromptLibraryModule,
    clearData: clearPromptLibraryData,
    capabilities: [
      { ownerModule: 'prompt-library', capabilityId: 'prompt.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '提示词库 IPC 通道' },
      { ownerModule: 'prompt-library', capabilityId: 'prompt.window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '提示词库窗口' },
      { ownerModule: 'prompt-library', capabilityId: 'prompt.injection', kind: 'webview-script', scope: 'document', trigger: 'user-command', reversible: false, description: '提示词注入到页面' },
    ],
  },
  {
    id: 'voice',
    name: '语音输入',
    description: 'Alt+V 后台语音：按住说话、STT 识别（AI 接入 / 本地程序）、分层上屏（实验性）',
    category: 'dev',
    sizeLevel: 'small',
    testBadge: true,
    defaultEnabled: false,
    dependencies: [],
    entries: ['后台语音 Alt+V', '设置「语音」分区', '录音指示窗'],
    hotkeys: ['Alt+V（后台语音）'],
    init: initVoiceModule,
    teardown: teardownVoiceModule,
    clearData: clearVoiceData,
    capabilities: [
      { ownerModule: 'voice', capabilityId: 'voice.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '语音相关 IPC 通道' },
      { ownerModule: 'voice', capabilityId: 'voice.hotkey', kind: 'hotkey', scope: 'global', trigger: 'startup', reversible: true, description: 'Alt+V 语音热键' },
      { ownerModule: 'voice', capabilityId: 'voice.preview-window', kind: 'window', scope: 'global', trigger: 'user-command', reversible: true, description: '录音指示窗' },
    ],
  },
  {
    id: 'tts',
    name: 'TTS（语音合成）',
    description: '自定义供应商 TTS 合成（实验性）',
    category: 'dev',
    sizeLevel: 'small',
    testBadge: true,
    defaultEnabled: false,
    dependencies: ['custom-chat'],
    entries: ['设置「语音」分区（TTS 配置）'],
    hotkeys: [],
    init: initTtsModule,
    teardown: teardownTtsModule,
    clearData: clearTtsData,
    capabilities: [
      { ownerModule: 'tts', capabilityId: 'tts.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: 'TTS 测试 IPC 通道', dependencies: ['custom-chat.ipc'] },
    ],
  },
  {
    id: 'browser',
    name: '浏览器',
    description:
      'Chrome 风格多标签浏览器窗口：标签/导航/书签/下载/历史/搜索、云游戏手柄（实验性）',
    category: 'dev',
    sizeLevel: 'small',
    testBadge: true,
    defaultEnabled: false,
    dependencies: [],
    entries: ['每应用「脱离/回归」快捷键', '标签脱离到浏览器窗口'],
    hotkeys: ['每应用浏览器窗口快捷键（用户配置）'],
    init: initBrowserModule,
    teardown: teardownBrowserModule,
    clearData: clearBrowserData,
    capabilities: [
      { ownerModule: 'browser', capabilityId: 'browser.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '浏览器相关 IPC 通道' },
      { ownerModule: 'browser', capabilityId: 'browser.window', kind: 'window', scope: 'profile', trigger: 'user-command', reversible: true, description: '浏览器窗口创建' },
      { ownerModule: 'browser', capabilityId: 'browser.profile-shortcuts', kind: 'hotkey', scope: 'profile', trigger: 'startup', reversible: true, description: '每应用浏览器快捷键' },
    ],
  },
  {
    id: 'freeze',
    name: '页面冻结（防撤回）',
    description: '冻结 AI 网页防止对方撤回/删除内容：抓取对话入库 + 文本层选择复制（实验性）',
    category: 'dev',
    sizeLevel: 'small',
    testBadge: true,
    defaultEnabled: false,
    dependencies: [],
    entries: ['浏览器窗口内冻结按钮与控制条'],
    hotkeys: [],
    init: initFreezeModule,
    teardown: teardownFreezeModule,
    clearData: clearFreezeData,
    capabilities: [
      { ownerModule: 'freeze', capabilityId: 'freeze.ipc', kind: 'ipc', scope: 'global', trigger: 'startup', reversible: true, description: '冻结相关 IPC 通道' },
      { ownerModule: 'freeze', capabilityId: 'freeze.debugger', kind: 'debugger', scope: 'tab', trigger: 'user-command', reversible: true, description: 'Debugger.pause 冻结页面' },
      { ownerModule: 'freeze', capabilityId: 'freeze.text-layer', kind: 'webview-script', scope: 'tab', trigger: 'user-command', reversible: false, description: '冻结前提取文本层' },
    ],
  },

]
