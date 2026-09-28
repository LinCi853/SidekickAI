/* =====================================================================
   components/AiAppEditorModal/FieldGroup.tsx —— 字段分组容器
   纯展示组件：label + 可选 hint + children（Modal 弹窗版式，
   样式类来自 AiAppEditorModal.css）。由 AiAppEditorModal.tsx 内嵌子组件迁移而来。
   ===================================================================== */

import type { ReactNode } from 'react';

export function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="ai-app-editor-field-group" data-name="ai-app-editor.field-group">
      <label className="ai-app-editor-field-label" data-name="ai-app-editor.field-group-label">
        {label}
      </label>
      {hint && (
        <div className="ai-app-editor-field-hint" data-name="ai-app-editor.field-group-hint">
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
