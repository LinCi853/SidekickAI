import * as fs from 'fs';
import * as path from 'path';

import { BACKUP_FILES, ASSET_DIRS, PARTITION_COOKIE_FILES, PARTITION_COOKIE_DIRS, PARTITION_INDEXEDDB_DIRS, PARTITION_CACHE_DIRS } from './constants.js';
import { assertRealDataRoot, resolveDataRootEntry, inspectSelectedPath, lstatSelected } from './paths.js';
import type { ExportCategory, ExportOptions, SelectedExportEntry } from './types.js';

/**
 * Collect the extra backup files declared by plugins (lazy import avoids a
 * circular dependency). Strict mode must not silently omit a declaration, so a
 * read failure aborts the export.
 */
export async function collectPluginExtraFiles(strict: boolean): Promise<{ dbFiles: string[]; assetDirs: string[] }> {
  try {
    const { collectModuleDataFiles } = await import('../../modules/registry.js')
    return collectModuleDataFiles()
  } catch (error) {
    if (strict) throw new Error(`Plugin data declarations could not be read: ${(error as Error).message}`)
    return { dbFiles: [], assetDirs: [] }
  }
}

export function selectedCategoryKeys(options: ExportOptions): ExportCategory[] {
  const keys: ExportCategory[] = []
  if (options.basicData) keys.push('basicData')
  if (options.cookies) keys.push('cookies')
  if (options.indexedDB) keys.push('indexedDB')
  if (options.cache) keys.push('cache')
  return keys
}

export function collectEntryCategories(entries: SelectedExportEntry[]): Set<ExportCategory> {
  const categories = new Set<ExportCategory>()
  for (const entry of entries) categories.add(entry.category)
  return categories
}

export function addSelectedFile(
  entries: SelectedExportEntry[],
  dataDir: string,
  sourcePath: string,
  archivePath: string,
  category: ExportCategory,
  strict: boolean,
): void {
  if (!inspectSelectedPath(dataDir, sourcePath, archivePath, 'file', strict)) return
  entries.push({ category, sourcePath, archivePath })
}

export function addSelectedDirectory(
  entries: SelectedExportEntry[],
  dataDir: string,
  sourcePath: string,
  archivePath: string,
  category: ExportCategory,
  strict: boolean,
): void {
  if (!inspectSelectedPath(dataDir, sourcePath, archivePath, 'directory', strict)) return
  walkSelectedDirectory(entries, sourcePath, archivePath, category, strict)
}

export function walkSelectedDirectory(
  entries: SelectedExportEntry[],
  directory: string,
  archiveBase: string,
  category: ExportCategory,
  strict: boolean,
): void {
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name)
    const archivePath = `${archiveBase}/${name}`
    const stat = lstatSelected(child, archivePath, strict)
    if (!stat) {
      // readdirSync listed the entry, so ENOENT here means it vanished mid-walk.
      if (strict) throw new Error(`Selected source file disappeared during export: ${archivePath}`)
      continue
    }
    if (stat.isSymbolicLink()) {
      if (strict) throw new Error(`Backup selection contains a symbolic link or junction: ${archivePath}`)
      continue
    }
    if (stat.isDirectory()) walkSelectedDirectory(entries, child, archivePath, category, strict)
    else if (stat.isFile()) entries.push({ category, sourcePath: child, archivePath })
    else if (strict) throw new Error(`Selected backup entry is not a regular file: ${archivePath}`)
  }
}

/** Collect one session base directory using the shared category constants. */
export function collectSessionEntries(
  entries: SelectedExportEntry[],
  dataDir: string,
  basePath: string,
  prefix: string,
  options: ExportOptions,
  strict: boolean,
): void {
  const entryPrefix = prefix ? `${prefix}/` : ''
  if (options.cookies) {
    for (const name of PARTITION_COOKIE_FILES) addSelectedFile(entries, dataDir, path.join(basePath, name), `${entryPrefix}${name}`, 'cookies', strict)
    for (const name of PARTITION_COOKIE_DIRS) addSelectedDirectory(entries, dataDir, path.join(basePath, name), `${entryPrefix}${name}`, 'cookies', strict)
  }
  if (options.indexedDB) {
    for (const name of PARTITION_INDEXEDDB_DIRS) addSelectedDirectory(entries, dataDir, path.join(basePath, name), `${entryPrefix}${name}`, 'indexedDB', strict)
  }
  if (options.cache) {
    for (const name of PARTITION_CACHE_DIRS) addSelectedDirectory(entries, dataDir, path.join(basePath, name), `${entryPrefix}${name}`, 'cache', strict)
  }
}

/** Keep the first entry per archive path so overlapping declarations cannot duplicate zip entries. */
export function dedupeSelectedEntries(entries: SelectedExportEntry[]): SelectedExportEntry[] {
  const byArchivePath = new Map<string, SelectedExportEntry>()
  for (const entry of entries) {
    if (!byArchivePath.has(entry.archivePath)) byArchivePath.set(entry.archivePath, entry)
  }
  return [...byArchivePath.values()]
}

/**
 * Build the single authoritative list of selected source files. Both the
 * archive writer and sourceEntries consume this list, so categories are
 * classified exactly once and plugin declarations cannot escape the data root.
 */
export async function collectSelectedExportEntries(
  dataDir: string,
  options: ExportOptions,
  strict: boolean,
): Promise<SelectedExportEntry[]> {
  assertRealDataRoot(dataDir, strict)
  const entries: SelectedExportEntry[] = []
  if (options.basicData) {
    const pluginExtra = await collectPluginExtraFiles(strict)
    const dbFiles = new Set<string>(BACKUP_FILES)
    for (const file of BACKUP_FILES) if (file.endsWith('.db')) dbFiles.add(`${file}-journal`)
    for (const declared of pluginExtra.dbFiles) {
      dbFiles.add(declared)
      dbFiles.add(declared + '-wal')
      dbFiles.add(declared + '-shm')
      dbFiles.add(declared + '-journal')
    }
    for (const declared of dbFiles) {
      const { sourcePath, archivePath } = resolveDataRootEntry(dataDir, declared)
      addSelectedFile(entries, dataDir, sourcePath, archivePath, 'basicData', strict)
    }
    const assetDirs = new Set<string>([...ASSET_DIRS, ...pluginExtra.assetDirs])
    for (const declared of assetDirs) {
      const { sourcePath, archivePath } = resolveDataRootEntry(dataDir, declared)
      addSelectedDirectory(entries, dataDir, sourcePath, archivePath, 'basicData', strict)
    }

  }

  const wantSession = options.cookies || options.indexedDB || options.cache
  if (wantSession) {
    if (options.cookies) addSelectedFile(entries, dataDir, path.join(dataDir, 'Local State'), 'Local State', 'cookies', strict)
    const partitionsDir = path.join(dataDir, 'Partitions')
    if (inspectSelectedPath(dataDir, partitionsDir, 'Partitions', 'directory', strict)) {
      for (const name of fs.readdirSync(partitionsDir)) {
        const partitionPath = path.join(partitionsDir, name)
        const partitionArchive = `Partitions/${name}`
        if (!inspectSelectedPath(dataDir, partitionPath, partitionArchive, 'directory', strict)) continue
        collectSessionEntries(entries, dataDir, partitionPath, partitionArchive, options, strict)
      }
    }
    collectSessionEntries(entries, dataDir, dataDir, '', options, strict)
  }
  return dedupeSelectedEntries(entries)
}
