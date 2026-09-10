/* =====================================================================
   lib/electron-api/settings.ts —— 应用全局设置 / 预览窗事件 / 自定义 AI 提供商
   ===================================================================== */

import type { AppSettings, CustomAIProvider, CustomAIProviderInput } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   应用全局设置 —— 对应 window.electron.appSettings
   ===================================================================== */

/** 读取应用全局设置 */
export function getAppSettings(): Promise<AppSettings> {
  const api = requireElectron();
  return api.appSettings.get();
}

/** 更新应用全局设置（合并 patch） */
export function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const api = requireElectron();
  return api.appSettings.update(patch);
}

/** 测试当前代理配置连通性 */
export function testProxy(): Promise<{ ok: boolean; latencyMs?: number; message: string }> {
  const api = requireElectron();
  return api.appSettings.testProxy();
}

/** 将当前代理配置即时应用到所有 session（无需重启） */
export function applyProxy(): Promise<void> {
  const api = requireElectron();
  return api.appSettings.applyProxy();
}

/**
 * 代理失败兜底：webview 加载失败时代理错误码触发，临时切换到兜底模式。
 * 返回 { switched, mode } —— switched=true 表示已切换，mode 为切换到的模式。
 */
export function applyProxyFallback(): Promise<{
  switched: boolean;
  mode: 'direct' | 'system' | null;
}> {
  const api = requireElectron();
  return api.appSettings.applyProxyFallback();
}

/** 测试指定 Profile 的代理连通性 */
export function testProfileProxy(
  profileId: string,
): Promise<{ ok: boolean; latencyMs?: number; message: string }> {
  const api = requireElectron();
  return api.appSettings.testProfileProxy(profileId);
}

/** 将 Profile.proxyConfig 即时应用到其 session（无需重启） */
export function applyProfileProxy(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.appSettings.applyProfileProxy(profileId);
}

/** Profile 级代理失败兜底（浏览器窗口 webview 加载失败时触发） */
export function applyProfileProxyFallback(profileId: string): Promise<{
  switched: boolean;
  mode: 'direct' | 'system' | null;
}> {
  const api = requireElectron();
  return api.appSettings.applyProfileProxyFallback(profileId);
}

/**
 * 保存/清除指定 Profile 的浏览器窗口脱离/回归快捷键。
 * 主进程会调用 reregisterProfileShortcuts() 重注册全局快捷键。
 * @param accelerator accelerator 字符串，传 null 清除快捷键
 */
export function setProfileShortcut(
  profileId: string,
  accelerator: string | null,
): Promise<unknown> {
  const api = requireElectron();
  return api.appSettings.setProfileShortcut(profileId, accelerator);
}

/** 清除所有用户数据（恢复出厂设置），完成后应用自动重启 */
export function clearAllData(): Promise<boolean> {
  const api = requireElectron();
  return api.appSettings.clearAllData();
}

/** 选择导出文件保存路径（弹出系统保存对话框） */
export async function selectExportPath(encrypted?: boolean): Promise<string | null> {
  const api = requireElectron();
  return api.appSettings.selectExportPath(encrypted);
}

/** 选择导入文件（弹出系统打开对话框） */
export async function selectImportFile(): Promise<string | null> {
  const api = requireElectron();
  return api.appSettings.selectImportFile();
}

/** 导出数据到指定路径（细粒度控制：基础数据 / 登录凭据 / 应用数据 / 离线缓存 / 语音资产，可选加密） */
export async function exportData(
  targetPath: string,
  options: {
    basicData: boolean;
    cookies: boolean;
    indexedDB: boolean;
    cache: boolean;
    voiceAssets: boolean;
  },
  encrypt?: { password: string },
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const api = requireElectron();
  return api.appSettings.exportData(targetPath, options, encrypt);
}

/** 从 zip/sabackup 文件导入所有数据（导入后应用自动重启）。加密文件返回 encrypted: true */
export async function importData(filePath: string): Promise<{ success: boolean; error?: string; encrypted?: boolean; sourceDeviceId?: string }> {
  const api = requireElectron();
  return api.appSettings.importData(filePath);
}

/** 从加密的 .sabackup 文件导入（输入密码解密后导入） */
export async function importDataDecrypted(filePath: string, password: string): Promise<{ success: boolean; error?: string; sourceDeviceId?: string }> {
  const api = requireElectron();
  return api.appSettings.importDataDecrypted(filePath, password);
}

/** 选文件后立即检测是否 SABK 加密备份 */
export async function detectBackupEncrypted(filePath: string): Promise<boolean> {
  const api = requireElectron();
  return api.appSettings.detectBackupEncrypted(filePath);
}

/** 估算导出各类别体积（字节） */
export async function estimateExportSizes(): Promise<{
  basicData: number;
  cookies: number;
  indexedDB: number;
  cache: number;
  voiceAssets: number;
}> {
  const api = requireElectron();
  return api.appSettings.estimateExportSizes();
}

/** 打开数据导出独立窗口（单例） */
export async function openExportWindow(): Promise<void> {
  const api = requireElectron();
  return api.appSettings.openExportWindow();
}

/** 清理缓存数据（仅缓存类目录与 session cache，保留登录态） */
export async function cleanCache(): Promise<{ cleanedBytes: number }> {
  const api = requireElectron();
  return api.appSettings.cleanCache();
}

/** 估算当前缓存体积（字节） */
export async function estimateCacheSize(): Promise<number> {
  const api = requireElectron();
  return api.appSettings.estimateCacheSize();
}

