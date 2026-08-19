import { IconButton, PinToggleButton } from '../../../components/ui';

export interface AiAppEditorTitleBarProps {
  title: string;
  maximized: boolean;
  isPinned: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onPin: () => void;
}

export function AiAppEditorTitleBar({ title, maximized, isPinned, onMinimize, onMaximize, onClose, onPin }: AiAppEditorTitleBarProps) {
  return (
    <div className="prompt-view-top" data-name="ai-app-editor.topbar">
      <div className="prompt-view-top-drag" data-name="ai-app-editor.topbar-drag">
        <span className="prompt-view-top-title" data-name="ai-app-editor.topbar-title">{title}</span>
      </div>
      <div className="prompt-view-top-actions" data-name="ai-app-editor.topbar-actions">
        <PinToggleButton
          isPinned={isPinned}
          onToggle={onPin}
          className="prompt-view-win-btn"
          data-name="ai-app-editor.topbar-pin-button"
        />
        <IconButton
          className="prompt-view-win-btn"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
          data-name="ai-app-editor.topbar-minimize-button"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-minimize-icon">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
        <IconButton
          className="prompt-view-win-btn"
          onClick={onMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label="最大化"
          data-name="ai-app-editor.topbar-maximize-button"
        >
          {maximized ? (
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-restore-icon">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-maximize-icon">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          )}
        </IconButton>
        <IconButton
          variant="close"
          className="prompt-view-win-btn"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          data-name="ai-app-editor.topbar-close-button"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-close-icon">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}
