// electron/shared/module-manifest.types.ts — 模块管理（插件系统）共享类型
//
// 模块 manifest 与状态的类型定义。主进程注册表（electron/modules/registry.ts）、
// 状态存储（electron/store/module-state-store.ts）与渲染层设置页共用。
// 设计规范见 docs/功能插件系统与安装管控方案.md 第 8、11 章。

/** 模块分类：stable=插件市场（稳定）/ dev=开发者选项（实验性，默认关闭 + 测试标签）/ plugin=功能插件 */
export type ModuleCategory = 'stable' | 'dev' | 'plugin'

/**
 * 进阶面板 tab 标识。内置 tab：chat / whiteboard / notes；插件可扩展。
 */
export type AdvancedPanelTabKey = string

/** 体积级别：large=大模块（>10MB，安装期可选）/ small=小模块（≤10MB，恒安装） */
export type ModuleSizeLevel = 'large' | 'small'

/** 模块状态行（settings.db 的 module_state 表） */
export interface ModuleStateRow {
  /** 模块 id（manifest.id） */
  id: string
  /** 是否启用（0/1） */
  enabled: number
  /** 是否已安装到磁盘（仅 large 模块可能为 0；small 恒为 1） */
  installed: number
  /** 最近一次「清除数据」时间戳（ms），0=从未清除 */
  cleared_at: number
  /** 更新时间戳（ms） */
  updated_at: number
}

/** 渲染层可见的模块信息（含动态状态） */
export interface ModuleInfo {
  id: string
  name: string
  description: string
  category: ModuleCategory
  sizeLevel: ModuleSizeLevel
  /** 是否显示「测试」标签（开发者选项内必为 true；开发者选项外的测试功能同样可标） */
  testBadge: boolean
  defaultEnabled: boolean
  /** 硬依赖模块 id 列表：依赖模块关闭时本模块级联关闭（如 TTS → custom-chat） */
  dependencies: string[]
  /** 入口位置描述（人类可读，设置页展示用） */
  entries: string[]
  /** 启用时注册的热键描述（人类可读，设置页展示用） */
  hotkeys: string[]
  /** 当前是否启用 */
  enabled: boolean
  /** 当前是否已安装（false 时设置页置灰 + 「重新运行安装包补装」） */
  installed: boolean
  /** 进阶面板 tab 声明（可选，渲染层用于动态 tab 注册） */
  advancedPanelTab?: { key: string; label: string }
}

/**
 * 副作用类型枚举（与 modules/effect-scope.ts 的 EffectKind 保持一致）。
 * 在 shared 层定义避免循环依赖，modules 层 re-export。
 */
export type EffectKind =
  | 'ipc'
  | 'hotkey'
  | 'window'
  | 'webview-script'
  | 'webview-css'
  | 'debugger'
  | 'event-sub'
  | 'timer'
  | 'renderer-ui'

/** 能力作用范围 */
export type CapabilityScope =
  | 'global'
  | 'window'
  | 'profile'
  | 'tab'
  | 'webview'
  | 'document'

/** 能力触发时机 */
export type CapabilityTrigger =
  | 'startup'
  | 'window-created'
  | 'page-navigate'
  | 'user-command'
  | 'manual'

/**
 * 功能贡献声明（manifest 级别，供注册表和渲染层使用）。
 * 模块是用户可见的开关单位，能力是实际可控制的最小单位。
 */
export interface CapabilityRef {
  /** 所属模块 id */
  ownerModule: string
  /** 能力唯一标识，如 'freeze.debugger' */
  capabilityId: string
  /** 主要副作用类型 */
  kind: EffectKind
  /** 作用范围 */
  scope: CapabilityScope
  /** 依赖的其他 capability id 或模块 id */
  dependencies?: string[]
  /** 触发时机 */
  trigger: CapabilityTrigger
  /** 是否可撤销 */
  reversible: boolean
  /** 未来插件权限标签 */
  permission?: string
  /** 人类可读描述 */
  description?: string
}

/** 模块 manifest（主进程内部注册声明） */
export interface ModuleManifest {
  /** 稳定标识（小写 kebab-case） */
  id: string
  /** 展示名 */
  name: string
  /** 功能描述（设置页展示） */
  description: string
  /** 分类 */
  category: ModuleCategory
  /** 体积级别 */
  sizeLevel: ModuleSizeLevel
  /** 是否显示「测试」标签 */
  testBadge: boolean
  /** 初始启用状态（首次启动默认；大模块表示安装器默认勾选） */
  defaultEnabled: boolean
  /** 硬依赖（级联关闭） */
  dependencies: string[]
  /** 入口位置描述 */
  entries: string[]
  /** 启用时注册的热键描述 */
  hotkeys: string[]
  /** 启用回调：只允许注册 IPC/协议/热键/store 等副作用 */
  init?: () => void | Promise<void>
  /** 禁用回调：逆序撤销 init 的全部副作用（11.10 零残留硬保证） */
  teardown?: () => void | Promise<void>
  /** 清除数据回调：删除该模块全部用户数据（不可逆；未实现时设置页不显示清除按钮） */
  clearData?: () => void | Promise<void>
  /** 本模块拥有的能力声明（统一注入管线扩展，可选） */
  capabilities?: CapabilityRef[]

  // === 进阶面板 tab 声明（可选） ===
  /** 声明本模块在进阶面板中注册的 tab（key + label） */
  advancedPanelTab?: {
    /** tab 标识（如 'tasks'、'timer'） */
    key: string
    /** tab 显示名（如 '任务'、'计时'） */
    label: string
  }

  // === 数据生命周期声明（可选，用于备份/清除自动化） ===
  /** 本模块使用的 SQLite 数据库文件名（不含路径，如 ['kanban.db']） */
  dbFiles?: string[]
  /** 本模块使用的资产目录名（不含路径，如 ['kanban-assets']） */
  assetDirs?: string[]
  /** 关闭本模块的数据库连接（清除数据/导出备份前调用） */
  closeDb?: () => void | Promise<void>
}

/** 模块状态变更广播载荷（主 → 所有窗口渲染层） */
export interface ModuleStateChangedPayload {
  /** 完整模块信息列表（与 MODULE_LIST 返回一致） */
  modules: ModuleInfo[]
}
