// electron/store/backup-restore.ts — 跨设备数据迁移：导出/导入完整数据
//
// 将应用全部持久化数据打包为 zip 文件，包含：
// - 配置文件：settings.db（Phase 3 迁移后，所有 JSON 设置的单一数据源）
// - 加密密钥：app-key.json（随数据迁移，保证 AES 加密数据可跨设备解密）
// - 对话数据库：chat.db / chat.db-wal / chat.db-shm
// - Session 数据：Partitions/ 目录（cookies/localStorage/IndexedDB，保证登录态迁移）


import { app, session, BrowserWindow, dialog } from 'electron';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { closeChatStore } from './chat-store.js';
import { closeWhiteboardDb } from './whiteboard-db.js';
import { closeNotesDb } from './notes-db.js';
import { closeBookmarkStore } from './bookmark-store.js';
import { closeModuleStateDb } from './module-state-store.js';
import { profileStore } from './profile-store.js';
import { getStoreCwd, isPortableMode } from './store-paths.js';
import { getDeviceId } from './device-id.js';
import { encryptFile, decryptFile, isSabkEncrypted } from '../utils/file-crypto.js';
import { safeExtractAll } from '../utils/safe-zip.js';
import { setImportingData } from './import-guard.js';
import { snapshotSqliteDatabase } from './sqlite-snapshot.js';
import { replaceRestoreEntries, validateRestoreDirectory, RestoreRecoveryError } from './restore-files.js';
import { closeSearchHistoryStore } from './search-history-store.js';
import { closeBrowserDownloadStore } from './browser-download-store.js';
import { closeNavHistoryStore } from './nav-history-store.js';
import { accumulatedLinksStore } from './accumulated-links-store.js';

/** 必须备份的文件列表（相对数据目录） */
const BACKUP_FILES = [
  // ===== settings.db =====
  'settings.db',
  'settings.db-wal',
  'settings.db-shm',
  // ===== SQLite 数据库（各模块数据） =====
  'chat.db',
  'chat.db-wal',
  'chat.db-shm',
  'whiteboard.db',
  'whiteboard.db-wal',
  'whiteboard.db-shm',
  'notes.db',
  'notes.db-wal',
  'notes.db-shm',
  'search-history.db',
  'search-history.db-wal',
  'search-history.db-shm',
  'browser-downloads.db',
  'browser-downloads.db-wal',
  'browser-downloads.db-shm',
  'bookmarks.db',
  'bookmarks.db-wal',
  'bookmarks.db-shm',
  'nav-history.db',
  'nav-history.db-wal',
  'nav-history.db-shm',
  'accumulated-links.db',
  'accumulated-links.db-wal',
  'accumulated-links.db-shm',
  // ===== electron-store JSON（未迁入 settings.db 的模块数据） =====
  'injection-history.json',
  // ===== 加密密钥（已迁入 settings.db/app_key 表，随 settings.db 备份） =====
];

/** 基础数据中包含的资产目录（图片等，随 basicData 一起备份） */
const ASSET_DIRS = ['whiteboard-assets', 'notes-assets'];

/** 收集插件声明的额外备份文件（延迟加载避免循环依赖） */
async function collectPluginExtraFiles(): Promise<{ dbFiles: string[]; assetDirs: string[] }> {
  try {
    const { collectModuleDataFiles } = await import('../modules/registry.js')
    return collectModuleDataFiles()
  } catch {
    return { dbFiles: [], assetDirs: [] }
  }
}

/** Partitions/<id>/ 下属于「登录凭据」的文件（根级文件，非目录） */
const PARTITION_COOKIE_FILES = ['Cookies'];

/** Partitions/<id>/ 下属于「登录凭据」的目录 */
const PARTITION_COOKIE_DIRS = ['Local Storage'];

/** Partitions/<id>/ 下属于「应用数据」的目录（IndexedDB，非缓存，含离线应用数据） */
const PARTITION_INDEXEDDB_DIRS = ['IndexedDB'];

/** Partitions/<id>/ 下属于「离线缓存」的目录（可安全排除，不影响登录态） */
const PARTITION_CACHE_DIRS = [
  'Service Worker',
  'File System',
  'Cache',
  'Code Cache',
  'GPUCache',
  'blob_storage',
];

