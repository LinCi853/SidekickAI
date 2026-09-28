// electron/store/session-dirs.ts — session 目录分类与体积统计工具
//
// 从 backup-restore.ts 拆出的共享底座：Partitions/<id>/（及数据目录根级）
// 各存储子目录的分类常量（登录凭据 / 应用数据 / 离线缓存）与文件系统体积统计。
// backup-restore（导出打包）与 cache-maintenance（缓存清理）共用。

import * as fs from 'fs';
import * as path from 'path';
import { getStoreCwd } from './store-paths.js';

/** 登录凭据：Cookies 文件 */
export const PARTITION_COOKIE_FILES = ['Cookies'];

/** 登录凭据：Local Storage 目录 */
export const PARTITION_COOKIE_DIRS = ['Local Storage'];

/** 应用数据：IndexedDB 目录 */
export const PARTITION_INDEXEDDB_DIRS = ['IndexedDB'];

/** Partitions/<id>/ 下属于「离线缓存」的目录（可安全排除，不影响登录态） */
export const PARTITION_CACHE_DIRS = [
  'Service Worker',
  'File System',
  'Cache',
  'Code Cache',
  'GPUCache',
  'blob_storage',
];

/** 递归计算目录总体积（字节） */
export function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else if (entry.isFile()) {
        try {
          size += fs.statSync(fullPath).size;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return size;
}

/** 获取数据目录路径 */
export function getDataDir(): string {
  return getStoreCwd();
}

/**
 * 对一个 session 基础目录（Partitions/<id>/ 或 数据目录根）统计三类 session 体积。
 * 同一套分类常量同时覆盖各 profile session 与默认 session，避免根级存储被遗漏。
 * @param basePath session 根目录绝对路径
 */
export function collectSessionSizesFromBase(basePath: string): {
  cookies: number;
  indexedDB: number;
  cache: number;
} {
  let cookies = 0;
  let indexedDB = 0;
  let cache = 0;
  // 登录凭据：Cookies 文件 + Local Storage 目录
  for (const fileName of PARTITION_COOKIE_FILES) {
    const filePath = path.join(basePath, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) cookies += stat.size;
      } catch { /* ignore */ }
    }
  }
  for (const dirName of PARTITION_COOKIE_DIRS) {
    const dirPath = path.join(basePath, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      cookies += getDirSize(dirPath);
    }
  }
  // 应用数据：IndexedDB 目录
  for (const dirName of PARTITION_INDEXEDDB_DIRS) {
    const dirPath = path.join(basePath, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      indexedDB += getDirSize(dirPath);
    }
  }
  // 离线缓存：Service Worker / Cache 等目录
  for (const dirName of PARTITION_CACHE_DIRS) {
    const dirPath = path.join(basePath, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      cache += getDirSize(dirPath);
    }
  }
  return { cookies, indexedDB, cache };
}
