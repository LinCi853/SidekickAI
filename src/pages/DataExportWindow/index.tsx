/* =====================================================================
   pages/DataExportWindow/index.tsx —— 数据迁移独立窗口
   架构（对齐 PromptLibraryView 约定）：
   - 顶栏：标题 + pin/min/max/close（IconButton 组件）
   - 主体：上下堆叠
     · 导出区：三档预设 + 4 项细粒度选项 + 体积估算 + 导出按钮
     · 导入区：警告 + 文件选择 + 确认导入
   - 细粒度选项：basicData（必选）/ cookies / indexedDB / cache
   - 三档预设：最小迁移 / 推荐迁移 / 完整备份
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import { IconButton } from '../../components/ui';
import { useEscToCloseWindow } from '../../hooks/useEscToCloseWindow';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onMaximizeToggled,
  onPinToggled,
  estimateExportSizes,
  selectExportPath,
  exportData,
  selectImportFile,
  importData,
} from '../../lib/electron-api';
import './index.css';

/** 格式化字节为可读字符串 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 导出选项类型（与后端 ExportOptions 对齐） */
interface ExportOptions {
  basicData: boolean;
  cookies: boolean;
  indexedDB: boolean;
  cache: boolean;
}

/** 三档快速预设 */
const PRESETS: Record<string, ExportOptions> = {
  minimal: { basicData: true, cookies: true, indexedDB: false, cache: false },
  recommended: { basicData: true, cookies: true, indexedDB: true, cache: false },
  full: { basicData: true, cookies: true, indexedDB: true, cache: true },
};

const PRESET_LABELS: Record<string, string> = {
  minimal: '最小迁移',
  recommended: '推荐迁移',
  full: '完整备份',
};

/** 细粒度选项配置 */
interface OptionItem {
  key: keyof ExportOptions;
  label: string;
  description: string;
  /** 是否必选（无法取消） */
  required?: boolean;
}

const OPTION_ITEMS: OptionItem[] = [
  {
    key: 'basicData',
    label: '基础数据',
    description: '应用配置 + 对话记录 + 加密密钥（必选，导入必需）',
    required: true,
  },
  {
    key: 'cookies',
    label: '登录凭据',
    description: 'Cookies + Local Storage，迁移后 AI 平台无需重新登录',
  },
  {
    key: 'indexedDB',
    label: '应用数据',
    description: 'IndexedDB 离线应用数据（部分网页应用的本地存储）',
  },
  {
    key: 'cache',
    label: '离线缓存',
    description: 'Service Worker / Cache / GPUCache（可安全排除，不影响功能）',
  },
];

type Status = { type: 'success' | 'error'; message: string } | null;