/**
 * 对一个 session 基础目录（Partitions/<id>/ 或 数据目录根）统计三类 session 体积。
 * 同一套分类常量同时覆盖各 profile session 与默认 session，避免根级存储被遗漏。
 * @param basePath session 根目录绝对路径
 */
function collectSessionSizesFromBase(basePath: string): {
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

/**
 * 将一个 session 基础目录下的存储按选项导出到 zip。
 * 同一套分类常量同时覆盖各 profile session 与默认 session。
 * @param basePath session 根目录绝对路径
 * @param baseEntry zip 内条目前缀（如 'Partitions/<id>' 或 ''，空串表示根级）
 */
async function addSessionFromBaseToZip(
  zip: AdmZip,
  basePath: string,
  baseEntry: string,
  options: ExportOptions,
  skippedFiles: string[],
): Promise<void> {
  const entryPrefix = baseEntry ? `${baseEntry}/` : '';
  // 登录凭据：Cookies 文件 + Local Storage 目录
  if (options.cookies) {
    for (const fileName of PARTITION_COOKIE_FILES) {
      const filePath = path.join(basePath, fileName);
      if (fs.existsSync(filePath)) {
        await addFileWithRetry(zip, filePath, `${entryPrefix}${fileName}`, skippedFiles);
      }
    }
    for (const dirName of PARTITION_COOKIE_DIRS) {
      const dirPath = path.join(basePath, dirName);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        await addFolderWithRetry(zip, dirPath, `${entryPrefix}${dirName}`, skippedFiles);
      }
    }
  }
  // 应用数据：IndexedDB 目录
  if (options.indexedDB) {
    for (const dirName of PARTITION_INDEXEDDB_DIRS) {
      const dirPath = path.join(basePath, dirName);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        await addFolderWithRetry(zip, dirPath, `${entryPrefix}${dirName}`, skippedFiles);
      }
    }
  }
  // 离线缓存：Service Worker / Cache 等目录
  if (options.cache) {
    for (const dirName of PARTITION_CACHE_DIRS) {
      const dirPath = path.join(basePath, dirName);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        await addFolderWithRetry(zip, dirPath, `${entryPrefix}${dirName}`, skippedFiles);
      }
    }
  }
}

/**
 * 导出选项（细粒度控制，4 项互不重叠）
 * - basicData：配置 JSON + chat.db + settings.db 含 app_key（必选，核心数据）
 * - cookies：登录凭据（Cookies 文件 + Local Storage 目录）
 * - indexedDB：应用数据（IndexedDB 目录，含离线应用数据）
 * - cache：离线缓存（Service Worker / Cache / GPUCache 等，可安全排除）
 */
export interface ExportOptions {
  basicData: boolean;    // 基础数据（必选）
  cookies: boolean;      // 登录凭据（Cookies + Local Storage）
  indexedDB: boolean;    // 应用数据（IndexedDB）
  cache: boolean;        // 离线缓存（Service Worker / Cache 等）
}

/** 各类别体积估算结果（字节） */
export interface ExportSizeEstimate {
  basicData: number;
  cookies: number;       // Cookies + Local Storage
  indexedDB: number;     // IndexedDB 目录
  cache: number;          // Service Worker / Cache 等目录
  voiceAssets: number;    // 语音资产（录音文件等）
  /** 选中项的总体积（由调用方根据选中项计算） */
  total: number;
}

/** 格式化字节为可读字符串 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 估算各类别导出体积（字节）
 * 遍历文件系统统计大小，不读取文件内容，仅 stat
 */
