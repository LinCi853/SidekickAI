export type BackupEdition = 'concept' | 'community'
export type ImportMode = 'full' | 'limited'
export interface ImportReportItem { category: string; id?: string; reason?: string }
export interface ImportReport { imported: ImportReportItem[]; skipped: ImportReportItem[]; warnings: string[] }
export interface BackupOptions { basicData: boolean; cookies: boolean; indexedDB: boolean; cache: boolean }
export interface CookieSnapshot { path: string; cookies: Electron.Cookie[] }
export interface SensitiveDraftTransport { version: 1; entries: Array<{ key: string; sourceSha256: string; state: 'portable'; value: unknown } | { key: string; sourceSha256: string; state: 'unavailable'; reason: 'source-key-unavailable' }> }
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
  jobId?: string
  snapshotId?: string
  snapshotAt?: string
  inventory?: Array<{ path: string; size: number; sha256: string; state: 'verified' }>
  cookieTransfer?: 'portable-snapshot' | 'raw-profile'
  importReport?: ImportReport
  sensitiveDrafts?: SensitiveDraftTransport
}
export interface BackupInspection {
  success: boolean
  mode?: ImportMode
  message?: string
  reason?: 'same-edition' | 'cross-edition' | 'data-schema' | 'unidentified'
  encrypted?: boolean
  error?: string
  fingerprint?: string
  report?: ImportReport
}
export interface ImportDecision { mode: ImportMode; reason: NonNullable<BackupInspection['reason']>; message: string }
export const DATA_SCHEMA_VERSION = 1
