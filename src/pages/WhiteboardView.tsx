/* =====================================================================
   pages/WhiteboardView.tsx —— 白板（v2：tldraw + 多白板）
   架构：
   - 容器组件 WhiteboardView：状态 + 数据加载 + IPC 订阅
   - 展示子组件 WhiteboardSidebar：白板列表 + 新建/重命名/删除/切换
   - 展示子组件 WhiteboardCanvas：tldraw 画布 + snapshot 加载/保存
   持久化：debounce 500ms → SQLite snapshot + beforeunload 同步兜底
   图片资源：whiteboard-asset:// 协议（硬约束）
   ===================================================================== */

import { useEffect, useMemo, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Tldraw, createTLStore, defaultShapeUtils } from '@tldraw/tldraw';
import { getSnapshot, loadSnapshot } from '@tldraw/editor';
import { toRichText } from '@tldraw/tlschema';
import type { Editor, TLStore, TLAsset, TLShape, TLTextShape, TLImageShape, TLArrowShape } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
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
// tldraw asset URL 覆盖：en 用 data URL（内联回退）；zh-cn 走 CDN 拉取真实中文翻译
// ============================================================================
const TLDRAW_ASSET_URLS = {
  translations: {
    en: 'data:application/json,{}',
  },
} as const;

// ============================================================================
// 遗留数据转换：v1 WhiteboardState → tldraw TLStore
// ============================================================================

/**
 * 将旧版 WhiteboardState（cards/arrows/strokes）转换为 tldraw shapes，
 * 并装入一个新的 TLStore 返回。
 */