export async function estimateExportSizes(): Promise<ExportSizeEstimate> {
  const dataDir = getDataDir();
  let basicDataSize = 0;
  let cookiesSize = 0;
  let indexedDBSize = 0;
  let cacheSize = 0;

  // 基础数据：BACKUP_FILES 的总体积（含插件声明的数据库）
  const pluginExtra = await collectPluginExtraFiles()
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
  // 基础数据：资产目录（白板/笔记图片 + 插件资产）体积
  const allAssetDirs = [...ASSET_DIRS, ...pluginExtra.assetDirs]
  for (const dirName of allAssetDirs) {
    const dirPath = path.join(dataDir, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      basicDataSize += getDirSize(dirPath);
    }
  }

  // Partitions 目录：各 profile session 按 3 个分类分别统计
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

  // 默认 session（数据目录根级）：与各 profile 同等处理，避免根级 Local Storage / Cookies 等被遗漏
  // 根级 Local Storage 含主题偏好、最近对话 ID、设置面板宽度等关键 UI 状态
  const defaultSessionSizes = collectSessionSizesFromBase(dataDir);
  cookiesSize += defaultSessionSizes.cookies;
  indexedDBSize += defaultSessionSizes.indexedDB;
  cacheSize += defaultSessionSizes.cache;

  return {
    basicData: basicDataSize,
    cookies: cookiesSize,
    indexedDB: indexedDBSize,
    cache: cacheSize,
    voiceAssets: 0, // 语音资产体积暂不单独统计，归入 basicData
    total: 0, // 由调用方根据选中项计算
  };
}

