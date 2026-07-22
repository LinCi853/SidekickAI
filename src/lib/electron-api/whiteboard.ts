/* =====================================================================
   lib/electron-api/whiteboard.ts —— 白板 AI 窗口（需求 12）
   对应 window.electron.whiteboard：浮窗 + 完整状态读写 + 推送卡片监听
   ===================================================================== */

import type {
  WhiteboardState,
  WhiteboardCard,
  WhiteboardCardInput,
} from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   白板 —— 对应 window.electron.whiteboard
   ===================================================================== */

/** 读取完整白板状态（cards + arrows + strokes + viewport） */
export async function getWhiteboardState(): Promise<WhiteboardState> {
  const api = requireElectron();
  return api.whiteboard.getState();
}

/** 保存完整白板状态（全量覆盖） */
export async function saveWhiteboardState(state: WhiteboardState): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.saveState(state);
}

/** 清空白板 */
export async function clearWhiteboard(): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.clear();
}

/**
 * 从任意窗口推送卡片到白板（需求 12：HistoryView 消息发送到白板）。
 * 主进程接收后：若白板窗口未打开则先打开，生成完整 WhiteboardCard（随机位置），
 * 再通过 WHITEBOARD_PUSH_CARD 转发给白板渲染层。
 * 返回生成的完整卡片（含 id）。
 */
export async function pushCardToWhiteboard(card: WhiteboardCardInput): Promise<WhiteboardCard> {
  const api = requireElectron();
  return api.whiteboard.pushCard(card);
}

/** 监听主进程 → 白板窗口渲染：外部推送卡片（截图 / HistoryView 拖入消息） */
export function onWhiteboardPushCard(
  callback: (card: WhiteboardCard) => void,
): () => void {
  const api = requireElectron();
  return api.whiteboard.onPushCard(callback);
}

export async function saveWhiteboardImage(dataUrl: string): Promise<string> {
  const api = requireElectron();
  return api.saveWhiteboardImage(dataUrl);
}

