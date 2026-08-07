/* =====================================================================
   pages/HistoryDownloadView/DownloadPanel.tsx —— 下载管理面板
   顶部：「清空所有」按钮
   列表：文件名 + URL + 大小 + 状态（进行中显示进度条 / 完成 / 失败）+ 时间
   操作：打开文件 / 打开所在文件夹 / 删除记录 / 重新下载
   API：listBrowserDownloads / clearAllDownloads / deleteDownload /
        openDownloadFile / showDownloadInFolder / openExternal /
        onDownloadUpdated（实时更新）
   UI：统一使用共享组件（Button / IconButton / ConfirmDialog）+ useToast，
       替代原生 button / alert / confirm。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, ConfirmDialog } from '@/components/ui';
import { TrashIcon, DownloadIcon, FolderIcon, ExternalLinkIcon } from '@/components/icons';
import { useToast } from '@/hooks/useToast';
import {
  listBrowserDownloads,
  clearAllDownloads,
  deleteDownload,
  openDownloadFile,
  showDownloadInFolder,
  openExternal,
  onDownloadUpdated,
} from '@/lib/electron-api';
import type { BrowserDownloadRecord } from '@/lib/electron-api';
import { formatTime } from '@/lib/datetime';

interface DownloadPanelProps {
  /** 总数变化时通知父组件刷新侧栏计数 */
  onCountChange?: (count: number) => void;
}

