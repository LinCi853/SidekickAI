import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_FILES, ASSET_DIRS } from './constants.js'
import { getDataDir, getDirSize, collectSessionSizesFromBase } from '../session-dirs.js'
import { collectPluginExtraFiles } from './collect.js'
import type { ExportSizeEstimate } from './types.js'
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


export async function estimateExportSizes(): Promise<ExportSizeEstimate> {
  const dataDir = getDataDir();
  let basicDataSize = 0;
  let cookiesSize = 0;
  let indexedDBSize = 0;
  let cacheSize = 0;

  
  const pluginExtra = await collectPluginExtraFiles(false)
  const allBackupFiles = [...BACKUP_FILES]
  for (const db of pluginExtra.dbFiles) {
    allBackupFiles.push(db, db + '-wal', db + '-shm')
  }
  for (const fileName of allBackupFiles) {
    const filePath = path.join(dataDir, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) basicDataSize += stat.size;
      } catch { /* ignore */ }
    }
  }
  
  const allAssetDirs = [...ASSET_DIRS, ...pluginExtra.assetDirs]
  for (const dirName of allAssetDirs) {
    const dirPath = path.join(dataDir, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      basicDataSize += getDirSize(dirPath);
    }
  }

  
  const partitionsDir = path.join(dataDir, 'Partitions');
  if (fs.existsSync(partitionsDir) && fs.statSync(partitionsDir).isDirectory()) {
    try {
      const partitionEntries = fs.readdirSync(partitionsDir, { withFileTypes: true });
      for (const entry of partitionEntries) {
        if (!entry.isDirectory()) continue;
        const partitionPath = path.join(partitionsDir, entry.name);
        const sizes = collectSessionSizesFromBase(partitionPath);
        cookiesSize += sizes.cookies;
        indexedDBSize += sizes.indexedDB;
        cacheSize += sizes.cache;
      }
    } catch { /* ignore */ }
  }

  
  
  const defaultSessionSizes = collectSessionSizesFromBase(dataDir);
  cookiesSize += defaultSessionSizes.cookies;
  indexedDBSize += defaultSessionSizes.indexedDB;
  cacheSize += defaultSessionSizes.cache;

  return {
    basicData: basicDataSize,
    cookies: cookiesSize,
    indexedDB: indexedDBSize,
    cache: cacheSize,
    voiceAssets: 0, 
    total: 0, 
  };
}
