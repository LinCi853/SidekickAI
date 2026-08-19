// electron/store/backup-restore.ts — 跨设备数据迁移：导出/导入完整数据
//
// 将应用全部持久化数据打包为 zip 文件，包含：
// - 配置文件：settings.db（Phase 3 迁移后，所有 JSON 设置的单一数据源）
// - 加密密钥：app-key.json（随数据迁移，保证 AES 加密数据可跨设备解密）
// - 对话数据库：chat.db / chat.db-wal / chat.db-shm
// - Session 数据：Partitions/ 目录（cookies/localStorage/IndexedDB，保证登录态迁移）


import { app, session, BrowserWindow } from 'electron';
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

/** 必须迁移的文件列表（相对数据目录） */
const BACKUP_FILES = [
  // ===== Phase 3：settings.db 是所有 JSON 设置的单一数据源 =====
  // 旧 JSON 文件（app-settings.json 等）迁移后变为 .bak，保留兼容旧版本
  'settings.db',
  'settings.db-wal',
  'settings.db-shm',
  // 旧 JSON 文件（迁移前存在，迁移后为 .bak，备份时一并包含）
  'app-settings.json',
  'window-states.json',
  'ai-providers.json',
  'profiles.json',
  'voice-config.json',
  'hotkey.json',
  'prompts.json',
  'presets.json',
  'block-rules.json',
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
 * - basicData：配置 JSON + chat.db + app-key.json（必选，核心数据）
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
export function estimateExportSizes(): ExportSizeEstimate {
  const dataDir = getDataDir();
  let basicDataSize = 0;
  let cookiesSize = 0;
  let indexedDBSize = 0;
  let cacheSize = 0;

  // 基础数据：BACKUP_FILES 的总体积
  for (const fileName of BACKUP_FILES) {
    const filePath = path.join(dataDir, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) basicDataSize += stat.size;
      } catch { /* ignore */ }
    }
  }
  // 基础数据：资产目录（白板/笔记图片）体积
  for (const dirName of ASSET_DIRS) {
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
}

/**
 * 导出数据到 zip 文件（细粒度控制）
 * @param targetPath 用户选择的保存位置（zip 文件完整路径）
 * @param options 导出选项（基础数据 / 登录态 / 完整分区 / 语音模型）
 */
export async function exportAllData(
  targetPath: string,
  options: ExportOptions,
): Promise<ExportResult> {
  try {
    const dataDir = getDataDir();
    console.log('[backup-restore] 开始导出数据:', dataDir, '选项:', options);

    // 1. 关闭所有 SQLite 连接，确保 WAL 写回主 db
    try {
      closeChatStore();
      closeWhiteboardDb();
      closeNotesDb();
      closeBookmarkStore();
      closeModuleStateDb();
    } catch (err) {
      console.warn('[backup-restore] 关闭 SQLite 失败:', err);
    }

    // 2. 创建 zip
    const zip = new AdmZip();

    // 记录跳过的文件（EBUSY 等锁定错误）
    const skippedFiles: string[] = [];

    // 3. 基础数据（配置 JSON + chat.db + app-key.json + 资产目录）
    if (options.basicData) {
      for (const fileName of BACKUP_FILES) {
        const filePath = path.join(dataDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        await addFileWithRetry(zip, filePath, fileName, skippedFiles);
      }
      // 资产目录（白板/笔记图片，跨设备迁移不丢图片）
      for (const dirName of ASSET_DIRS) {
        const dirPath = path.join(dataDir, dirName);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          await addFolderWithRetry(zip, dirPath, dirName, skippedFiles);
        }
      }
    }

    // 4. 会话数据：各 profile session（Partitions/<id>/）+ 默认 session（数据目录根级）
    // 同一套分类常量覆盖两类 session，避免根级 Local Storage / Cookies 等被遗漏
    // - cookies：Cookies 文件 + Local Storage 目录
    // - indexedDB：IndexedDB 目录
    // - cache：Service Worker / Cache 等目录
    const wantSession = options.cookies || options.indexedDB || options.cache;
    if (wantSession) {
      // 各 profile session
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
      // 默认 session（根级）：含主题偏好、最近对话 ID、设置面板宽度等关键 UI 状态
      await addSessionFromBaseToZip(zip, dataDir, '', options, skippedFiles);
    }

    // 5. 写入 zip
    zip.writeZip(targetPath);
    console.log('[backup-restore] 导出成功:', targetPath);

    if (skippedFiles.length > 0) {
      console.warn('[backup-restore] 以下文件因锁定被跳过:', skippedFiles);
    }

    return { success: true, filePath: targetPath };
  } catch (err) {
    const message = (err as Error).message;
    console.error('[backup-restore] 导出失败:', message);
    return { success: false, error: message };
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
  try {
    console.log('[backup-restore] 开始导入数据:', zipPath);

    // 1. 验证 zip 完整性
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const entryNames = new Set(entries.map((e) => e.entryName));
    // 验证：必须有 app-key.json + 数据源（settings.db 或旧版 profiles.json）
    if (!entryNames.has('app-key.json')) {
      return {
        success: false,
        error: '备份文件不完整：缺少 app-key.json',
      };
    }
    if (!entryNames.has('settings.db') && !entryNames.has('profiles.json')) {
      return {
        success: false,
        error: '备份文件不完整：缺少 settings.db 或 profiles.json',
      };
    }

    // 2. 关闭所有 SQLite 连接
    try {
      closeChatStore();
      closeWhiteboardDb();
      closeNotesDb();
      closeBookmarkStore();
      closeModuleStateDb();
    } catch (err) {
      console.warn('[backup-restore] 关闭 SQLite 失败:', err);
    }

    // 3. 清理所有 session（释放 partition 文件锁）
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
        try { await s.clearStorageData(); } catch { /* ignore */ }
        try { await s.clearCache(); } catch { /* ignore */ }
        try { await s.clearAuthCache(); } catch { /* ignore */ }
      }),
    );

    // 4. 销毁所有 BrowserWindow
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.destroy(); } catch { /* ignore */ }
      }
    }

    // 5. 解压到临时目录
    const tempDir = path.join(app.getPath('temp'), `sidekickai-restore-${Date.now()}`);
    zip.extractAllTo(tempDir, true);

    // 6. 获取数据目录
    const dataDir = getDataDir();

    // 7. 备份当前数据目录（重命名为 .bak-<timestamp>）
    const bakDir = `${dataDir}.bak-${Date.now()}`;
    try {
      if (fs.existsSync(dataDir)) {
        fs.renameSync(dataDir, bakDir);
      }
    } catch (err) {
      console.warn('[backup-restore] 备份原数据目录失败:', err);
    }

    // 8. 将解压内容覆盖到数据目录
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      // 复制临时目录的所有内容到 dataDir
      copyDirRecursive(tempDir, dataDir);
    } catch (err) {
      console.error('[backup-restore] 覆盖数据目录失败:', err);
      // 尝试恢复备份
      try {
        if (fs.existsSync(bakDir)) {
          fs.renameSync(bakDir, dataDir);
        }
      } catch { /* ignore */ }
      return { success: false, error: (err as Error).message };
    }

    // 9. 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    // 10. 重启应用
    console.log('[backup-restore] 导入成功，重启应用');
    app.relaunch();
    app.exit(0);

    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    console.error('[backup-restore] 导入失败:', message);
    return { success: false, error: message };
  }
}

/** 递归复制目录 */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
