import type { ReactNode } from 'react';

export interface FieldGroupProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FieldGroup({ label, hint, children }: FieldGroupProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }} data-name="ai-app-editor.field-group">
      <label
        data-name="ai-app-editor.field-group-label"
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </label>
      {hint && (
        <div
          data-name="ai-app-editor.field-group-hint"
          style={{
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
            opacity: 0.8,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