/** 选择下载目录（弹出系统目录选择对话框），返回选中路径或 null */
export async function selectDownloadDir(): Promise<string | null> {
  const api = requireElectron();
  return api.appSettings.selectDownloadDir();
}

/** 在系统文件管理器中打开下载目录 */
export async function openDownloadDir(): Promise<void> {
  const api = requireElectron();
  return api.appSettings.openDownloadDir();
}

/** 读取拖拽文件并以 data URL 形式返回（用于跨 webview 边界传递文件内容） */
export async function dropFiles(
  filePaths: string[],
): Promise<Array<{ filename: string; dataUrl: string; mime: string; size: number }>> {
  const api = requireElectron();
  return api.appSettings.dropFiles(filePaths);
}

/** 监听下载完成事件（主进程 → 渲染层：filename + path）。返回取消监听函数 */
export function onDownloadDone(
  callback: (info: { filename: string; path: string }) => void,
): () => void {
  const api = requireElectron();
  return api.appSettings.onDownloadDone(callback);
}

/**
 * 监听预览窗更新事件（主进程→预览窗渲染：更新文本/状态）。
 * @returns 取消监听函数
 */
export function onPreviewUpdate(
  callback: (payload: {
    text: string;
    status: 'recording' | 'transcribing' | 'done' | 'sent';
  }) => void,
): () => void {
  const api = requireElectron();
  return api.onPreviewUpdate(callback);
}

/**
 * 监听预览窗隐藏事件（主进程→预览窗渲染：同步隐藏状态）。
 * @returns 取消监听函数
 */
export function onPreviewHide(callback: () => void): () => void {
  const api = requireElectron();
  return api.onPreviewHide(callback);
}

/**
 * 监听流式识别部分结果（主进程→预览窗渲染：实时推送已识别的部分文本）。
 * @returns 取消监听函数
 */
export function onPreviewPartial(callback: (payload: { text: string }) => void): () => void {
  const api = requireElectron();
  return api.onPreviewPartial(callback);
}

/* =====================================================================
   自定义 AI 提供商 —— 对应 window.electron.aiProvider
   ===================================================================== */

/** 列出全部自定义 AI 提供商 */
export async function listAIProviders(): Promise<CustomAIProvider[]> {
  const api = requireElectron();
  return api.aiProvider.list();
}

/** 创建自定义 AI 提供商 */
export async function createAIProvider(input: CustomAIProviderInput): Promise<CustomAIProvider> {
  const api = requireElectron();
  return api.aiProvider.create(input);
}

/** 更新自定义 AI 提供商 */
export async function updateAIProvider(
  id: string,
  patch: Partial<CustomAIProviderInput>,
): Promise<CustomAIProvider> {
  const api = requireElectron();
  return api.aiProvider.update(id, patch);
}

/** 删除自定义 AI 提供商 */
export async function deleteAIProvider(id: string): Promise<void> {
  const api = requireElectron();
  return api.aiProvider.delete(id);
}

/** 测试自定义 AI 提供商连通性 */
export async function testAIProvider(
  input: CustomAIProviderInput,
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const api = requireElectron();
  return api.aiProvider.test(input);
}

/**
 * 需求 9：自动搜索 Provider 可用模型列表（OpenAI 兼容 /v1/models）
 * 失败时返回空数组（不抛错）
 */
export async function listAIProviderModels(
  input: CustomAIProviderInput,
): Promise<string[]> {
  const api = requireElectron();
  return api.aiProvider.listModels(input);
}

/**
 * 需求 9：加密导出 Provider 配置（API Key 明文包含在加密串内）
 * 返回加密字符串（pw: 前缀）
 * @param password 加密密码
 * @param selectedIds 可选：选择性导出的 provider id 列表（不传或为空则导出全部）
 */
export async function exportAIProvidersEncrypted(
  password: string,
  selectedIds?: string[],
): Promise<string> {
  const api = requireElectron();
  return api.aiProvider.exportEncrypted(password, selectedIds);
}

/**
 * 需求 9：从加密串导入 Provider 配置（覆盖现有同 id）
 */
export async function importAIProvidersEncrypted(
  encrypted: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.aiProvider.importEncrypted(encrypted, password);
}

/**
 * v0.5.2 B-4：预览导入（dry-run，不持久化）。
 * 返回 provider 列表 + 与现有 provider id 冲突列表，渲染层可基于此显示导入预览。
 */
export async function previewImportAIProviders(
  encrypted: string,
  password: string,
): Promise<{
  ok: boolean
  error?: string
  providers?: Array<{
    id: string
    name: string
    protocol: string
    apiEndpoint: string
    model: string
    alternativeModels?: string[]
  }>
  conflictIds?: string[]
}> {
  const api = requireElectron();
  return api.aiProvider.previewImport(encrypted, password);
}

/** v0.5.2 B-4：选择 AI Provider 加密导出文件保存路径 */
export async function selectAIProviderExportPath(): Promise<string | null> {
  const api = requireElectron();
  return api.aiProvider.selectExportPath();
}

/** v0.5.2 B-4：选择 AI Provider 加密导入文件 */
export async function selectAIProviderImportFile(): Promise<string | null> {
  const api = requireElectron();
  return api.aiProvider.selectImportFile();
}

/** v0.5.2 B-4：写入加密导出文件到指定路径 */
export async function writeAIProviderExportFile(
  filePath: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.aiProvider.writeExportFile(filePath, content);
}

/** v0.5.2 B-4：读取导入文件内容 */
export async function readAIProviderImportFile(
  filePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const api = requireElectron();
  return api.aiProvider.readImportFile(filePath);
}
