// shortcut-registry.types.ts — 统一快捷键注册类型定义
//
// C1（统一快捷键注册组件）的类型抽象层，主进程与渲染进程共享。
//
// 明确三档作用域：
//   - global            全局快捷键（系统级，应用未聚焦也生效，走 globalShortcut）
//   - window-while-open 窗口打开时生效（窗口关闭后自动注销）
//   - in-window-global  窗口内全局（不受焦点影响，窗口内任意位置按键均触发）

/** 快捷键作用域 */
export type ShortcutScope = 'global' | 'window-while-open' | 'in-window-global'

/** 快捷键注册项 */
export interface ShortcutRegistration {
  /** 唯一 id */
  id: string
  /** 加速器（如 'Ctrl+T'、'F11'） */
  accelerator: string
  /** 作用域 */
  scope: ShortcutScope
  /** 是否启用 */
  enabled: boolean
  /** 描述（用于设置 UI） */
  description: string
  /** 分组（用于设置 UI 分类） */
  group?: string
}

/** 浏览器窗口快捷键配置项（用户可自定义） */
export interface BrowserWindowShortcut extends ShortcutRegistration {
  /** 是否为全局快捷键（true=注册到系统 globalShortcut，false=仅窗口内生效） */
  isGlobal: boolean
}
