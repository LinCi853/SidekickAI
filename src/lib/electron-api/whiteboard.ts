/* =====================================================================
   lib/electron-api/whiteboard.ts —— 白板（v3：Excalidraw + 多白板）
   对应 window.electron.whiteboard
   ===================================================================== */

import type {
  WhiteboardMeta,
} from '../../../electron/shared/types';
import { requireElectron } from './core';

export type { WhiteboardMeta };

/** 列出全部白板（按 sort_order ASC, updated_at DESC） */
export async function listWhiteboards(): Promise<WhiteboardMeta[]> {
  const api = requireElectron();
  return api.whiteboard.list();
}

/** 新建白板 */
export async function createWhiteboard(title?: string): Promise<WhiteboardMeta> {
  const api = requireElectron();
  return api.whiteboard.create(title);
}

/** 重命名白板 */
export async function renameWhiteboard(id: string, title: string): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.rename(id, title);
}

/** 删除白板 */
export async function deleteWhiteboard(id: string): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.delete(id);
}

/** 获取激活白板 id */
export async function getActiveWhiteboardId(): Promise<string | null> {
  const api = requireElectron();
  return api.whiteboard.getActive();
}

/** 设置激活白板 id */
export async function setActiveWhiteboardId(id: string | null): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.setActive(id);
}

/** 加载白板 snapshot（Excalidraw scene JSON，无则 null） */
export async function getWhiteboardSnapshot(id: string): Promise<string | null> {
  const api = requireElectron();
  return api.whiteboard.getSnapshot(id);
}

/** 异步保存 snapshot */
export async function saveWhiteboardSnapshot(id: string, snapshot: string): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.whiteboard.saveSnapshot(id, snapshot);
}

/** 同步保存 snapshot（beforeunload 兜底，sendSync 确保窗口关闭前完成写入） */
export function saveWhiteboardSnapshotSync(id: string, snapshot: string): { ok: boolean } {
  const api = requireElectron();
  return api.whiteboard.saveSnapshotSync(id, snapshot);
}
