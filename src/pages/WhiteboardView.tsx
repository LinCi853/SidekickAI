/* =====================================================================
   pages/WhiteboardView.tsx —— 白板（需求 12，嵌入模式）
   架构（v0.5.2 重构）：
   - 不再是独立窗口，作为 StandaloneView 的视图模式之一嵌入渲染
   - 父组件传入 onClose 回调（切回 webview 模式）
   - 无限画布：CSS transform 实现 viewport 平移（鼠标拖拽空白处）/缩放（Ctrl+滚轮）
   - 文本卡片：<div contenteditable>，双击进入编辑，鼠标拖动移动
   - 图片卡片：从剪贴板/拖拽接收截图，<img src="dataURL">
   - AI 回复卡片：从 HistoryView 拖入消息，渲染纯文本展示
   - 箭头：SVG <line> 连接两张卡片（按住 Alt+点击源卡片再点击目标卡片）
   - 手绘线条：SVG <path>，鼠标按下拖动绘制（工具栏切换到画笔模式）
   - 持久化：debounce 500ms 全量保存到 whiteboard.json + beforeunload 兜底
   修复（v0.5.2）：
   - 12-3: 双击进入编辑态判断（currentTarget === target）
   - 12-5: 编辑中点击外部退出编辑
   - 12-6: 删除按钮移到卡片内（避免圆角裁剪）
   - 12-7: Alt+点击同一卡片取消草稿
   - 12-8: SVG 颜色用 currentColor + 容器 color
   - 12-11: 粘贴改为 canvas tabIndex + onPaste React 事件
   - 12-12: beforeunload + flushSave 双重兜底
   - cross-2: handleDrop 检查 dataTransfer 类型，排除 dataURL
   ===================================================================== */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  getWhiteboardState,
  saveWhiteboardState,
  clearWhiteboard,
  onWhiteboardPushCard,
  sendNoteToAi,
  saveWhiteboardImage,
} from '../lib/electron-api';
import type {
  WhiteboardState,
  WhiteboardCard,
  WhiteboardArrow,
  WhiteboardStroke,
} from '../lib/electron-api';
import { IconButton } from '../components/ui';
import { useToast } from '../hooks/useToast';
import './WhiteboardView.css';

/** 生成 UUID（优先 crypto.randomUUID，回退 Math.random 组合） */
function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type Tool = 'select' | 'text' | 'pen';

interface DragState {
  type: 'move-card' | 'pan-canvas' | 'draw-stroke';
  cardId?: string;
  startCanvasX: number;
  startCanvasY: number;
  origCardX?: number;
  origCardY?: number;
  origViewportX?: number;
  origViewportY?: number;
  strokePoints?: Array<{ x: number; y: number }>;
}

interface ArrowDraft {
  fromCardId: string;
}

interface WhiteboardViewProps {
  /** 关闭白板视图（切回 webview 模式） */
  onClose?: () => void;
}

const DEFAULT_CARD_WIDTH = 220;
const DEFAULT_CARD_HEIGHT = 120;

