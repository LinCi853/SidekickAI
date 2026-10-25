export type RuntimeProcessRole =
  | 'main'
  | 'interface'
  | 'webpage'
  | 'renderer'
  | 'mixed'
  | 'gpu'
  | 'network'
  | 'audio'
  | 'video'
  | 'utility'
  | 'other'

export interface RuntimeProcessTarget {
  webContentsId: number
  kind: 'window' | 'webpage' | 'subframe'
  title: string
  windowTitle: string
}

export interface RuntimeProcess {
  pid: number
  creationTime: number
  role: RuntimeProcessRole
  name: string
  targets: RuntimeProcessTarget[]
  cpuPercent: number | null
  /**
   * 专用工作集（Windows 任务管理器「内存」列口径）字节数。
   * 查询失败时回退为 Electron workingSetSize×1024（含共享页，会偏高）。
   */
  memoryBytes: number | null
}

export interface RuntimeProcessSnapshot {
  capturedAt: number
  /** app.getAppMetrics() 返回的 Electron 进程，不包括额外派生的原生助手。 */
  processes: RuntimeProcess[]
}

export interface RuntimeProcessesAPI {
  get(): Promise<RuntimeProcessSnapshot>
  syncPriority(payload: TabPrioritySync): Promise<boolean>
}

/** 各窗口当前激活与受保护标签，供主进程调整 guest 优先级。 */
export interface TabPrioritySync {
  windowId: string
  activeTabId: string | null
  audibleTabIds?: string[]
}