/** 格式化字节数为人类可读字符串 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 格式化下载速率（字节/秒） */
function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 格式化剩余时间（秒） */
function formatEta(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

/** 状态文案与样式后缀 */
function stateMeta(state: BrowserDownloadRecord['state']): {
  label: string;
  className: string;
} {
  switch (state) {
    case 'progressing':
      return { label: '进行中', className: 'is-progress' };
    case 'completed':
      return { label: '已完成', className: 'is-completed' };
    case 'interrupted':
      return { label: '已失败', className: 'is-interrupted' };
    case 'cancelled':
      return { label: '已取消', className: 'is-cancelled' };
    default:
      return { label: state, className: '' };
  }
}

/** 速率追踪快照：记录上次采样字节与时间，计算 EMA 平滑速率 */
interface SpeedSample {
  bytes: number;
  time: number;
  speed: number;
}

export default function DownloadPanel({ onCountChange }: DownloadPanelProps) {
  const [records, setRecords] = useState<BrowserDownloadRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast, showToast } = useToast(2500);

  // 确认对话框状态（替代原生 confirm）
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'primary' | 'danger';
    onConfirm: () => void | Promise<void>;
  }>({
    open: false,
    title: '确认',
    message: '',
    confirmLabel: '确定',
    variant: 'primary',
    onConfirm: () => {},
  });

  const requestConfirm = useCallback(
    (
      message: string,
      onConfirm: () => void | Promise<void>,
      opts: { title?: string; confirmLabel?: string; variant?: 'primary' | 'danger' } = {},
    ) => {
      setConfirmState({
        open: true,
        title: opts.title ?? '确认',
        message,
        confirmLabel: opts.confirmLabel ?? '确定',
        variant: opts.variant ?? 'primary',
        onConfirm,
      });
    },
    [],
  );

  const closeConfirm = useCallback(() => {
    setConfirmState((s) => ({ ...s, open: false }));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listBrowserDownloads(undefined, 200);
      setRecords(list);
      onCountChange?.(list.length);
    } catch (e) {
      console.error('[DownloadPanel] 加载失败:', e);
      setError('加载失败');
      setRecords([]);
      onCountChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  // 初始化加载
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 速率采样：按 id 维护最近一次字节与时间戳，EMA 平滑后用于显示速率/剩余时间
  const speedRef = useRef<Map<string, SpeedSample>>(new Map());

  // 订阅下载状态变化（实时更新对应记录或追加新记录）
  useEffect(() => {
    const off = onDownloadUpdated((record) => {
      // 速率采样：仅在 progressing 时维护，结束态清空
      if (record.state === 'progressing') {
        const prev = speedRef.current.get(record.id);
        const now = Date.now();
        if (prev) {
          const dt = now - prev.time;
          // 至少间隔 400ms 采样一次，避免高频更新导致速率抖动
          if (dt >= 400) {
            const db = record.receivedBytes - prev.bytes;
            if (db >= 0 && dt > 0) {
              const inst = db / (dt / 1000);
              const speed = prev.speed > 0 ? prev.speed * 0.5 + inst * 0.5 : inst;
              speedRef.current.set(record.id, { bytes: record.receivedBytes, time: now, speed });
            }
          }
        } else {
          speedRef.current.set(record.id, { bytes: record.receivedBytes, time: now, speed: 0 });
        }
      } else {
        speedRef.current.delete(record.id);
      }

      setRecords((prev) => {
        const idx = prev.findIndex((r) => r.id === record.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = record;
          return next;
        }
        // 新下载：插入到顶部（按 startTime 倒序）
        const next = [record, ...prev];
        onCountChange?.(next.length);
        return next;
      });
    });
    return off;
  }, [onCountChange]);

  const handleOpenFile = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const r = await openDownloadFile(id);
      if (!r.ok) showToast(r.error ?? '打开文件失败');
    } catch (err) {
      console.error('[DownloadPanel] 打开文件失败:', err);
      showToast('打开文件失败');
    }
  }, [showToast]);

  const handleShowInFolder = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const r = await showDownloadInFolder(id);
      if (!r.ok) showToast(r.error ?? '打开文件夹失败');
    } catch (err) {
      console.error('[DownloadPanel] 打开文件夹失败:', err);
      showToast('打开文件夹失败');
    }
  }, [showToast]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const r = await deleteDownload(id);
      if (!r.ok) {
        showToast(r.error ?? '删除失败');
        return;
      }
      speedRef.current.delete(id);
      setRecords((prev) => {
        const next = prev.filter((x) => x.id !== id);
        onCountChange?.(next.length);
        return next;
      });
    } catch (err) {
      console.error('[DownloadPanel] 删除失败:', err);
      showToast('删除失败');
    }
  }, [onCountChange, showToast]);

  const handleRedownload = useCallback(async (url: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await openExternal(url);
    } catch (err) {
      console.error('[DownloadPanel] 重新下载失败:', err);
      showToast('重新下载失败');
    }
  }, [showToast]);

  const handleClearAll = useCallback(() => {
    requestConfirm(
      '确定要清空全部下载记录吗？此操作不会删除已下载的文件。',
      async () => {
        try {
          const r = await clearAllDownloads();
          if (!r.ok) {
            showToast(r.error ?? '清空失败');
            return;
          }
          speedRef.current.clear();
          setRecords([]);
          onCountChange?.(0);
          showToast('已清空下载记录');
        } catch (err) {
          console.error('[DownloadPanel] 清空失败:', err);
          showToast('清空失败');
        } finally {
          closeConfirm();
        }
      },
      { title: '清空下载记录', confirmLabel: '清空', variant: 'danger' },
    );
  }, [onCountChange, requestConfirm, closeConfirm, showToast]);

  // 进度百分比（0-100）
  const progressOf = useCallback((r: BrowserDownloadRecord): number => {
    if (r.totalBytes > 0) {
      return Math.min(100, Math.max(0, Math.round((r.receivedBytes / r.totalBytes) * 100)));
    }
    return r.state === 'completed' ? 100 : 0;
  }, []);

  // 是否可打开文件（仅完成态有有效路径）
  const canOpenFile = useCallback((r: BrowserDownloadRecord): boolean => {
    return r.state === 'completed' && !!r.savePath;
  }, []);

  // 已下载体积文本
  const sizeText = useMemo(() => (r: BrowserDownloadRecord): string => {
    if (r.state === 'progressing') {
      return `${formatBytes(r.receivedBytes)} / ${formatBytes(r.totalBytes)}`;
    }
    if (r.totalBytes > 0) return formatBytes(r.totalBytes);
    return formatBytes(r.receivedBytes);
  }, []);

  // 速率与剩余时间（基于 EMA 采样）
  const speedOf = useCallback((r: BrowserDownloadRecord): { speed: number; eta: number } => {
    const entry = speedRef.current.get(r.id);
    if (!entry || entry.speed <= 0) return { speed: 0, eta: 0 };
    const remaining = r.totalBytes > 0 ? Math.max(0, r.totalBytes - r.receivedBytes) : 0;
    return { speed: entry.speed, eta: remaining > 0 ? remaining / entry.speed : 0 };
  }, []);

  return (
    <div className="hd-content" data-name="hd.dl.container">
      <div className="hd-toolbar" data-name="hd.dl.toolbar">
        <span className="hd-toolbar-count" data-name="hd.dl.count">
          共 {records.length} 条
        </span>
        <div className="hd-toolbar-spacer" />
        <Button
          variant="danger"
          type="button"
          data-name="hd.dl.clear-all-button"
          disabled={records.length === 0}
          onClick={handleClearAll}
        >
          清空所有
        </Button>
      </div>

      <div className="hd-list" data-name="hd.dl.list">
        {loading && records.length === 0 && (
          <div className="hd-empty" data-name="hd.dl.loading">加载中…</div>
        )}
        {!loading && records.length === 0 && (
          <div className="hd-empty" data-name="hd.dl.empty">暂无下载记录</div>
        )}
        {error && (
          <div className="hd-empty" data-name="hd.dl.error">{error}</div>
        )}
        {records.map((r, idx) => {
          const meta = stateMeta(r.state);
          const pct = progressOf(r);
          const { speed, eta } = speedOf(r);
          const etaText = formatEta(eta);
          const progressMeta =
            speed > 0
              ? `${formatSpeed(speed)}${etaText ? ` · 剩余 ${etaText}` : ''}`
              : '';
          return (
            <div
              key={r.id}
              className="hd-dl-item"
              data-name={`hd.dl.item-${idx + 1}`}
              data-index={idx + 1}
              data-id={r.id}
            >
              <div className="hd-dl-item-head">
                <DownloadIcon className="hd-dl-item-icon" />
                <span className="hd-dl-item-name" data-name={`hd.dl.item-name-${idx + 1}`} title={r.filename}>
                  {r.filename}
                </span>
                <span
                  className={`hd-dl-item-state ${meta.className}`}
                  data-name={`hd.dl.item-state-${idx + 1}`}
                >
                  {meta.label}
                  {r.state === 'progressing' && pct > 0 ? ` ${pct}%` : ''}
                </span>
                <div className="hd-dl-item-actions">
                  {canOpenFile(r) && (
                    <IconButton
                      type="button"
                      aria-label="打开文件"
                      title="打开文件"
                      data-name={`hd.dl.item-open-${idx + 1}`}
                      onClick={(e) => void handleOpenFile(r.id, e)}
                    >
                      <ExternalLinkIcon />
                    </IconButton>
                  )}
                  {canOpenFile(r) && (
                    <IconButton
                      type="button"
                      aria-label="打开所在文件夹"
                      title="打开所在文件夹"
                      data-name={`hd.dl.item-folder-${idx + 1}`}
                      onClick={(e) => void handleShowInFolder(r.id, e)}
                    >
                      <FolderIcon />
                    </IconButton>
                  )}
                  {r.url && (
                    <IconButton
                      type="button"
                      aria-label="重新下载"
                      title="重新下载"
                      data-name={`hd.dl.item-redownload-${idx + 1}`}
                      onClick={(e) => void handleRedownload(r.url, e)}
                    >
                      <DownloadIcon />
                    </IconButton>
                  )}
                  <IconButton
                    type="button"
                    variant="close"
                    aria-label="删除记录"
                    title="删除记录"
                    data-name={`hd.dl.item-delete-${idx + 1}`}
                    onClick={(e) => void handleDelete(r.id, e)}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              </div>

              <div className="hd-dl-item-meta">
                <span className="hd-dl-item-url" data-name={`hd.dl.item-url-${idx + 1}`} title={r.url}>
                  {r.url}
                </span>
                <span className="hd-dl-item-size" data-name={`hd.dl.item-size-${idx + 1}`}>
                  {sizeText(r)}
                </span>
                <span className="hd-dl-item-time" data-name={`hd.dl.item-time-${idx + 1}`}>
                  {formatTime(r.startTime, 'datetime')}
                </span>
              </div>

              {r.state === 'progressing' && (
                <div className="hd-dl-progress-track" data-name={`hd.dl.item-progress-track-${idx + 1}`}>
                  <div
                    className="hd-dl-progress-bar"
                    data-name={`hd.dl.item-progress-bar-${idx + 1}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              {r.state === 'progressing' && progressMeta && (
                <span className="hd-dl-progress-meta" data-name={`hd.dl.item-progress-meta-${idx + 1}`}>
                  {progressMeta}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        variant={confirmState.variant}
        onConfirm={confirmState.onConfirm}
        onCancel={closeConfirm}
      />

      {toast && (
        <div className="app-toast" role="status" aria-live="polite" data-name="hd.dl.toast">
          {toast}
        </div>
      )}
    </div>
  );
}
