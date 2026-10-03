// installer/src/renderer/global.d.ts
// window.installer 的类型声明（由 api.ts 注入）

import type { InstallFeature, InstallOption, LicenseDoc } from './install-manifest'

export type InstallMode = 'install' | 'repair' | 'uninstall'

export interface InstallOptions {
  resources?: InstallationResourceStatus[]
  installDir: string
  forAllUsers: boolean
  createDesktopShortcut: boolean
  launchAfterInstall: boolean
  /** 安装完成后打开使用指南（首次启动引导窗）；默认不勾选 */
  showGuideAfterInstall: boolean
  /** 功能开关（moduleId → enabled） */
  features: Record<string, boolean>
  /** 安装选项（optionId → value） */
  options: Record<string, boolean | string>
  /** 安装模式；缺省 = install */
  mode?: InstallMode
  /** 用户确认要清理的其他安装位置 */
  cleanupPaths?: string[]
  /** 卸载时是否删除用户数据 */
  deleteUserData?: boolean
  /** 卸载数据策略：keep（保留默认）/ export（导出加密备份后删除）/ delete（直接删除） */
  dataStrategy?: 'keep' | 'export' | 'delete'
  /** dataStrategy=export 时的备份保存路径（.sabackup） */
  backupPath?: string
  /** dataStrategy=export 时的备份密码（backupEncrypt=true 时必填） */
  backupPassword?: string
  /** dataStrategy=export 时是否加密（false = 明文 zip）；默认 true */
  backupEncrypt?: boolean
  /** dataStrategy=export 时的导出类别（basicData/cookies/indexedDB/cache/voiceAssets）；空 = 全量 */
  backupCategories?: string[]
  /** 已同意的协议 id */
  acceptedLicenses?: string[]
  /** 用户在组件页勾选了云端下载 */
  cloudDownload?: boolean
  /** 已解析并通过校验的云端资源（由前端准备，后端原子落盘） */
  cloudAssets?: CloudAssetWire[]
}

/** Wire shape of one verified cloud asset passed to the install engine. */
export interface CloudAssetWire {
  assetId: string
  version: string
  digest: string
  sizeBytes: number
  kind: 'resource-package' | 'distribution'
  destination: string
  payloadJson?: string
  sourcePath?: string
  signedToken?: string
}

export interface InstallationResourceStatus {
  resourceType: string
  status: 'valid' | 'missing' | 'rejected'
  reason?: string
  resourceId?: string
  version?: string
  destination?: string
  digest?: string
  sizeBytes?: number
  signedToken?: string
}

export interface InstallLocation {
  forAllUsers?: boolean
  path: string
  source: string
  version: string
  arch: string
  registered: boolean
  runningPid: number
  recommendedForCleanup: boolean
}

export interface ScanResult {
  otherEditions?: { edition: string; label: string; path: string; version: string | null; arch: string }[]
  otherEditionsWarning?: string
  locations: InstallLocation[]
  recommendedDir: string
  residualHint: string
  fixedDrives: string[]
}

export interface InstallerInfo {
  editionLabel?: string
  uninstallEntry?: boolean
  version: string
  /** 「所有用户」模式默认目录（C:\Program Files\SidekickAI） */
  defaultDir: string
  /** 「仅我」模式默认目录（%LOCALAPPDATA%\Programs\SidekickAI） */
  perUserDefaultDir: string
  appName: string
  arch: 'x64' | 'arm64'
  requiredSpace: string
  licenses: LicenseDoc[]
  features: InstallFeature[]
  options: InstallOption[]
}

export interface DonePayload {
  installDir: string
  residualNote: string
}

/** 预读已安装位置的安装期配置 */
export interface InstalledConfig {
  modules: Record<string, { enabled: boolean }>
  options: Record<string, boolean | string>
}

declare global {
  interface Window {
    installer: {
      getInfo(): Promise<InstallerInfo>
      scanInstallations(): Promise<ScanResult>
      browseDir(current: string): Promise<string>
      needsAdmin(dir: string, forAllUsers: boolean): Promise<boolean>
      /** 保存文件对话框（导出加密备份用）；取消返回空字符串 */
      saveBackupDialog(defaultName: string): Promise<string>
      start(opts: InstallOptions): Promise<boolean>
      beginPreparation(): Promise<boolean>
      endPreparation(): Promise<void>
      beginCompletion(): Promise<boolean>
      endCompletion(): Promise<void>
      /** 读取已安装位置的 install-config.json（覆盖安装/修复时预读作初始值） */
      readInstallConfig(dir: string): Promise<InstalledConfig | null>
      /** 用户完成/关闭向导时写入最终 install-config.json */
      flushConfig(opts: InstallOptions): Promise<boolean>
      /** 完成页最终勾选：更新关闭向导时要启动的程序 */
      setPendingLaunch(installDir: string, launch: boolean, showGuide: boolean): Promise<boolean>
      cancel(): Promise<boolean>
      /** true = the window closed; false = another operation is still busy */
      closeWindow(): Promise<boolean>
      openDir(dir: string): Promise<void>
      openLog(logPath: string): Promise<void>
      onLog(cb: (payload: { text: string; path?: string; error?: string }) => void): () => void
      onStatus(cb: (msg: string) => void): () => void
      onProgress(cb: (p: number) => void): () => void
      onDone(cb: (payload: DonePayload) => void): () => void
      onError(cb: (msg: string) => void): () => void
      onCloseRequested(cb: () => void): () => void
    }
  }
}

export {}
