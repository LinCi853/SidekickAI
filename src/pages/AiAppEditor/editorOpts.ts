/* 编辑器入参解析（从 URL 查询参数 windowId 的 Base64 JSON 解码） */

/** AI 应用编辑窗口 windowId 前缀 */
export const AI_APP_EDITOR_PREFIX = 'ai-app-editor-';

/** 编辑器入参（从 windowId 的 Base64 JSON 解析） */
export interface EditorOpts {
  platformId?: string;
  profileId?: string;
  mode?: 'edit' | 'create';
}

/** 从 URL 查询参数获取当前窗口 id */
export function getWindowId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('windowId') ?? '';
}

/** 从 windowId 解析编辑器入参（平台 ID / Profile ID / 模式） */
export function parseEditorOpts(): EditorOpts {
  const wid = getWindowId();
  if (!wid.startsWith(AI_APP_EDITOR_PREFIX)) return {};
  const encoded = wid.slice(AI_APP_EDITOR_PREFIX.length);
  try {
    // 渲染层无 Buffer，用 atob 解码 Base64
    const json = decodeURIComponent(
      atob(encoded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}