export default function WhiteboardView({ onClose }: WhiteboardViewProps) {
  const [state, setState] = useState<WhiteboardState>({
    cards: [],
    arrows: [],
    strokes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const [tool, setTool] = useState<Tool>('select');
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [arrowDraft, setArrowDraft] = useState<ArrowDraft | null>(null);
  const { toast, showToast } = useToast();

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ===== 初始化：加载白板状态 =====
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await getWhiteboardState();
        setState(loaded);
      } catch (e) {
        console.error('[WhiteboardView] 加载白板状态失败:', e);
      }
    })();
  }, []);

  // ===== 防抖持久化（500ms） =====
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveWhiteboardState(stateRef.current).catch((e) =>
        console.error('[WhiteboardView] 保存失败:', e),
      );
    }, 500);
  }, []);

  /** 立即保存（用于 onClose / beforeunload 兜底） */
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    void saveWhiteboardState(stateRef.current).catch((e) =>
      console.error('[WhiteboardView] flushSave 失败:', e),
    );
  }, []);

  // 状态变化时触发保存
  useEffect(() => {
    scheduleSave();
  }, [state, scheduleSave]);

  // 卸载时立即保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        void saveWhiteboardState(stateRef.current).catch(() => {});
      }
    };
  }, []);

  // 12-12: beforeunload 兜底（窗口关闭/刷新时强制保存）
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      // 同步发送（无 await）
      try {
        void saveWhiteboardState(stateRef.current);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ===== 监听外部推送卡片（截图 / HistoryView 拖入消息） =====
  useEffect(() => {
    const off = onWhiteboardPushCard((card) => {
      setState((prev) => ({
        ...prev,
        cards: [...prev.cards, card],
      }));
      showToast('已添加卡片');
    });
    return off;
  }, [showToast]);

  // ===== ESC：退出编辑/选中/箭头草稿；否则触发 onClose =====
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editingCardId) {
        e.preventDefault();
        setEditingCardId(null);
      } else if (arrowDraft) {
        e.preventDefault();
        setArrowDraft(null);
      } else if (selectedCardId) {
        e.preventDefault();
        setSelectedCardId(null);
      } else {
        // 无选中状态时触发 onClose 切回 webview
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingCardId, arrowDraft, selectedCardId, onClose]);

  // ===== 工具函数：屏幕坐标 → 画布坐标 =====
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { x: vx, y: vy, zoom } = stateRef.current.viewport;
    return {
      x: (screenX - rect.left - vx) / zoom,
      y: (screenY - rect.top - vy) / zoom,
    };
  }, []);

  // ===== 新增卡片 =====
  const addCard = useCallback((type: WhiteboardCard['type'], content: string, x: number, y: number, width?: number, height?: number) => {
    const newCard: WhiteboardCard = {
      id: randomUUID(),
      type,
      x, y,
      width: width ?? DEFAULT_CARD_WIDTH,
      height: height ?? DEFAULT_CARD_HEIGHT,
      content,
      metadata: { createdAt: Date.now() },
    };
    setState((prev) => ({ ...prev, cards: [...prev.cards, newCard] }));
    if (type === 'text') setEditingCardId(newCard.id);
    return newCard;
  }, []);

  // ===== 双击空白处创建文本卡片（12-3 修复：currentTarget === target） =====
  const handleCanvasDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select' && tool !== 'text') return;
    // 仅在画布本身（非卡片）双击时触发
    if (e.currentTarget !== e.target) return;
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    addCard('text', '', x - DEFAULT_CARD_WIDTH / 2, y - DEFAULT_CARD_HEIGHT / 2);
  };

  // ===== 卡片拖动：mouseDown 启动 =====
  const handleCardMouseDown = (e: React.MouseEvent, card: WhiteboardCard) => {
    if (editingCardId === card.id) return; // 编辑中不拖动
    if (tool === 'pen') return;
    e.stopPropagation();
    // Alt+点击：箭头连接起点
    if (e.altKey) {
      setArrowDraft({ fromCardId: card.id });
      showToast('已选起点，点击目标卡片连接');
      return;
    }
    setSelectedCardId(card.id);
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    dragRef.current = {
      type: 'move-card',
      cardId: card.id,
      startCanvasX: x,
      startCanvasY: y,
      origCardX: card.x,
      origCardY: card.y,
    };
  };

  // ===== 卡片点击：完成箭头 / 选中（12-7 修复：Alt+点击同一卡片取消草稿） =====
  const handleCardClick = (e: React.MouseEvent, card: WhiteboardCard) => {
    if (!arrowDraft) return;
    e.stopPropagation();
    if (arrowDraft.fromCardId === card.id) {
      // 点击同一卡片：取消草稿
      setArrowDraft(null);
      showToast('已取消箭头连接');
      return;
    }
    const newArrow: WhiteboardArrow = {
      id: randomUUID(),
      fromCardId: arrowDraft.fromCardId,
      toCardId: card.id,
    };
    setState((prev) => ({ ...prev, arrows: [...prev.arrows, newArrow] }));
    setArrowDraft(null);
    showToast('已连接');
  };

  // ===== 画布 mouseDown：平移 / 绘制（12-5 修复：编辑中点击外部退出编辑） =====
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.currentTarget !== e.target) return;
    // 12-5: 编辑中点击空白处退出编辑
    if (editingCardId) {
      setEditingCardId(null);
    }
    // 点击空白处取消箭头草稿
    if (arrowDraft) {
      setArrowDraft(null);
      return;
    }
    setSelectedCardId(null);
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    if (tool === 'pen') {
      dragRef.current = {
        type: 'draw-stroke',
        startCanvasX: x,
        startCanvasY: y,
        strokePoints: [{ x, y }],
      };
    } else {
      dragRef.current = {
        type: 'pan-canvas',
        startCanvasX: e.clientX,
        startCanvasY: e.clientY,
        origViewportX: stateRef.current.viewport.x,
        origViewportY: stateRef.current.viewport.y,
      };
    }
  };

  // ===== 全局 mouseMove：处理拖动（12-8 修复：SVG 用 currentColor） =====
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.type === 'move-card' && drag.cardId) {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        const dx = (x - drag.startCanvasX);
        const dy = (y - drag.startCanvasY);
        setState((prev) => ({
          ...prev,
          cards: prev.cards.map((c) =>
            c.id === drag.cardId
              ? { ...c, x: (drag.origCardX ?? 0) + dx, y: (drag.origCardY ?? 0) + dy }
              : c,
          ),
        }));
      } else if (drag.type === 'pan-canvas') {
        const dx = e.clientX - drag.startCanvasX;
        const dy = e.clientY - drag.startCanvasY;
        setState((prev) => ({
          ...prev,
          viewport: {
            ...prev.viewport,
            x: (drag.origViewportX ?? 0) + dx,
            y: (drag.origViewportY ?? 0) + dy,
          },
        }));
      } else if (drag.type === 'draw-stroke' && drag.strokePoints) {
        const { x, y } = screenToCanvas(e.clientX, e.clientY);
        drag.strokePoints.push({ x, y });
        // 实时更新预览：通过 state 中临时 stroke
        setState((prev) => {
          const existing = prev.strokes.find((s) => s.id === '__drawing__');
          const points = drag.strokePoints ?? [];
          if (existing) {
            return {
              ...prev,
              strokes: prev.strokes.map((s) =>
                s.id === '__drawing__' ? { ...s, points } : s,
              ),
            };
          }
          const newStroke: WhiteboardStroke = {
            id: '__drawing__',
            points,
            color: 'currentColor', // 12-8: 用 currentColor，由 SVG 容器 color 控制
            width: 2,
          };
          return { ...prev, strokes: [...prev.strokes, newStroke] };
        });
      }
    };
    const handleUp = () => {
      const drag = dragRef.current;
      if (drag?.type === 'draw-stroke') {
        // 提交手绘线条：把临时 id 替换为正式 id
        setState((prev) => {
          const drawing = prev.strokes.find((s) => s.id === '__drawing__');
          if (!drawing || drawing.points.length < 2) {
            return { ...prev, strokes: prev.strokes.filter((s) => s.id !== '__drawing__') };
          }
          const final: WhiteboardStroke = { ...drawing, id: randomUUID() };
          return { ...prev, strokes: [...prev.strokes.filter((s) => s.id !== '__drawing__'), final] };
        });
      }
      dragRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [screenToCanvas]);

  // ===== Ctrl+滚轮缩放 =====
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setState((prev) => {
      const newZoom = Math.max(0.25, Math.min(4, prev.viewport.zoom * (1 + delta)));
      return { ...prev, viewport: { ...prev.viewport, zoom: newZoom } };
    });
  };

  // ===== 编辑卡片内容 =====
  const handleCardEdit = (id: string, content: string) => {
    setState((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, content } : c)),
    }));
  };

  // ===== 删除选中卡片 =====
  const handleDeleteCard = (id: string) => {
    setState((prev) => ({
      ...prev,
      cards: prev.cards.filter((c) => c.id !== id),
      arrows: prev.arrows.filter((a) => a.fromCardId !== id && a.toCardId !== id),
    }));
    if (selectedCardId === id) setSelectedCardId(null);
    if (editingCardId === id) setEditingCardId(null);
  };

  // ===== 右键菜单：AI 呼出（总结/翻译/扩展） =====
  const handleContextMenu = (e: React.MouseEvent, card: WhiteboardCard) => {
    e.preventDefault();
    e.stopPropagation();
    if (!card.content.trim()) return;
    const text = card.content;
    const action = window.prompt(
      '选择操作（输入数字）:\n1. 总结\n2. 翻译为英文\n3. 扩展\n4. 发送到 AI 输入框',
      '1',
    );
    if (!action) return;
    let prompt = text;
    if (action === '1') prompt = `请总结以下内容：\n\n${text}`;
    else if (action === '2') prompt = `请将以下内容翻译为英文：\n\n${text}`;
    else if (action === '3') prompt = `请扩展以下内容：\n\n${text}`;
    addCard('ai-reply', prompt, card.x + (card.width ?? DEFAULT_CARD_WIDTH) + 40, card.y);
    void sendNoteToAi(prompt, false).then((result) => {
      if (result.ok) {
        showToast('已发送到 AI 输入框');
      } else {
        showToast(result.error ?? '发送失败');
      }
    }).catch((err) => {
      console.error('[WhiteboardView] 发送到 AI 失败:', err);
      showToast('发送失败');
    });
  };

  // ===== 清空白板 =====
  const handleClear = async () => {
    if (!confirm('确定清空白板？所有卡片、箭头、手绘线条将被删除。')) return;
    try {
      await clearWhiteboard();
      setState({ cards: [], arrows: [], strokes: [], viewport: { x: 0, y: 0, zoom: 1 } });
      showToast('已清空');
    } catch (e) {
      console.error('[WhiteboardView] 清空失败:', e);
      showToast('清空失败');
    }
  };

  // ===== 关闭白板（触发 onClose 前 flushSave） =====
  const handleClose = useCallback(() => {
    flushSave();
    onClose?.();
  }, [flushSave, onClose]);

  // ===== 粘贴图片（12-11 修复：改为 canvas tabIndex + onPaste React 事件） =====
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataURL = reader.result as string;
          const filePath = await saveWhiteboardImage(dataURL);
          // Load natural dimensions to size the card appropriately
          const img = new Image();
          img.onload = () => {
            const MAX_W = 600, MAX_H = 400;
            let w = img.naturalWidth || MAX_W;
            let h = img.naturalHeight || MAX_H;
            const scale = Math.min(MAX_W / w, MAX_H / h, 1);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const { x, y } = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
            addCard('image', filePath, x - w / 2, y - h / 2, w, h);
          };
          img.onerror = () => {
            // Fallback to default size if image fails to load
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const { x, y } = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
            addCard('image', filePath, x - 100, y - 75);
          };
          img.src = dataURL;
        };
        reader.readAsDataURL(file);
        e.preventDefault();
        break;
      }
    }
  };

  // ===== 拖拽接收（文件图片自动尺寸 / 纯文本卡片） =====
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 优先处理文件类图片（只取第一个图片文件，避免拖拽多张图片重复添加卡片）
    const files = e.dataTransfer.files;
    if (files && files.length > 0 && files[0].type.startsWith('image/')) {
      const file = files[0];
      const reader = new FileReader();
      reader.onload = async () => {
        const dataURL = reader.result as string;
        const filePath = await saveWhiteboardImage(dataURL);
        // Load natural dimensions to size the card appropriately
        const img = new Image();
        img.onload = () => {
          const MAX_W = 600, MAX_H = 400;
          let w = img.naturalWidth || MAX_W;
          let h = img.naturalHeight || MAX_H;
          const scale = Math.min(MAX_W / w, MAX_H / h, 1);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          addCard('image', filePath, x - w / 2, y - h / 2, w, h);
        };
        img.onerror = () => {
          const { x, y } = screenToCanvas(e.clientX, e.clientY);
          addCard('image', filePath, x - 100, y - 75);
        };
        img.src = dataURL;
      };
      reader.readAsDataURL(file);
      return;
    }
    // 再处理纯文本（拖入消息生成 AI 回复卡片）
    const data = e.dataTransfer.getData('text/plain');
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    addCard('ai-reply', data, x - DEFAULT_CARD_WIDTH / 2, y - DEFAULT_CARD_HEIGHT / 2);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // ===== 渲染箭头 SVG =====
  const arrowsSvg = useMemo(() => {
    return state.arrows.map((arrow) => {
      const from = state.cards.find((c) => c.id === arrow.fromCardId);
      const to = state.cards.find((c) => c.id === arrow.toCardId);
      if (!from || !to) return null;
      const x1 = from.x + (from.width ?? DEFAULT_CARD_WIDTH);
      const y1 = from.y + (from.height ?? DEFAULT_CARD_HEIGHT) / 2;
      const x2 = to.x;
      const y2 = to.y + (to.height ?? DEFAULT_CARD_HEIGHT) / 2;
      return (
        <line
          key={arrow.id}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          className="whiteboard-arrow"
          markerEnd="url(#whiteboard-arrow-head)"
          data-name="whiteboard.arrow"
        />
      );
    });
  }, [state.arrows, state.cards]);

  // ===== 渲染手绘线条 SVG（12-8: stroke 用 currentColor） =====
  const strokesSvg = useMemo(() => {
    return state.strokes.map((stroke) => {
      if (stroke.points.length < 2) return null;
      const d = stroke.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
        .join(' ');
      return (
        <path
          key={stroke.id}
          d={d}
          className="whiteboard-stroke"
          stroke={stroke.color ?? 'currentColor'}
          strokeWidth={stroke.width ?? 2}
          fill="none"
          data-name="whiteboard.stroke"
        />
      );
    });
  }, [state.strokes]);

  const { x: vx, y: vy, zoom } = state.viewport;

  return (
    <div className="whiteboard-view" data-name="whiteboard.container">
      {/* 顶栏 */}
      <header className="whiteboard-top" data-name="whiteboard.topbar">
        <div className="whiteboard-top-drag" data-name="whiteboard.topbar-drag">
          <span className="whiteboard-top-title" data-name="whiteboard.topbar-title">白板</span>
          <div className="whiteboard-toolbar" data-name="whiteboard.toolbar">
            <button
              type="button"
              className={`whiteboard-tool-btn ${tool === 'select' ? 'active' : ''}`}
              onClick={() => setTool('select')}
              title="选择 / 拖动"
              data-name="whiteboard.tool-select-button"
            >
              选择
            </button>
            <button
              type="button"
              className={`whiteboard-tool-btn ${tool === 'text' ? 'active' : ''}`}
              onClick={() => setTool('text')}
              title="文本卡片（双击空白处添加）"
              data-name="whiteboard.tool-text-button"
            >
              文本
            </button>
            <button
              type="button"
              className={`whiteboard-tool-btn ${tool === 'pen' ? 'active' : ''}`}
              onClick={() => setTool('pen')}
              title="手绘线条"
              data-name="whiteboard.tool-pen-button"
            >
              画笔
            </button>
            <div className="whiteboard-tool-separator" />
            <button
              type="button"
              className="whiteboard-tool-btn"
              onClick={handleClear}
              title="清空白板"
              data-name="whiteboard.tool-clear-button"
            >
              清空
            </button>
          </div>
        </div>
        <div className="whiteboard-top-actions" data-name="whiteboard.topbar-actions">
          {onClose && (
            <IconButton
              type="button"
              aria-label="关闭白板"
              title="关闭白板（切回 AI 应用）"
              data-name="whiteboard.topbar-close-button"
              onClick={handleClose}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </IconButton>
          )}
        </div>
      </header>

      {/* 画布（12-11: tabIndex 使其可聚焦接收 paste 事件） */}
      <main
        className="whiteboard-canvas-wrap"
        data-name="whiteboard.canvas"
      >
        <div
          ref={canvasRef}
          className={`whiteboard-canvas whiteboard-cursor-${tool}`}
          tabIndex={0}
          onDoubleClick={handleCanvasDoubleClick}
          onMouseDown={handleCanvasMouseDown}
          onWheel={handleWheel}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onPaste={handlePaste}
          data-name="whiteboard.canvas-inner"
        >
          <div
            className="whiteboard-canvas-content"
            style={{
              transform: `translate(${vx}px, ${vy}px) scale(${zoom})`,
            }}
          >
            {/* SVG 层：箭头 + 手绘线条（12-8: 容器 color 控制子元素 currentColor） */}
            <svg
              className="whiteboard-svg-layer"
              style={{ color: 'var(--accent-bright)' }}
              data-name="whiteboard.svg-layer"
            >
              <defs>
                <marker
                  id="whiteboard-arrow-head"
                  markerWidth="10"
                  markerHeight="10"
                  refX="9"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  {/* 12-8: marker 用 currentColor（继承自父 svg 的 color） */}
                  <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
                </marker>
              </defs>
              {arrowsSvg}
              {strokesSvg}
            </svg>

            {/* 卡片层 */}
            {state.cards.map((card) => (
              <div
                key={card.id}
                className={`whiteboard-card whiteboard-card-${card.type} ${
                  selectedCardId === card.id ? 'selected' : ''
                } ${arrowDraft?.fromCardId === card.id ? 'arrow-source' : ''}`}
                style={{
                  left: `${card.x}px`,
                  top: `${card.y}px`,
                  width: card.width ? `${card.width}px` : undefined,
                  height: card.height ? `${card.height}px` : undefined,
                }}
                onMouseDown={(e) => handleCardMouseDown(e, card)}
                onClick={(e) => handleCardClick(e, card)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (card.type === 'text') setEditingCardId(card.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, card)}
                data-name="whiteboard.card"
                data-id={card.id}
                data-type={card.type}
              >
                {card.type === 'image' ? (
                  <img src={card.content} alt="卡片图片" draggable={false} className="whiteboard-card-img" data-name="whiteboard.card-image" />
                ) : card.type === 'ai-reply' ? (
                  <div className="whiteboard-card-content whiteboard-card-ai-reply-content" data-name="whiteboard.card-ai-reply">
                    {card.content}
                  </div>
                ) : editingCardId === card.id ? (
                  <textarea
                    className="whiteboard-card-editor"
                    value={card.content}
                    autoFocus
                    onChange={(e) => handleCardEdit(card.id, e.target.value)}
                    onBlur={() => setEditingCardId(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingCardId(null);
                      }
                    }}
                    placeholder="输入文本..."
                    data-name="whiteboard.card-editor"
                  />
                ) : (
                  <div className="whiteboard-card-content" data-name="whiteboard.card-text">
                    {card.content || <span className="whiteboard-card-placeholder">双击编辑</span>}
                  </div>
                )}
                {/* 12-6: 删除按钮移到卡片内，避免被圆角裁剪 */}
                {selectedCardId === card.id && (
                  <button
                    type="button"
                    className="whiteboard-card-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCard(card.id);
                    }}
                    title="删除卡片"
                    aria-label="删除卡片"
                    data-name="whiteboard.card-delete-button"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 空状态提示 */}
          {state.cards.length === 0 && state.strokes.length === 0 && (
            <div className="whiteboard-empty" data-name="whiteboard.empty-state">
              双击空白处添加文本卡片<br />
              或从历史记录中拖入消息<br />
              Ctrl + 滚轮缩放，拖拽空白处平移
            </div>
          )}
        </div>
      </main>

      {/* Toast */}
      {toast && (
        <div className="whiteboard-toast" data-name="whiteboard.toast">
          {toast}
        </div>
      )}
    </div>
  );
}