/** 递归计算目录总体积（字节） */
function getDirSize(dirPath: string): number {
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
function getDataDir(): string {
  if (process.env.SIDEKICK_DATA_DIR) return app.getPath('userData');
  if (isPortableMode()) {
    return path.join(path.dirname(app.getPath('exe')), 'data');
  }
  const cwd = getStoreCwd();
  if (cwd) return cwd;
  return app.getPath('userData');
}

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
  console.log('[backup-restore] 开始清理缓存，当前体积:', formatBytes(cleanedBytes));

  // 1. 收集所有 session
  const sessionsToClean: Electron.Session[] = [session.defaultSession];
  try {
    for (const profile of profileStore.list()) {
      try {
        sessionsToClean.push(session.fromPartition(`persist:${profile.id}`));
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[backup-restore] 收集 partition sessions 失败:', err);
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
        console.warn(`[backup-restore] 删除缓存目录失败: ${dirPath}`, err);
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

  console.log('[backup-restore] 缓存清理完成，已清理:', formatBytes(cleanedBytes));
  return { cleanedBytes };
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface ImportResult {
  success: boolean;
  error?: string;
  /** 加密文件需要密码解密时返回 true */
  encrypted?: boolean;
  /** 导入成功后返回来源设备 ID */
  sourceDeviceId?: string;
}

/**
 * 导出数据到 zip 文件（细粒度控制）
 * @param targetPath 用户选择的保存位置（zip 文件完整路径）
 * @param options 导出选项（基础数据 / 登录态 / 完整分区 / 语音模型）
 */
export async function exportAllData(
  targetPath: string,
  options: ExportOptions,
  encrypt?: { password: string },
): Promise<ExportResult> {
  let snapshotDir: string | undefined;
  try {
    const dataDir = getDataDir();
    console.log('[backup-restore] 开始导出数据:', dataDir, '选项:', options);

    const deviceId = getDeviceId();

    // 2. 创建 zip
    const zip = new AdmZip();
    const skippedFiles: string[] = [];

    // 3. 基础数据
    if (options.basicData) {
      snapshotDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekickai-backup-'));
      const pluginExtra = await collectPluginExtraFiles()
      const allBackupFiles = [...BACKUP_FILES]
      for (const db of pluginExtra.dbFiles) {
        allBackupFiles.push(db, db + '-wal', db + '-shm')
      }
      for (const fileName of new Set(allBackupFiles)) {
        if (fileName.endsWith('-wal') || fileName.endsWith('-shm')) continue;
        const filePath = path.join(dataDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        if (fileName.endsWith('.db')) {
          const snapshotPath = path.join(snapshotDir, fileName);
          fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
          await snapshotSqliteDatabase(filePath, snapshotPath);
          zip.addFile(fileName, fs.readFileSync(snapshotPath));
        } else {
          await addFileWithRetry(zip, filePath, fileName, skippedFiles);
        }
      }
      const allAssetDirs = [...ASSET_DIRS, ...pluginExtra.assetDirs]
      for (const dirName of allAssetDirs) {
        const dirPath = path.join(dataDir, dirName);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          await addFolderWithRetry(zip, dirPath, dirName, skippedFiles);
        }
      }
      if (skippedFiles.length) throw new Error(`基础数据未能完整导出：${skippedFiles.join(', ')}`);
    }

    // 4. 会话数据
    const wantSession = options.cookies || options.indexedDB || options.cache;
    if (wantSession) {
      const partitionsDir = path.join(dataDir, 'Partitions');
      if (fs.existsSync(partitionsDir) && fs.statSync(partitionsDir).isDirectory()) {
        const partitionEntries = fs.readdirSync(partitionsDir, { withFileTypes: true });
        for (const entry of partitionEntries) {
          if (!entry.isDirectory()) continue;
          const partitionPath = path.join(partitionsDir, entry.name);
          await addSessionFromBaseToZip(
            zip,
            partitionPath,
            `Partitions/${entry.name}`,
            options,
            skippedFiles,
          );
        }
      }
      await addSessionFromBaseToZip(zip, dataDir, '', options, skippedFiles);
    }

    // 5. manifest（使用步骤 0 捕获的 deviceId）
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      deviceId,
      appVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
    }, null, 2), 'utf-8'));

    // 5b. 关键文件校验：没有 settings.db 的备份不可用，宁可失败也不要导出“空包”
    const entryNames = new Set(zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/')))
    if (!entryNames.has('settings.db') && !entryNames.has('profiles.json')) {
      const skippedNote = skippedFiles.length ? `；锁定跳过: ${skippedFiles.join(', ')}` : ''
      return {
        success: false,
        error: `导出失败：备份中缺少 settings.db（数据目录 ${dataDir}）${skippedNote}`,
      }
    }
    if (skippedFiles.includes('settings.db') || skippedFiles.includes('chat.db')) {
      return {
        success: false,
        error: `导出失败：关键数据库被占用未能打包（${skippedFiles.join(', ')}），请确认软件已完全退出后重试`,
      }
    }

    // 6. 写 zip
    const zipPath = encrypt ? targetPath + '.tmp.zip' : targetPath
    zip.writeZip(zipPath);

    // 7. 加密
    if (encrypt) {
      encryptFile(zipPath, targetPath, encrypt.password, deviceId)
      try { fs.rmSync(zipPath) } catch { /* ignore */ }
      console.log('[backup-restore] 加密导出成功:', targetPath);
    }
    console.log('[backup-restore] 导出成功:', targetPath, 'entries=', entryNames.size);

    if (skippedFiles.length > 0) {
      console.warn('[backup-restore] 以下文件因锁定被跳过:', skippedFiles);
    }

    return { success: true, filePath: targetPath };
  } catch (err) {
    const message = (err as Error).message;
    console.error('[backup-restore] 导出失败:', message);
    return { success: false, error: message };
  } finally {
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

/**
 * 添加文件到 zip（带重试，处理 EBUSY/EPERM 等文件锁定错误）
 * 重试 3 次，每次间隔 300ms；仍失败则记录到 skippedFiles 并继续
 */
async function addFileWithRetry(
  zip: AdmZip,
  filePath: string,
  entryName: string,
  skippedFiles: string[],
): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 读取文件内容后用 addBuffer 添加（避免 AdmZip 内部 readFile 锁定）
      const data = fs.readFileSync(filePath);
      zip.addFile(entryName, data);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        if (attempt < MAX_RETRIES) {
          console.warn(`[backup-restore] 文件锁定 ${entryName}（${code}），重试 ${attempt}/${MAX_RETRIES}`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        // 重试耗尽：跳过该文件
        console.warn(`[backup-restore] 文件锁定 ${entryName}（${code}），重试耗尽，跳过`);
        skippedFiles.push(entryName);
        return;
      }
      // 非锁定错误：直接抛出
      throw err;
    }
  }
}

/**
 * 递归添加目录到 zip（逐文件 try-catch，避免单个文件锁定导致整个目录失败）
 */
async function addFolderWithRetry(
  zip: AdmZip,
  dirPath: string,
  baseEntryName: string,
  skippedFiles: string[],
): Promise<void> {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const entryName = `${baseEntryName}/${entry.name}`;
    if (entry.isDirectory()) {
      await addFolderWithRetry(zip, fullPath, entryName, skippedFiles);
    } else {
      await addFileWithRetry(zip, fullPath, entryName, skippedFiles);
    }
  }
}

