/* =====================================================================
   lib/shortcut-reference.ts —— 快捷键参考数据（页面 ID 与全局热键回退元信息）
   说明展示走「注册即声明」：各行为实现在注册键位时一并声明说明
   （store/useShortcutDocStore），本文件只保留两块共享数据：

   - 页面 ID 派生 + 显示名（弹窗头部「当前页面」徽标）
   - 全局热键回退元信息（配置未加载时的展示；运行时由
     hooks/useGlobalHotkeyDocs 从主进程 getHotkeys() 扫描实配键位/启停）
     使用指南（HotkeysStep）也用它渲染热键启停开关
   ===================================================================== */

import type { HotkeyAction } from '../lib/electron-api'

/** 当前渲染层对应的页面/窗口类型（与 App.tsx 的 URL 路由分流一致） */
export type ShortcutPageId =
  | 'main'
  | 'standalone'
  | 'chat'
  | 'record-indicator'
  | 'history'
  | 'prompts'
  | 'ai-app-editor'
  | 'advanced-panel'
  | 'onboarding'
  | 'data-export'
  | 'settings'
  | 'browser'
  | 'history-download'

/**
 * 从 URL 推导当前页面 ID（与 App.tsx 的路由判定顺序保持一致）。
 * 修改 App.tsx 的分流条件时必须同步这里，否则弹窗会展示错误页面的徽标。
 */
export function getShortcutPageId(search?: string): ShortcutPageId {
  const query = search ?? (typeof window === 'undefined' ? '' : window.location.search)
  const params = new URLSearchParams(query)
  const windowId = params.get('windowId') ?? 'main'
  const mode = params.get('mode')
  if (windowId === 'chat' || mode === 'chat') return 'chat'
  if (windowId === 'preview' && (mode === null || mode === 'record-indicator'))
    return 'record-indicator'
  if (mode === 'history') return 'history'
  if (mode === 'prompts') return 'prompts'
  if (mode === 'ai-app-editor') return 'ai-app-editor'
  if (mode === 'advanced-panel') return 'advanced-panel'
  if (mode === 'onboarding') return 'onboarding'
  if (mode === 'data-export') return 'data-export'
  if (mode === 'settings') return 'settings'
  if (mode === 'browser') return 'browser'
  if (mode === 'history-download') return 'history-download'
  return windowId === 'main' ? 'main' : 'standalone'
}

/** 页面显示名（弹窗头部「当前页面」徽标）。
 *  注意：mode=history / mode=prompts 为遗留路由，渲染的都是 AI资产窗口。 */
export const SHORTCUT_PAGE_TITLES: Record<ShortcutPageId, string> = {
  main: '主窗口',
  standalone: '独立标签窗口',
  chat: '对话窗口',
  'record-indicator': '录音指示',
  history: 'AI资产',
  prompts: 'AI资产',
  'ai-app-editor': 'AI 应用编辑器',
  'advanced-panel': '进阶面板',
  onboarding: '使用指南',
  'data-export': '数据导出',
  settings: '设置',
  browser: '浏览器',
  'history-download': '历史与下载',
}

/** 全局热键展示元信息（实际键位运行时从主进程 getHotkeys() 读取） */
export interface GlobalHotkeyMeta {
  action: HotkeyAction
  /** 未获取到用户配置时的回退展示值 */
  fallbackKeys: string
  /** 动作描述 */
  actionText: string
  note?: string
}

/** 固定展示的全局热键（toggleVoice / toggleAiAssets 默认无键位，配置后运行时追加展示） */
export const GLOBAL_HOTKEY_META: GlobalHotkeyMeta[] = [
  { action: 'toggleMainWindow', fallbackKeys: 'Alt + Space', actionText: '呼出/隐藏主窗口' },
  { action: 'toggleDetachedWindows', fallbackKeys: 'Alt + Q', actionText: '打开进阶面板' },
  {
    action: 'backgroundVoice',
    fallbackKeys: 'Alt + V',
    actionText: '后台语音录入（按住说话，松开发送）',
  },
]

/** accelerator 'Alt+Space' → 'Alt + Space'（统一展示格式） */
export function formatAcc(acc: string): string {
  return acc
    .split('+')
    .map((p) => p.trim())
    .join(' + ')
}
