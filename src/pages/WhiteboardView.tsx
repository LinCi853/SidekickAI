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

import { useEffect, useMemo, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
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
} from '../lib/electron-api';
import type { WhiteboardMeta, WhiteboardCard, WhiteboardState } from '../lib/electron-api';
import { IconButton } from '../components/ui';
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
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function WhiteboardSidebar({ whiteboards, activeId, onSelect, onCreate, onRename, onDelete }: WhiteboardSidebarProps) {
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
    <div className="wb-sidebar app-sidebar-narrow" data-name="advanced-panel.wb-sidebar">
      <div className="wb-sidebar-header" data-name="advanced-panel.wb-sidebar-header">
        <span className="wb-sidebar-title" data-name="advanced-panel.wb-sidebar-title">白板列表</span>
        <IconButton variant="default" aria-label="新建白板" onClick={onCreate} title="新建白板" data-name="advanced-panel.wb-sidebar-create-button">
          +
        </IconButton>
      </div>
      <div className="wb-sidebar-list" data-name="advanced-panel.wb-sidebar-list">
        {whiteboards.length === 0 && <div className="wb-sidebar-empty app-empty-state" data-name="advanced-panel.wb-sidebar-empty">暂无白板</div>}
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
    </div>
  );
}

// ============================================================================

interface WhiteboardCanvasProps {
  activeId: string;
  snapshot: string | null;
  /** editor 就绪回调（用于父组件触发 ACK） */
  onReady: () => void;
}

function WhiteboardCanvas({ activeId, snapshot, onReady }: WhiteboardCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const activeIdRef = useRef(activeId);
  const onReadyRef = useRef(onReady);
  // 最新场景数据 ref（用于防抖保存读取）
  const latestSceneRef = useRef<{ elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null>(null);
  // 是否完成首次加载（避免 initialData 还原触发保存覆盖空数据）
  const hydratedRef = useRef(false);

  activeIdRef.current = activeId;
  onReadyRef.current = onReady;

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
      // 通知容器：白板已 ready，可以回 ACK
      onReadyRef.current();
    },
    [],
  );

  // 监听容器派发的插入卡片事件（跨窗口推送的截图/AI回复）
  useEffect(() => {
    const handler = async (e: Event) => {
      const api = apiRef.current;
      if (!api) return;
      const card = (e as CustomEvent<WhiteboardCard>).detail;
      const x = card.x ?? Math.round(Math.random() * 200 + 100);
      const y = card.y ?? Math.round(Math.random() * 200 + 100);

      if (card.type === 'image') {
        // 图片：fetch whiteboard-asset:// → dataURL → addFiles + image 元素
        try {
          const dataUrl = await assetUrlToDataUrl(card.content);
          const fileId = `file_${card.id}` as FileId;
          const file: BinaryFileData = {
            mimeType: MIME_TYPES.png,
            id: fileId,
            dataURL: dataUrl as DataURL,
            created: Date.now(),
          };
          api.addFiles([file]);
          const w = card.width ?? 400;
          const h = card.height ?? 300;
          const newElements = convertToExcalidrawElements(
            [
              {
                type: 'image',
                x,
                y,
                width: w,
                height: h,
                fileId,
              },
            ],
            { regenerateIds: false },
          );
          api.updateScene({ elements: [...api.getSceneElements(), ...newElements] });
        } catch (err) {
          console.error('[WhiteboardCanvas] 插入图片卡片失败:', err);
        }
      } else {
        // 文本 / AI 回复 → text 元素
        const text = card.content || ' ';
        const newElements = convertToExcalidrawElements(
          [
            {
              type: 'text',
              text,
              x,
              y,
              width: card.width ?? 240,
              fontSize: 16,
              fontFamily: FONT_FAMILY.Virgil,
            },
          ],
          { regenerateIds: false },
        );
        api.updateScene({ elements: [...api.getSceneElements(), ...newElements] });
      }
      // 触发保存
      scheduleSave();
    };
    window.addEventListener('wb-insert-card', handler);
    return () => window.removeEventListener('wb-insert-card', handler);
  }, [scheduleSave]);

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
// 架构变更（v0.5.1）：onWhiteboardPushCard 订阅已提升到 AdvancedPanelView 顶层，
// WhiteboardView 通过 forwardRef 暴露 insertCard / switchToWhiteboard / isReady,
// 供父组件在任意 tab 下统一管理跨窗口推送的卡片。
// ============================================================================

