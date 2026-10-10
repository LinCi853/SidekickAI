export type RuntimeProcessRole = 'main' | 'interface' | 'webpage' | 'renderer' | 'gpu' | 'network' | 'audio' | 'video' | 'utility' | 'other'

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
  memoryBytes: number | null
}

export interface RuntimeProcessSnapshot {
  capturedAt: number
  processes: RuntimeProcess[]
}

export interface RuntimeProcessesAPI {
  get(): Promise<RuntimeProcessSnapshot>
}
