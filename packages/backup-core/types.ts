export type BackupEdition = 'concept' | 'community'
export type ImportMode = 'full' | 'limited'
export interface BackupOptions { basicData: boolean; cookies: boolean; indexedDB: boolean; cache: boolean }
export interface CookieSnapshot { path: string; cookies: Electron.Cookie[] }
export interface BackupManifest {
  format: 'sidekickai-backup'
  formatVersion: 1
  deviceId: string
  appVersion: string
  exportedAt: string
  options: BackupOptions
  entries: Record<string, string>
  cookieSnapshots?: CookieSnapshot[]
  edition?: BackupEdition
  dataSchemaVersion?: number
  legacy?: boolean
  restoreMode?: ImportMode
}
export interface BackupInspection {
  success: boolean
  mode?: ImportMode
  message?: string
  reason?: 'same-edition' | 'cross-edition' | 'data-schema' | 'unidentified'
  encrypted?: boolean
  error?: string
  fingerprint?: string
}
export interface ImportDecision { mode: ImportMode; reason: NonNullable<BackupInspection['reason']>; message: string }
export const DATA_SCHEMA_VERSION = 1