/** WhiteboardView 对外暴露的命令式 API */
export interface WhiteboardViewHandle {
  /** 插入卡片到当前激活白板（canvas 未 ready 时返回 false） */
  insertCard: (card: WhiteboardCard) => boolean;
  /** 切换到指定白板（加载 snapshot） */
  switchToWhiteboard: (id: string) => Promise<void>;
  /** canvas editor 是否已就绪 */
  isReady: () => boolean;
  /** 当前激活白板 id */
  getActiveId: () => string | null;
}

interface WhiteboardViewProps {
  onClose?: () => void;
  /** canvas ready 回调（父组件用于发送 ACK） */
  onReady?: () => void;
  /**
   * 应用层侧边栏是否可见（默认 false）。
   *
   * Excalidraw 没有内置多页面切换 UI，
   * 应用层侧边栏是管理多白板的唯一入口，默认隐藏（单白板模式）。
   * 如需传统的列表管理可在设置中开启。
   */
  sidebarVisible?: boolean;
}

const WhiteboardView = forwardRef<WhiteboardViewHandle, WhiteboardViewProps>(function WhiteboardView(
  { onClose, onReady, sidebarVisible = false },
  ref,
) {
  const [whiteboards, setWhiteboards] = useState<WhiteboardMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast, showToast } = useToast();

  // canvas editor 就绪状态（ref 避免 re-render）
  const canvasReadyRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

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

  // canvas ready 回调：标记就绪 + 通知父组件
  const handleCanvasReady = useCallback(() => {
    canvasReadyRef.current = true;
    onReadyRef.current?.();
  }, []);

  // ===== 命令式 API（供父组件通过 ref 调用） =====
  useImperativeHandle(ref, () => ({
    insertCard: (card: WhiteboardCard) => {
      if (!canvasReadyRef.current || !activeId) return false;
      // 通过自定义事件通知 WhiteboardCanvas 内部的监听器执行插入
      window.dispatchEvent(new CustomEvent('wb-insert-card', { detail: card }));
      return true;
    },
    switchToWhiteboard: async (id: string) => {
      if (id === activeId) return;
      canvasReadyRef.current = false; // 切换白板后需等待新 canvas 重新 ready
      setActiveId(id);
      await setActiveWhiteboardId(id);
      await loadSnapshotFor(id);
    },
    isReady: () => canvasReadyRef.current,
    getActiveId: () => activeId,
  }), [activeId, loadSnapshotFor]);

  if (loading) {
    return (
      <div className="whiteboard-view app-view-root" data-name="advanced-panel.whiteboard-view-loading">
        <div className="whiteboard-empty app-empty-state" data-name="advanced-panel.whiteboard-loading-text">加载中…</div>
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
            onSelect={handleSelect}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        )}
        {activeId ? (
          <WhiteboardCanvas
            key={activeId}
            activeId={activeId}
            snapshot={snapshot}
            onReady={handleCanvasReady}
          />
        ) : (
          <div className="wb-canvas-empty" data-name="advanced-panel.wb-canvas-empty">
            <div className="wb-canvas-empty-text app-empty-state" data-name="advanced-panel.wb-canvas-empty-text">
              {sidebarVisible ? '点击左侧 "+" 新建白板' : '正在初始化白板…'}
              {onClose && (
                <button className="btn-outline wb-canvas-empty-btn" onClick={onClose} data-name="advanced-panel.wb-canvas-empty-back-button">
                  返回
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {toast && <div className="whiteboard-toast app-toast" data-name="advanced-panel.whiteboard-toast">{toast}</div>}
    </div>
  );
});

export default WhiteboardView;
