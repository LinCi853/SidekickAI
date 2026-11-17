// save-dialog.types.ts — 应用自建保存弹窗共享类型
//
// 另存为不再使用系统原生对话框，改由应用自己的弹窗承接：
// 主进程发起保存请求，渲染层弹出自建弹窗，用户可在此把当前目录设为默认
// 保存位置（之后同类保存不再弹出弹窗）。

/** 文件类型过滤项 */
export interface SaveDialogFilter {
  name: string
  extensions: string[]
}

/** 保存请求（主进程 → 渲染层） */
export interface SaveDialogRequest {
  /** 请求 id，渲染层回执时带回 */
  requestId: string
  /** 弹窗标题，如“另存为” */
  title: string
  /** 建议文件名（不含目录） */
  fileName: string
  /** 当前目录（绝对路径） */
  directory: string
  /** 文件类型过滤 */
  filters: SaveDialogFilter[]
}

/** 保存结果（渲染层 → 主进程） */
export interface SaveDialogReply {
  action: 'save' | 'cancel'
  /** action='save' 时：用户填写的文件名（不含目录） */
  fileName?: string
  /** action='save' 时：用户选择的目录 */
  directory?: string
  /** 是否把该目录记为默认保存位置（之后不再弹出弹窗） */
  remember?: boolean
}

/** 主进程侧最终结果 */
export interface SaveDialogOutcome {
  action: 'save' | 'cancel'
  /** action='save' 时的完整目标路径 */
  filePath?: string
  /** 是否已把该目录记为默认保存位置 */
  remember: boolean
}
