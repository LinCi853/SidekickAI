// installer/src/renderer/global.d.ts
// window.installer 的类型声明（由 api.ts 注入）

import type { InstallFeature, InstallOption, LicenseDoc } from './install-manifest'

export type InstallMode = 'install' | 'repair' | 'uninstall'

export interface InstallOptions {
  installDir: string
  forAllUsers: boolean
  createDesktopShortcut: boolean
  launchAfterInstall: boolean
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
  /** 已同意的协议 id */
  acceptedLicenses?: string[]
}

export interface InstallLocation {
  path: string
  source: string
  version: string
  arch: string
  registered: boolean
  runningPid: number
  recommendedForCleanup: boolean
}

export interface ScanResult {
  locations: InstallLocation[]
  recommendedDir: string
  residualHint: string
  fixedDrives: string[]
}

export interface InstallerInfo {
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

declare global {
  interface Window {
    installer: {
      getInfo(): Promise<InstallerInfo>
      scanInstallations(): Promise<ScanResult>
      browseDir(current: string): Promise<string>
      needsAdmin(dir: string, forAllUsers: boolean): Promise<boolean>
      start(opts: InstallOptions): Promise<boolean>
      cancel(): Promise<boolean>
      closeWindow(): Promise<void>
      openDir(dir: string): Promise<void>
      onStatus(cb: (msg: string) => void): () => void
      onProgress(cb: (p: number) => void): () => void
      onDone(cb: (payload: DonePayload) => void): () => void
      onError(cb: (msg: string) => void): () => void
    }
  }
}

export {}
