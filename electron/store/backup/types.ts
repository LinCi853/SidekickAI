
import type { ExportPreparation as CorePreparation, ExportResult as CoreResult } from '../../../packages/backup-core/export.js'

export interface ExportOptions {
  basicData: boolean;    
  cookies: boolean;      
  indexedDB: boolean;    
  cache: boolean;        
}


export interface ExportSizeEstimate {
  basicData: number;
  cookies: number;       // Cookies + Local Storage
  indexedDB: number;     
  cache: number;          
  voiceAssets: number;    
  
  total: number;
}

/** Category keys that may contribute archive entries. Plugin declarations never extend this list. */
export type ExportCategory = 'basicData' | 'cookies' | 'indexedDB' | 'cache' | 'plugins';

/** One selected source file shared by the archive writer and the source manifest. */
export interface SelectedExportEntry {
  category: ExportCategory;
  /** Absolute source path on disk. */
  sourcePath: string;
  /** Archive-relative path using forward slashes. */
  archivePath: string;
}

/** Optional strict contract used by the uninstaller before it deletes user data. */
export interface ExportStrictOptions extends CorePreparation {
  snapshot?: boolean;
  onSnapshotReady?: () => Promise<void>;
  /** Fail-closed export: no skips, no overwrite, verified source inventory. */
  strict?: boolean;
  /** Strict mode only: the data root the caller expects this process to export. */
  expectedDataRoot?: string;
}

export interface ExportResult extends CoreResult {
  success: boolean;
  retryable?: boolean;
  filePath?: string;
  error?: string;
  /** Absolute data root the archive was built from. */
  sourceRoot?: string;
  /** Archive-relative path -> SHA-256 of the source bytes. */
  sourceEntries?: Record<string, string>;
  /** Successful backups contain every selected payload file, so this list is empty. */
  skippedFiles?: string[];
  /** Export options that were actually applied. */
  options?: ExportOptions;
  /** True when the fail-closed uninstaller contract was enforced. */
  strict?: boolean;
  /** Requested categories that are covered by the export (an empty optional category still counts). */
  categories?: string[];
  /**
   * Strict only: SHA-256 of the complete data-tree snapshot taken right after
   * the databases closed (`export-tree-digest-v1`). The runtime host re-derives
   * it before the worker may delete anything, so files added after the export
   * cannot be removed unbacked.
   */
  treeSha256?: string;
}

export interface ImportResult {
  success: boolean;
  error?: string;
  
  encrypted?: boolean;
  
  sourceDeviceId?: string;
}

/** One canonical complete-tree tuple: [UTF8 hex path, kind, length, sha256]. */
export type ExportTreeTuple = [string, 1 | 2, number, string];
