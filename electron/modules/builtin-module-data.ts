// electron/modules/builtin-module-data.ts — 内置模块「纯数据」单源
//
// 只包含声明式字段（无 init/teardown/clearData 等副作用函数），供两处消费：
//  - manifests.ts 组装 BUILTIN_MODULES（绑定 wiring 生命周期函数）
//  - electron/shared/install-manifest-source.ts 派生安装向导清单
//
// 安装语义字段：
//  - installRequired=true：需独立安装才能使用（对应 sizeLevel=large），安装前选定
//  - required=true：不可关闭的核心模块
//
// 模块 id 为准，新增/重命名/调整 sizeLevel 时只需改这里。

import type { ModuleCategory, ModuleSizeLevel } from '../shared/module-manifest.types.js'

export interface BuiltinModuleData {
  id: string
  name: string
  description: string
  category: ModuleCategory
  sizeLevel: ModuleSizeLevel
  testBadge: boolean
  defaultEnabled: boolean
  dependencies: string[]
  entries: string[]
  hotkeys: string[]
  /** 需独立安装才能使用（当前对应 sizeLevel=large）；缺省 false */
  installRequired?: boolean
  /** 不可关闭的核心模块；缺省 false */
  required?: boolean
}

export const BUILTIN_MODULE_INSTALL_DATA: BuiltinModuleData[] = [
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
    installRequired: true,
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
    entries: ['进阶面板「笔记」标签页', '笔记「发送到 AI」', '笔记「存为提示词」（AI资产启用时）'],
    hotkeys: [],
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
    required: true,
  },
  {
    id: 'prompt-library',
    name: 'AI资产',
    description: '自动收纳对话、思考与资料，整理提示词和本地文本用量',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['抽屉菜单「AI资产」', 'AI资产窗口', '笔记「存为提示词」'],
    hotkeys: ['提示词注入热键（用户自定义）'],
  },
  {
    id: 'voice',
    name: '语音输入',
    description: '按需开始录音，使用已配置的 AI 接入或本地程序识别并输入文字',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['后台语音 Alt+V', '设置「语音」分区', '录音指示窗'],
    hotkeys: ['Alt+V（后台语音）'],
  },
  {
    id: 'tts',
    name: 'TTS（语音合成）',
    description: '使用已配置的自定义供应商合成语音，按需预览播放',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: ['custom-chat'],
    entries: ['设置「语音」分区（TTS 配置）'],
    hotkeys: [],
  },
  {
    id: 'browser',
    name: '浏览器',
    description:
      '多标签浏览器：导航、书签、下载、历史、搜索及网页手柄映射',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: [],
    entries: ['每应用「脱离/回归」快捷键', '标签脱离到浏览器窗口'],
    hotkeys: ['每应用浏览器窗口快捷键（用户配置）'],
  },
  {
    id: 'freeze',
    name: 'AI资产页面冻结',
    description: '在 AI资产中手动冻结已加载页面，查看记录并恢复网页',
    category: 'stable',
    sizeLevel: 'small',
    testBadge: false,
    defaultEnabled: true,
    dependencies: ['prompt-library'],
    entries: ['AI资产「手动页面冻结」', '浏览器窗口内冻结按钮与控制条'],
    hotkeys: [],
  },
]