export default function DataExportWindow() {
  const [maximized, setMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [sizes, setSizes] = useState<{
    basicData: number;
    cookies: number;
    indexedDB: number;
    cache: number;
  } | null>(null);

  // 默认选项 = PRESETS.minimal
  const [options, setOptions] = useState<ExportOptions>({ ...PRESETS.minimal });
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<Status>(null);

  // 导入状态
  const [importFilePath, setImportFilePath] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<Status>(null);

  // 初始化：最大化 + 置顶状态
  useEffect(() => {
    void isWindowMaximized().then(setMaximized).catch(() => {});
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);

  // 监听最大化/置顶状态变更
  useEffect(() => {
    const offPin = onPinToggled((onTop) => setIsPinned(onTop));
    const offMax = onMaximizeToggled((max) => setMaximized(max));
    return () => { offPin(); offMax(); };
  }, []);

  // ESC / Ctrl+W 关窗：复用统一 hook（覆盖 INPUT/TEXTAREA/SELECT/contentEditable 跳过逻辑）
  useEscToCloseWindow();

  // 加载体积估算
  const loadSizes = () => {
    void estimateExportSizes()
      .then(setSizes)
      .catch((e) => console.error('[DataExportWindow] 估算体积失败:', e));
  };

  useEffect(() => {
    loadSizes();
  }, []);

  // 当前选项匹配哪个预设
  const activePreset = useMemo(() => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      if (Object.entries(preset).every(([k, v]) => options[k as keyof ExportOptions] === v)) {
        return key;
      }
    }
    return null;
  }, [options]);

  // 选中项总体积
  const totalSize = useMemo(() => {
    if (!sizes) return 0;
    let total = 0;
    if (options.basicData) total += sizes.basicData;
    if (options.cookies) total += sizes.cookies;
    if (options.indexedDB) total += sizes.indexedDB;
    if (options.cache) total += sizes.cache;
    return total;
  }, [sizes, options]);

  // 至少选中一项才可导出（basicData 始终为 true，所以总是可以）
  const canExport = !exporting;

  // 切换选项（basicData 必选，不可取消）
  const handleToggle = (key: keyof ExportOptions) => {
    if (exporting) return;
    setOptions((prev) => {
      // 必选项不可取消
      const item = OPTION_ITEMS.find((o) => o.key === key);
      if (item?.required) return prev;
      return { ...prev, [key]: !prev[key] };
    });
    setExportStatus(null);
  };

  // 点击预设按钮
  const handlePresetClick = (presetKey: string) => {
    if (exporting) return;
    setOptions({ ...PRESETS[presetKey] });
    setExportStatus(null);
  };

  // 最大化切换
  const handleMaximize = async () => {
    const next = await maximizeToggleWindow();
    setMaximized(next);
  };

  // 置顶切换
  const handlePin = async () => {
    const next = !isPinned;
    setIsPinned(next);
    await pinCurrentWindow(next);
  };

  // 导出
  const handleExport = async () => {
    if (!canExport) return;
    setExporting(true);
    setExportStatus(null);
    try {
      const targetPath = await selectExportPath();
      if (!targetPath) {
        setExporting(false);
        return;
      }
      const result = await exportData(targetPath, options);
      if (result.success) {
        setExportStatus({ type: 'success', message: `已导出到：${result.filePath}` });
      } else {
        setExportStatus({ type: 'error', message: result.error ?? '导出失败' });
      }
    } catch (err) {
      setExportStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setExporting(false);
    }
  };

  // 选择导入文件
  const handleSelectImportFile = async () => {
    if (importing) return;
    setImportStatus(null);
    try {
      const filePath = await selectImportFile();
      if (!filePath) return;
      setImportFilePath(filePath);
    } catch (err) {
      setImportStatus({ type: 'error', message: (err as Error).message });
    }
  };

  // 确认导入（二次确认）
  const handleConfirmImport = async () => {
    if (!importFilePath || importing) return;
    // 二次确认
    const confirmed = window.confirm(
      `确认导入以下文件？\n\n${importFilePath}\n\n此操作将完全覆盖当前所有数据，应用将自动重启。`,
    );
    if (!confirmed) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const result = await importData(importFilePath);
      if (!result.success) {
        setImportStatus({ type: 'error', message: result.error ?? '导入失败' });
        setImporting(false);
      }
      // 成功时应用自动重启，无需更新状态
    } catch (err) {
      setImportStatus({ type: 'error', message: (err as Error).message });
      setImporting(false);
    }
  };

  return (
    <>
      <WindowResizeHandles />
      <div className="data-export-view app-shell" data-name="data-export.container">
        {/* 顶栏 */}
        <div className="data-export-top" data-name="data-export.topbar">
          <div className="data-export-top-drag" data-name="data-export.topbar-drag">
            <span className="data-export-top-title" data-name="data-export.topbar-title">数据迁移</span>
          </div>
          <div className="data-export-top-actions" data-name="data-export.topbar-actions">
            <IconButton
              type="button"
              variant={isPinned ? 'active' : 'default'}
              aria-label={isPinned ? '取消置顶' : '置顶'}
              title={isPinned ? '取消置顶' : '置顶'}
              data-name="data-export.topbar-pin-button"
              onClick={() => void handlePin()}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-pin-icon">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
            <IconButton
              type="button"
              aria-label="最小化"
              title="最小化"
              data-name="data-export.topbar-minimize-button"
              onClick={() => void minimizeWindow()}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-minimize-icon">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </IconButton>
            <IconButton
              type="button"
              aria-label={maximized ? '还原' : '最大化'}
              title={maximized ? '还原' : '最大化'}
              data-name="data-export.topbar-maximize-button"
              onClick={() => void handleMaximize()}
            >
              {maximized ? (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-restore-icon">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-maximize-icon">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
              )}
            </IconButton>
            <IconButton
              type="button"
              variant="close"
              aria-label="关闭"
              title="关闭"
              data-name="data-export.topbar-close-button"
              onClick={() => void closeCurrentWindow()}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-close-icon">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </IconButton>
          </div>
        </div>

        {/* 主体：上下堆叠 */}
        <div className="data-export-body" data-name="data-export.body">
          {/* ===== 导出区 ===== */}
          <div className="data-export-section" data-name="data-export.export-section">
            <div className="data-export-section-title" data-name="data-export.export-section-title">导出数据</div>

            {/* 说明 + 刷新体积 */}
            <div className="data-export-desc" data-name="data-export.export-desc">
              选择需要导出的数据类别，实时显示各项体积估算。导出为 zip 文件，可在另一台设备导入恢复。
              <button
                type="button"
                className="data-export-desc-btn"
                onClick={loadSizes}
                disabled={exporting}
                data-name="data-export.refresh-sizes-button"
              >
                刷新体积
              </button>
            </div>

            {/* 三档快速预设 */}
            <div className="data-export-presets" data-name="data-export.presets">
              {Object.keys(PRESETS).map((key, idx) => (
                <button
                  key={key}
                  type="button"
                  className={`data-export-preset-btn${activePreset === key ? ' is-active' : ''}`}
                  onClick={() => handlePresetClick(key)}
                  disabled={exporting}
                  data-name={`data-export.preset-button-${idx + 1}`}
                  data-index={idx + 1}
                  data-id={key}
                >
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>

            {/* 细粒度选项列表 */}
            <div className="data-export-options" data-name="data-export.options">
              {OPTION_ITEMS.map((opt, idx) => {
                const checked = options[opt.key];
                const size = sizes ? sizes[opt.key] : 0;
                const isRequired = opt.required === true;
                const classNames = [
                  'data-export-option',
                  checked ? 'is-checked' : '',
                  isRequired ? 'is-required' : '',
                ].filter(Boolean).join(' ');
                return (
                  <label
                    key={opt.key}
                    className={classNames}
                    data-name={`data-export.option-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={opt.key}
                  >
                    <input
                      type="checkbox"
                      className="data-export-option-checkbox"
                      checked={checked}
                      onChange={() => handleToggle(opt.key)}
                      disabled={isRequired || exporting}
                      data-name={`data-export.option-item-${idx + 1}-checkbox`}
                    />
                    <div className="data-export-option-content" data-name={`data-export.option-item-${idx + 1}-content`}>
                      <div className="data-export-option-header" data-name={`data-export.option-item-${idx + 1}-header`}>
                        <span className="data-export-option-label" data-name={`data-export.option-item-${idx + 1}-label`}>{opt.label}</span>
                        <span className="data-export-option-size" data-name={`data-export.option-item-${idx + 1}-size`}>
                          {sizes ? formatBytes(size) : '计算中…'}
                        </span>
                        {isRequired && (
                          <span className="data-export-option-badge" data-name={`data-export.option-item-${idx + 1}-badge`}>必选</span>
                        )}
                      </div>
                      <div className="data-export-option-desc" data-name={`data-export.option-item-${idx + 1}-desc`}>{opt.description}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* 总体积汇总 */}
            <div className="data-export-total" data-name="data-export.total">
              <span className="data-export-total-label" data-name="data-export.total-label">预估总体积</span>
              <span className="data-export-total-value" data-name="data-export.total-value">{formatBytes(totalSize)}</span>
            </div>

            {/* 导出状态消息 */}
            {exportStatus && (
              <div
                className={`data-export-status ${exportStatus.type === 'success' ? 'is-success' : 'is-error'}`}
                data-name="data-export.export-status"
              >
                {exportStatus.type === 'success' ? '✓ ' : '✗ '}{exportStatus.message}
              </div>
            )}

            {/* 导出按钮 */}
            <div className="data-export-actions" data-name="data-export.export-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void closeCurrentWindow()}
                disabled={exporting}
                style={{ flex: 1 }}
                data-name="data-export.cancel-button"
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary-flat"
                onClick={() => void handleExport()}
                disabled={!canExport}
                style={{ flex: 2 }}
                data-name="data-export.export-button"
              >
                {exporting ? '导出中…' : '选择位置并导出'}
              </button>
            </div>
          </div>

          {/* ===== 导入区 ===== */}
          <div className="data-export-section" data-name="data-export.import-section">
            <div className="data-export-section-title" data-name="data-export.import-section-title">导入数据</div>

            {/* 警告 */}
            <div className="data-export-import-warning" data-name="data-export.import-warning">
              <div className="data-export-import-warning-title" data-name="data-export.import-warning-title">⚠ 严重警告：</div>
              <div data-name="data-export.import-warning-line-1">· 导入将完全覆盖当前所有数据（包括 AI 平台登录态、对话记录、设置等）</div>
              <div data-name="data-export.import-warning-line-2">· 导入后应用将自动重启</div>
              <div data-name="data-export.import-warning-line-3">· 建议先导出当前数据作为备份</div>
            </div>

            {/* 已选文件 */}
            {importFilePath && (
              <div className="data-export-import-file is-selected" data-name="data-export.import-file">
                <span data-name="data-export.import-file-label">已选择：</span>
                <span data-name="data-export.import-file-path">{importFilePath}</span>
              </div>
            )}

            {/* 导入状态消息 */}
            {importStatus && (
              <div
                className={`data-export-status ${importStatus.type === 'success' ? 'is-success' : 'is-error'}`}
                data-name="data-export.import-status"
              >
                {importStatus.type === 'success' ? '✓ ' : '✗ '}{importStatus.message}
              </div>
            )}

            {/* 导入按钮 */}
            <div className="data-export-actions" data-name="data-export.import-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleSelectImportFile()}
                disabled={importing}
                style={{ flex: 1 }}
                data-name="data-export.select-file-button"
              >
                {importFilePath ? '重新选择文件' : '选择 zip 文件'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleConfirmImport()}
                disabled={!importFilePath || importing}
                style={{ flex: 1 }}
                data-name="data-export.confirm-import-button"
              >
                {importing ? '导入中…' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
