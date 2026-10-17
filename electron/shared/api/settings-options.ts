// settings-options.ts — 顶栏按钮组与侧边菜单入口的取值定义（无运行时依赖）
//
// 这些常量只描述"哪些项可被用户显式开关"，不依赖 Electron、store 或窗口行为。
// 单独放在此叶子模块，使默认设置与设置校验可以引用取值而不引入运行时行为。

/** 顶栏可显隐的按钮组标识（appSwitcher/menu/刷新始终显示，不在此列） */
export type TopBarButtonGroup =
  | 'uaToggle'
  | 'navBack'
  | 'navForward'
  | 'navHome'
  | 'themeToggle'
  | 'pinToggle'

/** 全部可自定义的顶栏按钮组（默认全选；appSwitcher/menu/刷新始终显示） */
export const ALL_TOP_BAR_BUTTON_GROUPS: TopBarButtonGroup[] = [
  'uaToggle',
  'navBack',
  'navForward',
  'navHome',
  'themeToggle',
  'pinToggle',
]

/** 主窗口侧边菜单可显隐的入口 */
export type DrawerMenuItem =
  | 'advancedPanel'
  | 'promptLibrary'
  | 'settings'
  | 'network'
  | 'modules'
  | 'manage'
  | 'backup'
  | 'logs'
  | 'detach'
  | 'onboarding'
  | 'shortcuts'
  | 'themeToggle'

/** 设置窗口左侧导航分类（与 SettingsView 的 CategoryId 一致） */
export type SettingsCategory =
  | 'appearance'
  | 'ai'
  | 'voice'
  | 'network'
  | 'advanced'
  | 'modules'
  | 'developer'
  | 'about'

/** 全部侧边菜单入口（默认全选） */
export const ALL_DRAWER_MENU_ITEMS: DrawerMenuItem[] = [
  'advancedPanel',
  'promptLibrary',
  'settings',
  'network',
  'modules',
  'manage',
  'backup',
  'logs',
  'detach',
  'onboarding',
  'shortcuts',
  'themeToggle',
]
