import * as fs from 'fs';
import { sha256FileSync, exportTreeDigest } from '../../../packages/backup-core/files.js';
import { selectedCategoryKeys, collectEntryCategories } from './collect.js';
import type { ExportCategory, ExportOptions, SelectedExportEntry } from './types.js';

/** Re-inventory the selection and reject any addition, removal, or byte change. */
export function verifyQuiescentSnapshot(
  sourceEntries: Record<string, string>,
  before: SelectedExportEntry[],
  after: SelectedExportEntry[],
): void {
  const beforePaths = new Set(before.map((entry) => entry.archivePath))
  const afterPaths = new Set(after.map((entry) => entry.archivePath))
  for (const archivePath of afterPaths) {
    if (!beforePaths.has(archivePath)) throw new Error(`Selected source data changed during export (added): ${archivePath}`)
  }
  for (const archivePath of beforePaths) {
    if (!afterPaths.has(archivePath)) throw new Error(`Selected source data changed during export (removed): ${archivePath}`)
  }
  for (const entry of after) {
    if (sourceEntries[entry.archivePath] !== sha256FileSync(entry.sourcePath)) {
      throw new Error(`Selected source file changed during export: ${entry.archivePath}`)
    }
  }
}

/**
 * Reject any complete-tree change since the exporter-time snapshot. Unlike the
 * selected inventory this also sees files the backup categories omit, so a file
 * added to a *selected* directory after the snapshot cannot be published as
 * verified and later deleted without being archived.
 */
export function verifyExportTreeUnchanged(dataDir: string, expected: string): void {
  const actual = exportTreeDigest(dataDir)
  if (actual !== expected) {
    throw new Error('Selected source data changed during export (complete data tree digest mismatch)')
  }
}

/**
 * Report a selected category as covered when it contributed entries or when it
 * is legitimately empty. A category whose every entry was skipped is not
 * covered, so the result never claims data that failed to read.
 */
export function reportedCategories(
  options: ExportOptions,
  entries: SelectedExportEntry[],
  skippedFiles: string[],
): ExportCategory[] {
  const skipped = new Set(skippedFiles)
  const withEntries = collectEntryCategories(entries)
  return selectedCategoryKeys(options).filter((category) => {
    if (!withEntries.has(category)) return true
    return entries.some((entry) => entry.category === category && !skipped.has(entry.archivePath))
  })
}
