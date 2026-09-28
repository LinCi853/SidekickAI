// electron/store/cache-maintenance.ts — 缓存体积估算与清理
//
// 从 backup-restore.ts 拆出的缓存维护职责：仅清理离线缓存类目录
// （Service Worker / Cache / Code Cache / GPUCache / blob_storage / File System + Crashpad），
// 保留登录态与本地数据。存储分类常量与体积统计见 session-dirs.ts。

import { session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { profileStore } from './profile-store.js';
import { formatBytes } from './backup-restore.js';
import {
  PARTITION_CACHE_DIRS,
  getDataDir,
  getDirSize,
} from './session-dirs.js';

/**
 * 估算当前缓存总体积（字节）。
 * 遍历 <dataDir>/ 根与 <dataDir>/Partitions/<id>/ 下的所有缓存子目录
 * （PARTITION_CACHE_DIRS：Service Worker / Cache / Code Cache / GPUCache / blob_storage / File System），
 * 不读取文件内容，仅 stat 累加。Crashpad 也按缓存处理（Chromium 崩溃转储，可安全清理）。
 */
export function estimateCacheSize(): number {
  const dataDir = getDataDir();
  let total = 0;

  // 辅助：统计一个基础目录下的缓存子目录总体积
  const sumCacheDirs = (basePath: string): number => {
    let size = 0;
    for (const dirName of PARTITION_CACHE_DIRS) {
      const dirPath = path.join(basePath, dirName);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        size += getDirSize(dirPath);
      }
    }
    // Crashpad 也视为缓存（Chromium 崩溃转储目录，可安全清理）
    const crashpadPath = path.join(basePath, 'Crashpad');
    if (fs.existsSync(crashpadPath) && fs.statSync(crashpadPath).isDirectory()) {
      size += getDirSize(crashpadPath);
    }
    return size;
  };

  // 默认 session（数据目录根级）
  total += sumCacheDirs(dataDir);

  // 各 profile session
  const partitionsDir = path.join(dataDir, 'Partitions');
  if (fs.existsSync(partitionsDir) && fs.statSync(partitionsDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(partitionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        total += sumCacheDirs(path.join(partitionsDir, entry.name));
      }
    } catch { /* ignore */ }
  }

  return total;
}

/**
 * 清理缓存数据（仅缓存类目录与 session cache，保留登录态）。
 *
 * 清理流程：
 *   1. 调用 estimateCacheSize() 记录清理前体积
 *   2. 收集所有 session：defaultSession + persist:<profileId> partitions
 *   3. 每个 session 依次调用：
 *      - clearCache()：HTTP 缓存
 *      - clearAuthCache()：认证缓存
 *      - clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })：仅清 SW 与 Cache API
 *      （明确不传 cookies/localstorage/indexeddb/localfilesystem 等，保留登录态与本地数据）
 *   4. 磁盘兜底：递归删除 PARTITION_CACHE_DIRS 内每个子目录 + Crashpad
 *      （处理 session API 未覆盖的 GPUCache/Crashpad 等），对 <dataDir>/ 根与每个 Partitions/<id>/ 都执行
 *   5. 返回 { cleanedBytes }
 *
 * 注意：调用前需确保所有 webview 的关键页面上已加载完成（避免清理 SW 导致当前会话异常）。
 * 若 webview 正在使用，清理后下次导航会重新生成缓存，无副作用。
 */
export async function cleanCacheData(): Promise<{ cleanedBytes: number }> {
  const dataDir = getDataDir();
  const cleanedBytes = estimateCacheSize();
  console.log('[cache-maintenance] 开始清理缓存，当前体积:', formatBytes(cleanedBytes));

  // 1. 收集所有 session
  const sessionsToClean: Electron.Session[] = [session.defaultSession];
  try {
    for (const profile of profileStore.list()) {
      try {
        sessionsToClean.push(session.fromPartition(`persist:${profile.id}`));
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[cache-maintenance] 收集 partition sessions 失败:', err);
  }

  // 2. 调用 session API 清理（仅缓存类）
  await Promise.all(
    sessionsToClean.map(async (s) => {
      try { await s.clearCache(); } catch { /* ignore */ }
      try { await s.clearAuthCache(); } catch { /* ignore */ }
      try {
        await s.clearStorageData({
          storages: ['serviceworkers', 'cachestorage'],
        });
      } catch { /* ignore */ }
    }),
  );

  // 3. 磁盘兜底：删除缓存子目录 + Crashpad
  const allCacheDirNames = [...PARTITION_CACHE_DIRS, 'Crashpad'];
  const cleanBase = (basePath: string) => {
    for (const dirName of allCacheDirNames) {
      const dirPath = path.join(basePath, dirName);
      try {
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch (err) {
        // 单个目录删除失败不阻塞（可能被进程占用），下次清理会重试
        console.warn(`[cache-maintenance] 删除缓存目录失败: ${dirPath}`, err);
      }
    }
  };

  // 默认 session（数据目录根级）
  cleanBase(dataDir);
  // 各 profile session
  const partitionsDir = path.join(dataDir, 'Partitions');
  if (fs.existsSync(partitionsDir) && fs.statSync(partitionsDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(partitionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        cleanBase(path.join(partitionsDir, entry.name));
      }
    } catch { /* ignore */ }
  }

  console.log('[cache-maintenance] 缓存清理完成，已清理:', formatBytes(cleanedBytes));
  return { cleanedBytes };
}
