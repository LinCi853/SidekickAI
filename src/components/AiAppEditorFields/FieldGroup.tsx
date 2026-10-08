import type { ReactNode } from 'react';
import './fields.css';

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
