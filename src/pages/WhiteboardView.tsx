/* =====================================================================
   pages/WhiteboardView.tsx —— 白板（v3：Excalidraw + 多白板）
   架构：
   - 容器组件 WhiteboardView：状态 + 数据加载 + IPC 订阅
   - 展示子组件 WhiteboardSidebar：白板列表 + 新建/重命名/删除/切换
   - 展示子组件 WhiteboardCanvas：Excalidraw 画布 + 场景加载/保存
   持久化：debounce 500ms → SQLite scene JSON + beforeunload 同步兜底
   图片资源：whiteboard-asset:// 协议（硬约束，加载时转 dataURL 喂给 Excalidraw）
   许可证：Excalidraw 使用 MIT，可商用（替代 tldraw 专有许可证）
   ===================================================================== */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Excalidraw,
  serializeAsJSON,
  convertToExcalidrawElements,
  FONT_FAMILY,
  MIME_TYPES,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  BinaryFileData,
  DataURL,
} from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import {
  listWhiteboards,
  createWhiteboard,
  renameWhiteboard,
  deleteWhiteboard,
  getActiveWhiteboardId,
  setActiveWhiteboardId,
  getWhiteboardSnapshot,
  saveWhiteboardSnapshot,
  saveWhiteboardSnapshotSync,
  onWhiteboardPushImage,
  getAppSettings,
  updateAppSettings,
} from '../lib/electron-api';
import type { WhiteboardMeta, WhiteboardState, WhiteboardPushImagePayload } from '../lib/electron-api';
import { IconButton, EmptyState } from '../components/ui';
import SidebarShell from '../components/SidebarShell';
import { useToast } from '../hooks/useToast';
import { useAutoSaveDraft } from '../hooks/useAutoSaveDraft';
import './WhiteboardView.css';

// ============================================================================
// 工具：whiteboard-asset:// → dataURL
// Excalidraw 的 files map 需要 dataURL，而 WhiteboardCard.content 存的是
// whiteboard-asset:// 协议路径。插入前先 fetch 转 dataURL。
// ============================================================================
async function assetUrlToDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error('[WhiteboardView] asset → dataURL 转换失败:', url, err);
    throw err;
  }
}

/** 加载 dataURL 图片获取原始尺寸（用于 Excalidraw image 元素 width/height） */
function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

/**
 * 需求 12：将推送的截图注入当前 Excalidraw 场景。
 * 流程：assetUrl → dataURL → 加载尺寸 → addFiles + updateScene + scrollToContent。
 * 图片最大宽度 400px（与 v1 一致），超出按比例缩放。
 */
async function injectPushedImageIntoCanvas(
  api: ExcalidrawImperativeAPI,
  payload: WhiteboardPushImagePayload,
): Promise<void> {
  // 1. assetUrl → dataURL
  const dataUrl = await assetUrlToDataUrl(payload.assetUrl);
  // 2. 加载图片获取原始尺寸
  const { width: naturalWidth, height: naturalHeight } = await loadImageSize(dataUrl);
  const MAX_W = 400;
  const scale = naturalWidth > MAX_W ? MAX_W / naturalWidth : 1;
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);
  // 3. 生成 fileId + BinaryFileData，添加到 Excalidraw files map
  const fileId = `file_push_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` as FileId;
  api.addFiles([
    {
      mimeType: MIME_TYPES.png,
      id: fileId,
      dataURL: dataUrl as DataURL,
      created: Date.now(),
    },
  ]);
  // 4. 创建 image 元素并追加到当前场景（保留已有元素）
  const newElements = convertToExcalidrawElements(
    [
      {
        type: 'image',
        // 随机偏移避免多张截图重叠
        x: 80 + Math.round(Math.random() * 200),
        y: 80 + Math.round(Math.random() * 120),
        width,
        height,
        fileId,
      },
    ],
    { regenerateIds: false },
  );
  const existing = api.getSceneElements();
  api.updateScene({ elements: [...existing, ...newElements] });
  // 5. 滚动视口到新元素
  api.scrollToContent(newElements[0], { fitToContent: true });
}

