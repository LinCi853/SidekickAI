/* =====================================================================
   lib/electron-api/chat.ts —— 对话持久化（会话/消息/流式/痕迹/脱离窗口/导入导出）
   ===================================================================== */

import type {
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatSendPayload,
  ChatStreamChunk,
  WindowTrace,
  LoginTrace,
  ChatWindowConfig,
} from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   对话持久化 —— 对应 window.electron.chat
   ===================================================================== */

/** 列出会话（按 sourceId 过滤；不传则全部） */
export async function listConversations(sourceId?: string): Promise<Conversation[]> {
  const api = requireElectron();
  return api.chat.listConversations(sourceId);
}

/** 创建会话 */
export async function createConversation(
  sourceId: string,
  sourceType: ConversationSourceType,
  title: string,
  url?: string,
): Promise<Conversation> {
  const api = requireElectron();
  return api.chat.createConversation(sourceId, sourceType, title, url);
}

/** 查询指定来源最近一条带 URL 的对话 URL（用于"启动时打开最近对话"） */
export async function getLastConversationUrl(sourceId: string): Promise<string | null> {
  const api = requireElectron();
  return api.chat.getLastConversationUrl(sourceId);
}

/** 删除会话 */
export async function deleteConversation(id: string): Promise<void> {
  const api = requireElectron();
  return api.chat.deleteConversation(id);
}

/** 列出会话消息（按时间升序） */
export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const api = requireElectron();
  return api.chat.listMessages(conversationId);
}

/**
 * 保存消息并智能合并（需求 5）：
 *   - 与会话内最近一条同 role 消息计算 Jaccard 相似度
 *   - 相似度 ≥ 0.85：UPDATE 现有消息内容
 *   - 完全相同（相似度 ≥ 0.999）：跳过
 *   - 否则：插入新记录
 */
export async function saveMessageWithMerge(
  msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
): Promise<{ merged: boolean; messageId: string; skipped: boolean }> {
  const api = requireElectron();
  return api.chat.saveMessageWithMerge(msg);
}

/**
 * webview 抓取入库后通知主进程广播给其他窗口。
 * HistoryView 订阅 onConversationPersisted 后会自动刷新侧边栏，
 * 避免"发送消息后需要手动刷新才能在历史侧边栏看到"的问题。
 */
export async function notifyConversationPersisted(sourceId: string): Promise<void> {
  const api = requireElectron();
  return api.chat.notifyConversationPersisted(sourceId);
}

/** 订阅入库广播事件（主进程 → 所有窗口）。返回取消订阅函数。 */
export function onConversationPersisted(
  callback: (payload: { sourceId: string }) => void,
): () => void {
  const api = requireElectron();
  return api.chat.onConversationPersisted(callback);
}

/** 全文搜索消息 */
export async function searchMessages(
  query: string,
): Promise<Array<ChatMessage & { conversationTitle: string }>> {
  const api = requireElectron();
  return api.chat.search(query);
}

/** 发送消息：API 直连调用 + 流式推送 */
export async function sendChat(
  payload: ChatSendPayload,
): Promise<{ conversationId: string; userMessageId: string }> {
  const api = requireElectron();
  return api.chat.send(payload);
}

/** 取消正在进行的流式请求 */
export async function cancelChat(conversationId: string): Promise<void> {
  const api = requireElectron();
  return api.chat.cancel(conversationId);
}

/** 监听流式分块推送 */
export function onChatStreamChunk(callback: (chunk: ChatStreamChunk) => void): () => void {
  const api = requireElectron();
  return api.chat.onStreamChunk(callback);
}