function convertLegacySnapshot(legacy: WhiteboardState): TLStore {
  const store = createTLStore({ shapeUtils: defaultShapeUtils });
  const shapes: TLShape[] = [];
  let shapeIndex = 0;
  // 生成 z-order 索引（a1, a2, ...）和默认父页面
  const nextIndex = () => `a${++shapeIndex}` as TLShape['index'];
  const parentId = 'page:page' as TLShape['parentId'];

  // 卡片 → text/image/geo shapes
  for (const card of legacy.cards ?? []) {
    if (card.type === 'image') {
      const w = card.width ?? 400;
      const h = card.height ?? 300;
      const assetId = `asset:${card.id}` as TLAsset['id'];
      const asset: TLAsset = {
        id: assetId,
        typeName: 'asset',
        type: 'image',
        props: {
          name: `image-${card.id.slice(0, 8)}`,
          src: card.content,
          w,
          h,
          mimeType: 'image/png',
          isAnimated: false,
        },
        meta: {},
      };
      store.put([asset]);
      const shape: TLImageShape = {
        id: `shape:${card.id}` as TLImageShape['id'],
        typeName: 'shape',
        type: 'image',
        parentId,
        index: nextIndex(),
        x: card.x,
        y: card.y,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        props: {
          w,
          h,
          assetId,
          playing: false,
          url: '',
          crop: null,
          flipX: false,
          flipY: false,
          altText: '',
        },
        meta: {},
      };
      shapes.push(shape);
    } else {
      // text / ai-reply → text shape
      const w = card.width ?? 240;
      const shape: TLTextShape = {
        id: `shape:${card.id}` as TLTextShape['id'],
        typeName: 'shape',
        type: 'text',
        parentId,
        index: nextIndex(),
        x: card.x,
        y: card.y,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        props: {
          color: 'black',
          size: 'm',
          font: 'draw',
          textAlign: 'start',
          w,
          richText: toRichText(card.content || ' '),
          scale: 1,
          autoSize: false,
        },
        meta: {},
      };
      shapes.push(shape);
    }
  }

  // 箭头 → arrow shapes（v5：start/end 为 VecModel {x,y}，绑定由 TLArrowBinding 记录承载）
  // 旧版 fromCardId/toCardId 绑定关系在 v5 中需要单独创建 binding 记录，这里简化为直线箭头
  for (const arrow of legacy.arrows ?? []) {
    const shape: TLArrowShape = {
      id: `shape:${arrow.id}` as TLArrowShape['id'],
      typeName: 'shape',
      type: 'arrow',
      parentId,
      index: nextIndex(),
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: {
        kind: 'arc',
        start: { x: 0, y: 0 },
        end: { x: 200, y: 0 },
        bend: 0,
        color: 'black',
        fill: 'none',
        size: 'm',
        dash: 'solid',
        arrowheadEnd: 'arrow',
        arrowheadStart: 'none',
        font: 'draw',
        richText: toRichText(''),
        labelColor: 'black',
        labelPosition: 0.5,
        scale: 1,
        elbowMidPoint: 0.5,
      },
      meta: {},
    };
    shapes.push(shape);
  }

  // 手绘线条 → draw shapes
  // v5 的 TLDrawShapeSegment 使用 base64 编码的 path（delta-encoded Float32/Float16），
  // 无法从旧版 points 数组直接构造；遗留手绘线条跳过转换（仅保留卡片和箭头）。
  // 如需保留，用户可在新版本中重新绘制。

  if (shapes.length > 0) {
    store.put(shapes);
  }
  return store;
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
    <div className="wb-sidebar app-sidebar-narrow">
      <div className="wb-sidebar-header">
        <span className="wb-sidebar-title">白板列表</span>
        <IconButton variant="default" aria-label="新建白板" onClick={onCreate} title="新建白板">
          +
        </IconButton>
      </div>
      <div className="wb-sidebar-list">
        {whiteboards.length === 0 && <div className="wb-sidebar-empty app-empty-state">暂无白板</div>}
        {whiteboards.map((wb) => (
          <div
            key={wb.id}
            className={`wb-sidebar-item sidebar-list-item ${wb.id === activeId ? 'active' : ''}`}
            onClick={() => editingId !== wb.id && onSelect(wb.id)}
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
              />
            ) : (
              <>
                <span className="wb-sidebar-item-title" onDoubleClick={() => handleStartRename(wb)}>
                  {wb.title || '未命名白板'}
                </span>
                <div className="wb-sidebar-item-actions">
                  <button className="wb-sidebar-item-btn" onClick={(e) => { e.stopPropagation(); handleStartRename(wb); }} title="重命名">
                    ✎
                  </button>
                  <button className="wb-sidebar-item-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(wb.id); }} title="删除">
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
  const editorRef = useRef<Editor | null>(null);
  const activeIdRef = useRef(activeId);
  const onReadyRef = useRef(onReady);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  activeIdRef.current = activeId;
  onReadyRef.current = onReady;

  // 初始化 store：从 snapshot 反序列化，或创建空 store
  const store = useMemo<TLStore>(() => {
    if (snapshot) {
      try {
        const parsed = JSON.parse(snapshot);
        // 检测遗留数据标记
        if (parsed.__legacy === true && parsed.cards) {
          const legacyStore = convertLegacySnapshot(parsed as WhiteboardState);
          return legacyStore;
        }
        // tldraw snapshot 格式：用独立函数 loadSnapshot 装入新 store
        const newStore = createTLStore({ shapeUtils: defaultShapeUtils });
        try {
          loadSnapshot(newStore, parsed);
        } catch {
          // load 失败则返回空 store
        }
        return newStore;
      } catch {
        // JSON 解析失败，创建空 store
      }
    }
    return createTLStore({ shapeUtils: defaultShapeUtils });
  }, [snapshot]);

  // 防抖保存 + beforeunload 同步兜底 + 卸载前 flush（统一委托 useAutoSaveDraft）
  const { schedule: scheduleSave } = useAutoSaveDraft<string>({
    data: activeId,
    save: () => {
      const editor = editorRef.current;
      const id = activeIdRef.current;
      if (!editor || !id) return;
      try {
        const snap = getSnapshot(editor.store);
        const json = JSON.stringify(snap);
        void saveWhiteboardSnapshot(id, json);
      } catch (err) {
        console.error('[WhiteboardCanvas] save failed:', err);
      }
    },
    saveSync: () => {
      const editor = editorRef.current;
      const id = activeIdRef.current;
      if (!editor || !id) return;
      try {
        const snap = getSnapshot(editor.store);
        const json = JSON.stringify(snap);
        saveWhiteboardSnapshotSync(id, json);
      } catch (err) {
        console.error('[WhiteboardCanvas] sync save failed:', err);
      }
    },
    debounceMs: 500,
  });

  // 卸载时取消 store.listen 订阅（flush 保存已由 useAutoSaveDraft 处理）
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // 处理 editor 就绪：注册 store 变更监听以触发自动保存
  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    // 监听 store 变更 → 防抖保存（替代 v5 已移除的 onChange prop）
    unsubscribeRef.current = store.listen(() => {
      scheduleSave();
    });
    // 通知容器：白板已 ready，可以回 ACK
    onReadyRef.current();
  }, [store, scheduleSave]);

  // 监听容器派发的插入卡片事件（跨窗口推送的截图/AI回复）
  useEffect(() => {
    const handler = async (e: Event) => {
      const editor = editorRef.current;
      if (!editor) return;
      const card = (e as CustomEvent<WhiteboardCard>).detail;
      const x = card.x ?? Math.round(Math.random() * 200 + 100);
      const y = card.y ?? Math.round(Math.random() * 200 + 100);

      if (card.type === 'image') {
        // 图片：创建 asset + image shape
        const assetId = `asset:${card.id}` as TLAsset['id'];
        const w = card.width ?? 400;
        const h = card.height ?? 300;
        const asset: TLAsset = {
          id: assetId,
          typeName: 'asset',
          type: 'image',
          props: { name: `pushed-${card.id.slice(0, 8)}`, src: card.content, w, h, mimeType: 'image/png', isAnimated: false },
          meta: {},
        };
        editor.store.put([asset]);
        editor.createShape<TLImageShape>({
          id: `shape:${card.id}` as TLImageShape['id'],
          type: 'image',
          x,
          y,
          props: { w, h, assetId, playing: false, url: '', crop: null, flipX: false, flipY: false, altText: '' },
        });
      } else {
        // 文本 / AI 回复 → text shape
        const w = card.width ?? 240;
        editor.createShape<TLTextShape>({
          id: `shape:${card.id}` as TLTextShape['id'],
          type: 'text',
          x,
          y,
          props: {
            color: 'black',
            size: 'm',
            font: 'draw',
            textAlign: 'start',
            w,
            richText: toRichText(card.content || ' '),
            scale: 1,
            autoSize: false,
          },
        });
      }
      // 触发保存
      scheduleSave();
    };
    window.addEventListener('wb-insert-card', handler);
    return () => window.removeEventListener('wb-insert-card', handler);
  }, [scheduleSave]);

  return (
    <div className="wb-canvas-wrap">
      <Tldraw
        store={store}
        onMount={handleMount}
        assetUrls={TLDRAW_ASSET_URLS}
        locale="zh-cn"
      />
    </div>
  );
}

// ============================================================================
// 容器组件：WhiteboardView
// 架构变更（v0.5.1）：onWhiteboardPushCard 订阅已提升到 AiProviderAppView 顶层，
// WhiteboardView 通过 forwardRef 暴露 insertCard / switchToWhiteboard / isReady，
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
}

const WhiteboardView = forwardRef<WhiteboardViewHandle, WhiteboardViewProps>(function WhiteboardView(
  { onClose, onReady },
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
        }
      } catch (err) {
        console.error('[WhiteboardView] init failed:', err);
        showToast('白板加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshList, loadSnapshotFor, showToast]);

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
      <div className="whiteboard-view app-view-root">
        <div className="whiteboard-empty app-empty-state">加载中…</div>
      </div>
    );
  }

  return (
    <div className="whiteboard-view">
      <div className="wb-body">
        <WhiteboardSidebar
          whiteboards={whiteboards}
          activeId={activeId}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onRename={handleRename}
          onDelete={handleDelete}
        />
        {activeId ? (
          <WhiteboardCanvas
            key={activeId}
            activeId={activeId}
            snapshot={snapshot}
            onReady={handleCanvasReady}
          />
        ) : (
          <div className="wb-canvas-empty">
            <div className="wb-canvas-empty-text app-empty-state">
              点击左侧 "+" 新建白板
              {onClose && (
                <button className="wb-canvas-empty-btn" onClick={onClose}>
                  返回
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {toast && <div className="whiteboard-toast app-toast">{toast}</div>}
    </div>
  );
});

export default WhiteboardView;