// ============================================================================
// 遗留数据转换：v1 WhiteboardState → Excalidraw initialData
// 卡片 → text/image 元素；箭头 → arrow 元素；手绘线条 → 跳过（无法精确转换）
// ============================================================================
async function convertLegacySnapshot(
  legacy: WhiteboardState,
): Promise<{ elements: ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles }> {
  const skeleton: Parameters<typeof convertToExcalidrawElements>[0] = [];
  const files: BinaryFiles = {};
  const cardIndex = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (const card of legacy.cards ?? []) {
    const x = card.x ?? 0;
    const y = card.y ?? 0;
    const w = card.width ?? 240;
    const h = card.height ?? 120;
    cardIndex.set(card.id, { x, y, w, h });

    if (card.type === 'image') {
      // 图片：转 dataURL 后装入 files map
      try {
        const dataUrl = await assetUrlToDataUrl(card.content);
        const fileId = `file_${card.id}` as FileId;
        files[fileId] = {
          mimeType: MIME_TYPES.png,
          id: fileId,
          dataURL: dataUrl as DataURL,
          created: Date.now(),
        };
        skeleton.push({
          type: 'image',
          x,
          y,
          width: w,
          height: h,
          fileId,
        });
      } catch {
        // 图片转换失败则跳过
      }
    } else {
      // text / ai-reply → text 元素
      const text = card.content || ' ';
      skeleton.push({
        type: 'text',
        text,
        x,
        y,
        width: w,
        fontSize: 16,
        fontFamily: FONT_FAMILY.Virgil,
      });
    }
  }

  // 箭头：根据 from/to 卡片坐标生成直线
  for (const arrow of legacy.arrows ?? []) {
    const from = cardIndex.get(arrow.fromCardId);
    const to = cardIndex.get(arrow.toCardId);
    if (!from || !to) continue;
    skeleton.push({
      type: 'arrow',
      x: from.x + from.w,
      y: from.y + from.h / 2,
      points: [
        [0, 0],
        [to.x - from.x - from.w, to.y + to.h / 2 - (from.y + from.h / 2)],
      ],
    });
  }

  const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false });
  return {
    elements,
    appState: { viewBackgroundColor: '#ffffff' },
    files,
  };
}

// ============================================================================
// 展示子组件：WhiteboardSidebar
// ============================================================================

interface WhiteboardSidebarProps {
  whiteboards: WhiteboardMeta[];
  activeId: string | null;
  width: number;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onResize: (w: number) => void;
  onToggleCollapse: () => void;
  onOpenSettings?: () => void;
}

