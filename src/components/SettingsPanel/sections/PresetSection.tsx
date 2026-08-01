import { useState, useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { DevicePreset } from '../../../lib/electron-api';
import { savePreset, deletePreset } from '../../../lib/electron-api';
import Button from '../../ui/Button';
import { SectionTitle } from '../../ui';
import PresetEditorModal from '../../PresetEditorModal';

interface PresetSectionProps {
  presets: DevicePreset[];
  loading: boolean;
  presetExpanded: boolean;
  setPresetExpanded: Dispatch<SetStateAction<boolean>>;
  onReload: () => void;
  /** 标题是否可折叠（在进阶配置内使用时设为 false，避免二次折叠） */
  collapsibleTitle?: boolean;
}

/** 从预设名称中提取浏览器名称（去掉平台前缀，只保留浏览器标识） */
function extractBrowserName(name: string): string {
  // 名称格式如 "Windows / Chrome 125"、"iPhone 15 Pro / Safari" → 取 " / " 后的部分
  const parts = name.split(' / ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : name.trim();
}

/** pending 删除确认超时时间（ms） */
const PENDING_DELETE_TIMEOUT_MS = 3000;

export default function PresetSection({
  presets,
  loading,
  presetExpanded,
  setPresetExpanded,
  onReload,
  collapsibleTitle = true,
}: PresetSectionProps) {
  // 编辑器遮罩状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'edit' | 'create'>('edit');
  const [editorPreset, setEditorPreset] = useState<DevicePreset | null>(null);

  // 删除二次确认状态
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingDelete = useCallback(() => {
    if (pendingDeleteTimerRef.current) {
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    setPendingDeleteId(null);
  }, []);

  useEffect(() => {
    return () => {
      if (pendingDeleteTimerRef.current) {
        clearTimeout(pendingDeleteTimerRef.current);
      }
    };
  }, []);

  const handleOpenEditorEdit = useCallback((preset: DevicePreset) => {
    setEditorPreset(preset);
    setEditorMode('edit');
    setEditorOpen(true);
  }, []);

  const handleOpenEditorCreate = useCallback(() => {
    setEditorPreset(null);
    setEditorMode('create');
    setEditorOpen(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  /** 复制预设：克隆后清除 id 和 builtin 标记，名称加"副本"后缀 */
  const handleDuplicate = useCallback(async (preset: DevicePreset) => {
    try {
      const existingNames = presets.map((p) => p.name);
      let baseName = `${preset.name} 副本`;
      let counter = 1;
      while (existingNames.includes(baseName)) {
        baseName = `${preset.name} 副本 ${counter}`;
        counter++;
      }
      const copy: DevicePreset = {
        ...preset,
        id: '',
        name: baseName,
        builtin: false,
      };
      await savePreset(copy);
      onReload();
    } catch (e) {
      console.error('[PresetSection] 复制预设失败:', e);
    }
  }, [presets, onReload]);

  /** 删除预设（带二次确认） */
  const handleDelete = useCallback((preset: DevicePreset) => {
    if (pendingDeleteId === preset.id) {
      // 二次确认：执行删除
      clearPendingDelete();
      void deletePreset(preset.id)
        .then(() => onReload())
        .catch((e) => console.error('[PresetSection] 删除预设失败:', e));
    } else {
      // 首次点击：进入 pending 状态
      setPendingDeleteId(preset.id);
      if (pendingDeleteTimerRef.current) clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = setTimeout(() => {
        pendingDeleteTimerRef.current = null;
        setPendingDeleteId(null);
      }, PENDING_DELETE_TIMEOUT_MS);
    }
  }, [pendingDeleteId, clearPendingDelete, onReload]);

  return (
    <section data-name="settings.preset.section">
      <SectionTitle
        collapsible={collapsibleTitle}
        collapsed={collapsibleTitle ? !presetExpanded : false}
        onToggle={collapsibleTitle ? () => setPresetExpanded((v) => !v) : undefined}
      >
        设备预设（{presets.length}）
      </SectionTitle>
      {(!collapsibleTitle || presetExpanded) && (
        <>
          {loading && (
            <div className="preset-loading" data-name="settings.preset.loading">
              加载中...
            </div>
          )}
          {!loading && (
            <div className="preset-card-grid" data-name="settings.preset.grid">
              {presets.map((p, idx) => {
                const browserName = extractBrowserName(p.name);
                const isPendingDelete = pendingDeleteId === p.id;
                return (
                  <div
                    key={p.id}
                    className={`preset-card preset-card-v2${isPendingDelete ? ' pending-delete' : ''}`}
                    data-name={`settings.preset.preset-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={p.id}
                  >
                    {/* 左侧：平台标识图标 */}
                    <span
                      className={`preset-card-platform-icon ${p.platform === 'mobile' ? 'is-mobile' : 'is-desktop'}`}
                      title={p.platform === 'mobile' ? '移动端' : '桌面端'}
                      aria-label={p.platform === 'mobile' ? '移动端' : '桌面端'}
                      data-name={`settings.preset.preset-item-${idx + 1}-platform-badge`}
                    >
                      {p.platform === 'mobile' ? (
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                          <line x1="12" y1="18" x2="12.01" y2="18" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                      )}
                    </span>

                    {/* 中间：浏览器名称 + 分辨率 */}
                    <span className="preset-card-info" data-name={`settings.preset.preset-item-${idx + 1}-info`}>
                      <span className="preset-card-browser-name" data-name={`settings.preset.preset-item-${idx + 1}-name`}>{browserName}</span>
                      <span className="preset-card-resolution" data-name={`settings.preset.preset-item-${idx + 1}-meta`}>
                        {p.viewport.width}×{p.viewport.height}
                      </span>
                    </span>

                    {/* 右侧：操作按钮 */}
                    <div className="preset-card-actions" data-name={`settings.preset.preset-item-${idx + 1}-actions`}>
                      <Button
                        variant="text"
                        className="btn-secondary-underline compact"
                        onClick={() => handleOpenEditorEdit(p)}
                        data-name={`settings.preset.preset-item-${idx + 1}-edit-button`}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="text"
                        className="btn-secondary-underline compact"
                        onClick={() => void handleDuplicate(p)}
                        data-name={`settings.preset.preset-item-${idx + 1}-duplicate-button`}
                      >
                        复制
                      </Button>
                      <Button
                        variant="text"
                        danger
                        className="btn-secondary-underline compact danger"
                        onClick={() => handleDelete(p)}
                        title={isPendingDelete ? '再次点击确认删除' : `删除 ${p.name}`}
                        data-name={`settings.preset.preset-item-${idx + 1}-delete-button`}
                      >
                        {isPendingDelete ? '确认' : '删除'}
                      </Button>
                    </div>
                  </div>
                );
              })}

              {/* 卡片式新增按钮：追加在列表末尾 */}
              <button
                type="button"
                className="preset-card preset-card-add"
                onClick={handleOpenEditorCreate}
                data-name="settings.preset.add-button"
              >
                <span className="preset-card-add-icon" aria-hidden="true">+</span>
                <span className="preset-card-add-text">新增预设</span>
              </button>
            </div>
          )}
        </>
      )}

      {/* 设备预设编辑器遮罩 */}
      <PresetEditorModal
        open={editorOpen}
        onClose={handleCloseEditor}
        preset={editorPreset}
        mode={editorMode}
        onSaved={onReload}
      />
    </section>
  );
}