/**
 * 从 zip 文件导入所有数据
 * 导入完成后应用会自动重启以加载新数据。
 * @param zipPath 用户选择的 zip 文件路径
 */

export async function importAllData(zipPath: string): Promise<ImportResult> {
  // 检测加密文件，返回 encrypted 标记让渲染层弹密码框
  if (isSabkEncrypted(zipPath)) {
    return { success: false, encrypted: true, error: '需要密码解密' }
  }
  return importAllDataInner(zipPath)
}

/** 强制重启：relaunch + exit + process.exit 兜底；成功路径保持 importing 标志阻止托盘驻留 */
function scheduleAppRestart(delayMs = 80): void {
  setTimeout(() => {
    try {
      app.relaunch()
    } catch (err) {
      console.error('[backup-restore] relaunch 失败:', err)
    }
    try {
      app.exit(0)
    } catch { /* ignore */ }
    // 托盘/残留监听可能导致 app.exit 不彻底
    setTimeout(() => process.exit(0), 50).unref?.()
  }, delayMs)
}

/** 实际导入逻辑（明文 zip） */
async function importAllDataInner(zipPath: string): Promise<ImportResult> {
  setImportingData(true)
  let dataDir = ''
  let bakDir = ''
  let tempDir = ''
  try {
    console.log('[backup-restore] 开始导入数据:', zipPath);

    // 1. 验证 zip 完整性（在销毁任何窗口之前，失败时 UI 仍可用）
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const entryNames = new Set(entries.map((e) => e.entryName));
    if (!entryNames.has('settings.db') && !entryNames.has('profiles.json')) {
      return {
        success: false,
        error: '备份文件不完整：缺少 settings.db 或 profiles.json',
      };
    }

    // 2. 解压到临时目录（仍不销毁窗口；解压失败可直接报错）
    dataDir = getDataDir();
    tempDir = fs.mkdtempSync(path.join(path.dirname(dataDir), '.sidekickai-restore-'));
    // 走 safeExtractAll：备份 zip 属用户提供的不可信输入，
    // 必须校验条目名、拒绝路径穿越与符号链接目标（见 safe-zip.ts 说明）
    const files = entries.filter(entry => !entry.isDirectory);
    const names = files.map(entry => entry.entryName.replace(/\\/g, '/').toLowerCase());
    if (new Set(names).size !== names.length) throw new Error('备份包含重复文件');
    if (names.some(name => name.split('/').some(part => /[:<>"|?*]|[. ]$/.test(part)))) {
      throw new Error('备份包含无效文件名');
    }
    const extracted = safeExtractAll(zip, tempDir, { tag: '[backup-restore]' });
    if (extracted !== files.length) throw new Error('备份含有无法安全恢复的文件');
    validateRestoreDirectory(tempDir);

    // 3. 销毁所有 BrowserWindow（必须在关闭 SQLite 之前，否则窗口 close 事件
    //    触发 cleanupOnQuit → getChatStore() 会因已关闭的连接而崩溃）
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.destroy(); } catch { /* ignore */ }
      }
    }

    // Flush sessions without deleting data that may be absent from the backup.
    const sessionsToClean = [session.defaultSession];
    try {
      for (const profile of profileStore.list()) {
        sessionsToClean.push(session.fromPartition(`persist:${profile.id}`));
      }
    } catch (err) {
      console.warn('[backup-restore] 收集 partition sessions 失败:', err);
    }
    await Promise.all(
      sessionsToClean.map(async (s) => {
        s.flushStorageData();
        await s.cookies.flushStore();
      }),
    );

    // 5. 关闭所有 SQLite 连接
    try {
      closeChatStore();
      closeWhiteboardDb();
      closeNotesDb();
      closeBookmarkStore();
      closeSearchHistoryStore();
      closeBrowserDownloadStore();
      closeNavHistoryStore();
      accumulatedLinksStore.close();
      closeModuleStateDb();
    } catch (err) {
      console.warn('[backup-restore] 关闭 SQLite 失败:', err);
    }

    // Each included root is moved aside before its replacement is installed.
    bakDir = `${dataDir}.bak-${Date.now()}`;
    replaceRestoreEntries(tempDir, dataDir, bakDir);

    // 9. 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    // 10. 兼容旧版备份：app-key.json → settings.db/app_key 迁移
    try {
      const appKeyPath = path.join(dataDir, 'app-key.json')
      if (fs.existsSync(appKeyPath)) {
        const raw = JSON.parse(fs.readFileSync(appKeyPath, 'utf-8'))
        if (raw.key) {
          const { createSqliteJsonStore } = await import('./module-state-store.js')
          const keyStore = createSqliteJsonStore<{ version: number; key: string; createdAt: number }>({
            tableName: 'app_key',
            defaults: { version: 1, key: '', createdAt: 0 },
          })
          if (!keyStore.get('key')) {
            keyStore.set('version', raw.version ?? 1)
            keyStore.set('key', raw.key)
            keyStore.set('createdAt', raw.createdAt ?? Date.now())
            console.log('[backup-restore] 已从 app-key.json 迁移密钥到 settings.db/app_key')
          }
          try { fs.rmSync(appKeyPath) } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.warn('[backup-restore] app-key.json 迁移失败（非致命）:', err)
    }

    // 10b. 导入后标记 install-config，避免 seed 覆盖导入结果
    try {
      const { stampInstallConfigHashAfterImport } = await import('./install-config-seed.js')
      stampInstallConfigHashAfterImport()
    } catch (err) {
      console.warn('[backup-restore] 导入后 stamp install-config 失败（非致命）:', err)
    }

    // 11. 来源设备 ID
    let sourceDeviceId: string | undefined
    try {
      const manifestPath = path.join(dataDir, 'manifest.json')
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        sourceDeviceId = manifest.deviceId
      }
    } catch { /* ignore */ }

    // 12. 成功：保持 importing=true（阻止托盘驻留），短延迟后强制重启
    console.log('[backup-restore] 导入成功，即将重启应用')
    scheduleAppRestart(120)
    // 成功路径不 finally 清 importing，交给进程退出
    return { success: true, sourceDeviceId }
  } catch (err) {
    const message = (err as Error).message;
    console.error('[backup-restore] 导入失败:', message);
    if (err instanceof RestoreRecoveryError) {
      dialog.showErrorBox('数据恢复未完成', `自动回滚未完成，程序将关闭。原始数据保留在：\n${err.recoveryDirectory}\n请保留此目录后进行恢复。`);
      app.exit(1);
      return { success: false, error: message };
    }
    // 窗口可能已销毁：尽量拉起正常实例，避免残留无界面进程
    if (BrowserWindow.getAllWindows().length === 0) {
      scheduleAppRestart(0)
    }
    return { success: false, error: message };
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    // 成功时上面已 return，此处仅失败/校验失败路径会清标志
    if (BrowserWindow.getAllWindows().length > 0) {
      setImportingData(false)
    }
  }
}

/**
 * 从加密的 .sabackup 文件导入数据。
 * 先解密为临时 zip，再走正常导入流程。
 */
export async function importAllDataDecrypted(filePath: string, password: string): Promise<ImportResult> {
  const tempZip = filePath + '.tmp.zip'
  try {
    const sourceDeviceId = decryptFile(filePath, tempZip, password)
    if (!sourceDeviceId) {
      try { fs.rmSync(tempZip, { force: true }) } catch { /* ignore */ }
      return { success: false, error: '密码错误或文件损坏' }
    }
    // 解密产物必须是合法 zip，否则 AdmZip 会在销毁窗口后才炸
    try {
      const testZip = new AdmZip(tempZip)
      if (testZip.getEntries().length === 0) {
        try { fs.rmSync(tempZip, { force: true }) } catch { /* ignore */ }
        return { success: false, error: '解密成功但备份内容为空' }
      }
    } catch {
      try { fs.rmSync(tempZip, { force: true }) } catch { /* ignore */ }
      return { success: false, error: '解密结果不是有效备份文件' }
    }
    const result = await importAllDataInner(tempZip)
    try { fs.rmSync(tempZip, { force: true }) } catch { /* ignore */ }
    if (result.success && !result.sourceDeviceId) {
      result.sourceDeviceId = sourceDeviceId
    }
    return result
  } catch (err) {
    try { fs.rmSync(tempZip, { force: true }) } catch { /* ignore */ }
    return { success: false, error: (err as Error).message }
  }
}