function WhiteboardSidebar({ whiteboards, activeId, width, collapsed, onSelect, onCreate, onRename, onDelete, onResize, onToggleCollapse, onOpenSettings }: WhiteboardSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const handleStartRename = (wb: WhiteboardMeta) => {
    setEditingId(wb.id);
    setEditingTitle(wb.title);
  };

  const handleCommitRename = () => {
    if (editingId && editingTitle.trim()) {
      onRename(editingId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  return (
    <SidebarShell
      collapsed={collapsed}
      width={width}
      onResize={onResize}
      onToggleCollapse={onToggleCollapse}
      onOpenSettings={onOpenSettings}
      onNew={onCreate}
      newTitle="新建白板"
      dataName="advanced-panel.wb-sidebar"
      header={
        <div className="sidebar-shell-header" data-name="advanced-panel.wb-sidebar-header">
          <IconButton
            type="button"
            className="sidebar-shell-new-btn"
            onClick={onCreate}
            title="新建白板"
            aria-label="新建白板"
            data-name="advanced-panel.wb-sidebar-create-button"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </IconButton>
        </div>
      }
    >
      <div className="sidebar-shell-list" data-name="advanced-panel.wb-sidebar-list">
        {whiteboards.length === 0 && <EmptyState message="暂无白板" className="wb-sidebar-empty" data-name="advanced-panel.wb-sidebar-empty" />}
        {whiteboards.map((wb, idx) => (
          <div
            key={wb.id}
            className={`wb-sidebar-item sidebar-list-item ${wb.id === activeId ? 'active' : ''}`}
            onClick={() => editingId !== wb.id && onSelect(wb.id)}
            data-name={`advanced-panel.wb-sidebar-item-${idx + 1}`}
            data-index={idx + 1}
            data-id={wb.id}
          >
            {editingId === wb.id ? (
              <input
                className="wb-sidebar-edit"
                value={editingTitle}
                autoFocus
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={handleCommitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCommitRename();
                  if (e.key === 'Escape') {
                    setEditingId(null);
                    setEditingTitle('');
                  }
                }}
                data-name={`advanced-panel.wb-sidebar-item-${idx + 1}-rename-input`}
              />
            ) : (
              <>
                <span className="wb-sidebar-item-title" onDoubleClick={() => handleStartRename(wb)} data-name={`advanced-panel.wb-sidebar-item-${idx + 1}-title`}>
                  {wb.title || '未命名白板'}
                </span>
                <div className="wb-sidebar-item-actions" data-name={`advanced-panel.wb-sidebar-item-${idx + 1}-actions`}>
                  <button className="wb-sidebar-item-btn" onClick={(e) => { e.stopPropagation(); handleStartRename(wb); }} title="重命名" aria-label="重命名" data-name={`advanced-panel.wb-sidebar-item-${idx + 1}-rename-button`}>
                    ✎
                  </button>
                  <button className="wb-sidebar-item-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(wb.id); }} title="删除" aria-label="删除白板" data-name={`advanced-panel.wb-sidebar-item-${idx + 1}-delete-button`}>
                    ×
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </SidebarShell>
  );
}

// ============================================================================

interface WhiteboardCanvasProps {
  activeId: string;
  snapshot: string | null;
}

function WhiteboardCanvas({ activeId, snapshot }: WhiteboardCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const activeIdRef = useRef(activeId);
  // 最新场景数据 ref（用于防抖保存读取）
  const latestSceneRef = useRef<{ elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null>(null);
  // 是否完成首次加载（避免 initialData 还原触发保存覆盖空数据）
  const hydratedRef = useRef(false);
  // 需求 12：截图推送到达时若 Excalidraw API 尚未就绪，暂存待处理载荷
  const pendingImageRef = useRef<WhiteboardPushImagePayload | null>(null);

  activeIdRef.current = activeId;

  // 初始化数据：snapshot 反序列化，或遗留数据转换，或空场景
  // initialData 接受 Promise，可异步处理遗留图片转换
  const initialData = useMemo(() => {
    hydratedRef.current = false;
    if (!snapshot) return null;
    try {
      const parsed = JSON.parse(snapshot);
      // 遗留数据检测（v1 WhiteboardState）
      if (parsed.__legacy === true && parsed.cards) {
        return convertLegacySnapshot(parsed as WhiteboardState);
      }
      // Excalidraw 场景格式：直接返回（restore 由 Excalidraw 内部完成）
      return parsed as { elements: ExcalidrawElement[]; appState: Partial<AppState>; files?: BinaryFiles };
    } catch {
      return null;
    }
  }, [snapshot]);

  // 防抖保存 + beforeunload 同步兜底（统一委托 useAutoSaveDraft）
  const { schedule: scheduleSave } = useAutoSaveDraft<string>({
    data: activeId,
    save: () => {
      const api = apiRef.current;
      const id = activeIdRef.current;
      const scene = latestSceneRef.current;
      if (!api || !id || !scene) return;
      try {
        const json = serializeAsJSON(
          scene.elements as readonly ExcalidrawElement[],
          scene.appState,
          scene.files,
          'local',
        );
        void saveWhiteboardSnapshot(id, json);
      } catch (err) {
        console.error('[WhiteboardCanvas] save failed:', err);
      }
    },
    saveSync: () => {
      const api = apiRef.current;
      const id = activeIdRef.current;
      const scene = latestSceneRef.current;
      if (!api || !id || !scene) return;
      try {
        const json = serializeAsJSON(
          scene.elements as readonly ExcalidrawElement[],
          scene.appState,
          scene.files,
          'local',
        );
        saveWhiteboardSnapshotSync(id, json);
      } catch (err) {
        console.error('[WhiteboardCanvas] sync save failed:', err);
      }
    },
    debounceMs: 500,
  });

  // onChange：缓存最新场景 + 触发防抖保存
  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      latestSceneRef.current = { elements, appState, files };
      // 首次 hydration 完成后才保存（避免 initialData 触发 onChange 覆盖）
      if (hydratedRef.current) {
        scheduleSave();
      }
    },
    [scheduleSave],
  );

  // excalidrawAPI 就绪回调
  const handleAPIReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      // 标记 hydration 完成（下一帧后允许保存）
      requestAnimationFrame(() => {
        hydratedRef.current = true;
      });
      // 需求 12：处理 API 就绪前到达的截图推送
      const pending = pendingImageRef.current;
      if (pending) {
        pendingImageRef.current = null;
        void injectPushedImageIntoCanvas(api, pending).catch((err) => {
          console.error('[WhiteboardCanvas] 注入暂存截图失败:', err);
        });
      }
    },
    [],
  );

  // 需求 12：订阅主进程推送的截图，注入当前 Excalidraw 场景
  // 订阅在挂载时一次注册；回调读取 apiRef.current 判断 API 是否就绪
  useEffect(() => {
    const off = onWhiteboardPushImage((payload) => {
      const api = apiRef.current;
      if (!api) {
        // API 未就绪：暂存，等 handleAPIReady 处理
        pendingImageRef.current = payload;
        return;
      }
      void injectPushedImageIntoCanvas(api, payload).catch((err) => {
        console.error('[WhiteboardCanvas] 注入截图失败:', err);
      });
    });
    return off;
  }, []);

  return (
    <div className="wb-canvas-wrap" data-name="advanced-panel.wb-canvas">
      <Excalidraw
        initialData={initialData}
        onChange={handleChange}
        excalidrawAPI={handleAPIReady}
        langCode="zh-CN"
        name="SidekickAI 白板"
      />
    </div>
  );
}

// ============================================================================
// 容器组件：WhiteboardView
// ============================================================================

interface WhiteboardViewProps {
  onClose?: () => void;
  sidebarVisible?: boolean;
  onOpenSettings?: () => void;
}

function WhiteboardView({ onClose, sidebarVisible = false, onOpenSettings }: WhiteboardViewProps) {
  const [whiteboards, setWhiteboards] = useState<WhiteboardMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(130);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { toast, showToast } = useToast();

  // 加载白板列表 + 激活白板 snapshot
  const refreshList = useCallback(async () => {
    const list = await listWhiteboards();
    setWhiteboards(list);
    return list;
  }, []);

  const loadSnapshotFor = useCallback(async (id: string) => {
    const snap = await getWhiteboardSnapshot(id);
    setSnapshot(snap);
  }, []);

  // 读取侧边栏宽度/收起设置
  useEffect(() => {
    void getAppSettings().then((cfg) => {
      setSidebarWidth(cfg.whiteboardSidebarWidth ?? 130);
      setSidebarCollapsed(cfg.whiteboardSidebarCollapsed ?? false);
    }).catch(() => {});
  }, []);

  // 初始化
  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        const active = await getActiveWhiteboardId();
        if (active && list.some((w) => w.id === active)) {
          setActiveId(active);
          await loadSnapshotFor(active);
        } else if (list.length > 0) {
          setActiveId(list[0].id);
          await setActiveWhiteboardId(list[0].id);
          await loadSnapshotFor(list[0].id);
        } else if (!sidebarVisible) {
          // 侧边栏隐藏时无白板：自动新建一个，避免用户无入口可点
          const wb = await createWhiteboard();
          await refreshList();
          setActiveId(wb.id);
          await setActiveWhiteboardId(wb.id);
          setSnapshot(null);
        }
      } catch (err) {
        console.error('[WhiteboardView] init failed:', err);
        showToast('白板加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshList, loadSnapshotFor, showToast, sidebarVisible]);

  // 新建白板
  const handleCreate = useCallback(async () => {
    try {
      const wb = await createWhiteboard();
      await refreshList();
      setActiveId(wb.id);
      await setActiveWhiteboardId(wb.id);
      setSnapshot(null);
    } catch (err) {
      console.error('[WhiteboardView] create failed:', err);
      showToast('新建白板失败');
    }
  }, [refreshList, showToast]);

  // 切换白板
  const handleSelect = useCallback(async (id: string) => {
    setActiveId(id);
    await setActiveWhiteboardId(id);
    await loadSnapshotFor(id);
  }, [loadSnapshotFor]);

  // 重命名
  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      await renameWhiteboard(id, title);
      await refreshList();
    } catch (err) {
      console.error('[WhiteboardView] rename failed:', err);
      showToast('重命名失败');
    }
  }, [refreshList, showToast]);

  // 删除
  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteWhiteboard(id);
      const list = await refreshList();
      if (activeId === id) {
        if (list.length > 0) {
          setActiveId(list[0].id);
          await setActiveWhiteboardId(list[0].id);
          await loadSnapshotFor(list[0].id);
        } else {
          setActiveId(null);
          await setActiveWhiteboardId(null);
          setSnapshot(null);
        }
      }
    } catch (err) {
      console.error('[WhiteboardView] delete failed:', err);
      showToast('删除失败');
    }
  }, [refreshList, activeId, loadSnapshotFor, showToast]);

  // 侧边栏拖拽调宽
  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w);
    void updateAppSettings({ whiteboardSidebarWidth: w });
  }, []);

  // 侧边栏收起/展开
  const handleSidebarToggleCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    void updateAppSettings({ whiteboardSidebarCollapsed: next });
  }, [sidebarCollapsed]);

  if (loading) {
    return (
      <div className="whiteboard-view app-view-root" data-name="advanced-panel.whiteboard-view-loading">
        <EmptyState message="加载中…" loading className="whiteboard-empty" data-name="advanced-panel.whiteboard-loading-text" />
      </div>
    );
  }

  return (
    <div className="whiteboard-view" data-name="advanced-panel.whiteboard-view">
      <div className="wb-body" data-name="advanced-panel.wb-body">
        {sidebarVisible && (
          <WhiteboardSidebar
            whiteboards={whiteboards}
            activeId={activeId}
            width={sidebarWidth}
            collapsed={sidebarCollapsed}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
            onResize={handleSidebarResize}
            onToggleCollapse={handleSidebarToggleCollapse}
            onOpenSettings={onOpenSettings}
          />
        )}
        {activeId ? (
          <WhiteboardCanvas
            key={activeId}
            activeId={activeId}
            snapshot={snapshot}
          />
        ) : (
          <div className="wb-canvas-empty" data-name="advanced-panel.wb-canvas-empty">
            <EmptyState
              message={<>
                {sidebarVisible ? '点击左侧 "+" 新建白板' : '正在初始化白板…'}
                {onClose && (
                  <button className="btn-outline wb-canvas-empty-btn" onClick={onClose} data-name="advanced-panel.wb-canvas-empty-back-button">
                    返回
                  </button>
                )}
              </>}
              className="wb-canvas-empty-text"
              data-name="advanced-panel.wb-canvas-empty-text"
            />
          </div>
        )}
      </div>
      {toast && <div className="whiteboard-toast app-toast" data-name="advanced-panel.whiteboard-toast">{toast}</div>}
    </div>
  );
}

export default WhiteboardView;
