/* =====================================================================
   SettingsPanel/sections/provider/ProviderList —— 供应商列表 + 加密导出/导入工具栏
   从 ProviderSection.tsx 拆出（J1：紧凑单列行风格，参考 PresetSection / AiAppSection）。
   ===================================================================== */

import Badge from '../../../ui/Badge';
import { Button } from '../../../ui';
import type { CustomAIProvider, CustomAIProviderInput } from '../../../../lib/electron-api';

interface ProviderListProps {
  providers: CustomAIProvider[];
  /** 当前是否处于编辑/新建状态（编辑时不显示导出勾选、新增按钮与工具栏） */
  editing: CustomAIProviderInput | null;
  /** v0.5.2 B-4：导出选中项 id 集合 */
  selectedExportIds: Set<string>;
  onEdit: (p: CustomAIProvider) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onToggleExportSelect: (id: string, checked: boolean) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onStartExport: () => void;
  onStartImport: () => void;
}

export default function ProviderList({
  providers,
  editing,
  selectedExportIds,
  onEdit,
  onDelete,
  onAdd,
  onToggleExportSelect,
  onToggleSelectAll,
  onStartExport,
  onStartImport,
}: ProviderListProps) {
  return (
    <>
      {/* J1：供应商列表（紧凑单列行风格，参考 PresetSection / AiAppSection） */}
      <div className="provider-list" data-name="settings.provider.list">
      {providers.map((p, idx) => {
        // 根据协议生成主题色（用于图标背景）
        const protoColor = p.protocol === 'anthropic' ? '#d97757' : p.protocol === 'openai' ? '#10a37f' : '#6366f1';
        return (
          <div className="provider-row" key={p.id} data-name={`advanced-panel.provider-card-${idx + 1}`} data-index={idx + 1} data-id={p.id}>
            {/* 左侧：首字母图标 */}
            <span
              className="provider-row-icon"
              style={{ background: protoColor }}
              aria-hidden="true"
              data-name={`advanced-panel.provider-card-${idx + 1}-icon`}
            >
              {p.name.charAt(0).toUpperCase()}
            </span>

            {/* 中间：名称 + endpoint */}
            <span className="provider-row-info" data-name={`advanced-panel.provider-card-${idx + 1}-info`}>
              <span className="provider-row-name-line" data-name={`advanced-panel.provider-card-${idx + 1}-name-line`}>
                <span className="provider-row-name" data-name={`advanced-panel.provider-card-${idx + 1}-name`}>{p.name}</span>
                <Badge variant="accent" data-name={`advanced-panel.provider-card-${idx + 1}-protocol-badge`}>{p.protocol}</Badge>
              </span>
              <span className="provider-row-endpoint" title={p.apiEndpoint} data-name={`advanced-panel.provider-card-${idx + 1}-endpoint`}>{p.apiEndpoint}</span>
            </span>

            {/* 右侧：导出勾选 + 操作按钮 */}
            <div className="provider-row-actions" data-name={`advanced-panel.provider-card-${idx + 1}-actions`}>
              {!editing && (
                <label
                  className="provider-row-export-check"
                  title="勾选后点加密导出，仅导出选中项"
                  data-name={`advanced-panel.provider-card-${idx + 1}-export-check-label`}
                >
                  <input
                    type="checkbox"
                    checked={selectedExportIds.has(p.id)}
                    onChange={(e) => onToggleExportSelect(p.id, e.target.checked)}
                    data-name={`advanced-panel.provider-card-${idx + 1}-export-check-input`}
                  />
                </label>
              )}
              <Button type="button" variant="text" className="provider-action-btn compact" onClick={() => onEdit(p)} data-name={`advanced-panel.provider-card-${idx + 1}-edit-button`}>编辑</Button>
              <Button type="button" variant="text" danger className="provider-action-btn compact danger" onClick={() => void onDelete(p.id)} data-name={`advanced-panel.provider-card-${idx + 1}-delete-button`}>删除</Button>
            </div>
          </div>
        );
      })}

      {/* 卡片式新增按钮：追加在列表末尾（与 AI 应用卡片式新增同步） */}
      {!editing && (
        <button
          type="button"
          className="preset-card preset-card-add"
          onClick={onAdd}
          data-name="advanced-panel.provider-add-button"
        >
          <span className="preset-card-add-icon" aria-hidden="true">+</span>
          <span className="preset-card-add-text">添加供应商</span>
        </button>
      )}
      </div>

      {/* v0.5.2 B-4：加密导出 / 导入工具栏（卡片列表下方） */}
      {!editing && (
        <div className="provider-crypto-panel v2" data-name="advanced-panel.crypto-panel">
          <div className="provider-crypto-toolbar" data-name="advanced-panel.crypto-toolbar">
            <label className="provider-crypto-select-all" data-name="advanced-panel.crypto-select-all">
              <input
                type="checkbox"
                checked={selectedExportIds.size === providers.length && providers.length > 0}
                onChange={(e) => onToggleSelectAll(e.target.checked)}
                disabled={providers.length === 0}
                data-name="advanced-panel.crypto-select-all-input"
              />
              <span>全选</span>
            </label>
            <Button
              type="button"
              variant="text"
              onClick={onStartExport}
              disabled={providers.length === 0 && selectedExportIds.size === 0}
              data-name="advanced-panel.crypto-export-button"
              className="provider-crypto-action-btn"
            >
              {selectedExportIds.size > 0
                ? `加密导出选中（${selectedExportIds.size}）`
                : providers.length > 0 ? '加密导出全部' : '无供应商可导出'}
            </Button>
            <Button
              type="button"
              variant="text"
              onClick={onStartImport}
              data-name="advanced-panel.crypto-import-button"
              className="provider-crypto-action-btn"
            >
              加密导入
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