/** 监听流式结束 */
export function onChatStreamEnd(
  callback: (info: { conversationId: string; ok: boolean; error?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.chat.onStreamEnd(callback);
}

/** 记录登录痕迹 */
export async function logLoginTrace(
  trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>,
): Promise<void> {
  const api = requireElectron();
  return api.chat.logLoginTrace(trace);
}

/** 列出窗口操作痕迹 */
export async function listWindowTraces(
  windowId?: string,
  limit?: number,
): Promise<WindowTrace[]> {
  const api = requireElectron();
  return api.chat.listWindowTraces(windowId, limit);
}

/** 列出登录痕迹 */
export async function listLoginTraces(profileId?: string): Promise<LoginTrace[]> {
  const api = requireElectron();
  return api.chat.listLoginTraces(profileId);
}

/** 打开历史搜索独立窗口（单例，列举所有本地保存数据） */
export async function openHistoryWindow(): Promise<void> {
  const api = requireElectron();
  return api.chat.openHistoryWindow();
}

/** 更新自定义对话脱离窗口配置 */
export async function updateChatDetachedWindow(
  windowId: string,
  config: ChatWindowConfig,
): Promise<void> {
  const api = requireElectron();
  return api.chat.updateDetachedWindow(windowId, config);
}

/** 获取当前窗口的 chatConfig（ChatView 渲染时调用） */
export async function getChatConfig(windowId: string): Promise<ChatWindowConfig | null> {
  const api = requireElectron();
  return api.chat.getChatConfig(windowId);
}

/** 监听主进程请求打开对话窗口配置（Alt+Q 无窗口时触发） */
export function onChatRequestConfig(callback: () => void): () => void {
  const api = requireElectron();
  return api.chat.onRequestConfig(callback);
}

/** token 用量统计（可选按 sourceId 过滤） */
export async function getUsageStats(
  sourceId?: string,
): Promise<{ totalTokens: number; todayTokens: number; todayCount: number }> {
  const api = requireElectron();
  return api.chat.getUsageStats(sourceId);
}

/** 导出会话为 MD/JSON 并落盘（主进程弹保存对话框） */
export async function exportConversation(
  conversationId: string,
  format: 'md' | 'json',
): Promise<{ ok: boolean; filePath?: string; canceled?: boolean }> {
  const api = requireElectron();
  return api.chat.exportConversation(conversationId, format);
}

/** 导入对话（从文件） */
export async function importConversation(
  format: 'json' | 'deepseek' | 'md',
  sourceId: string,
): Promise<{ ok: boolean; canceled?: boolean; conversation?: Conversation }> {
  const api = requireElectron();
  return api.chat.importConversation(format, sourceId);
}

/** 清空所有对话 */
export async function clearConversations(
  sourceId?: string,
): Promise<{ ok: boolean; count: number }> {
  const api = requireElectron();
  return api.chat.clearConversations(sourceId);
}

/** 清空登录痕迹（可选按 profileId 过滤） */
export async function clearLoginTraces(
  profileId?: string,
): Promise<{ ok: boolean; count: number }> {
  const api = requireElectron();
  return api.chat.clearLoginTraces(profileId);
}

/** 清空窗口操作痕迹（可选按 windowId 过滤） */
export async function clearWindowTraces(
  windowId?: string,
): Promise<{ ok: boolean; count: number }> {
  const api = requireElectron();
  return api.chat.clearWindowTraces(windowId);
}

/** 更新消息 */
export async function updateMessage(
  messageId: string,
  updates: Partial<Pick<ChatMessage, 'content' | 'role'>>,
): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.chat.updateMessage(messageId, updates);
}

/** 删除单条消息 */
export async function deleteMessage(
  messageId: string,
): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.chat.deleteMessage(messageId);
}

/** 更新会话（标题等） */
export async function updateConversation(
  id: string,
  updates: { title?: string },
): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.chat.updateConversation(id, updates);
}

/* =====================================================================
   使用统计与操作日志 —— 对应 window.electron.chat 的 usage trace 方法
   ===================================================================== */

/** 清空所有使用统计与点击日志 */
export async function clearUsageTraces(): Promise<{ ok: boolean; count: number }> {
  const api = requireElectron();
  return api.chat.clearUsageTraces();
}
