/* =====================================================================
   pages/BrowserView/NavBar/SitePermissionButton.tsx —— 站点权限按钮（v0.0.9）
   地址栏左侧轻量实现：静音 / 禁止下载 / 禁止通知。写入 tab.sitePermissions。
   ===================================================================== */

import { useCallback, useRef, useState } from 'react';
import Popover, { PopoverItem } from '../../../components/ui/Popover';

import type { BrowserTabState } from '../../../lib/electron-api';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore';

interface SitePermissionButtonProps {
  tab: BrowserTabState | null;
}

export default function SitePermissionButton({ tab }: SitePermissionButtonProps) {
  const [showPanel, setShowPanel] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const updateSitePermissions = useBrowserTabStore((s) => s.updateSitePermissions);

  const toggle = useCallback(
    (key: 'mute' | 'blockDownload' | 'blockNotification') => {
      if (!tab) return;
      const current = tab.sitePermissions?.[key] ?? false;
      updateSitePermissions(tab.id, { [key]: !current });
    },
    [tab, updateSitePermissions],
  );



  if (!tab) return null;

  const hasAny = tab.sitePermissions?.mute || tab.sitePermissions?.blockDownload || tab.sitePermissions?.blockNotification;

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className={`browser-site-permission-btn${hasAny ? ' active' : ''}`}
        onClick={() => setShowPanel((v) => !v)}
        title="网站设置"
        data-name="browser.site-permission-btn"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </button>
      <Popover
        isOpen={showPanel}
        onClose={() => setShowPanel(false)}
        triggerRef={ref}
        variant="dropdown"
        config={{ closeOnOutsideClick: true, closeOnEsc: true }}
        style={{ width: 220 }}
        dataName="browser.site-permission-panel"
      >
          <div className="browser-site-permission-item" data-name="browser.site-permission-item">
            <span>静音</span>
            <input
              type="checkbox"
              checked={!!tab.sitePermissions?.mute}
              onChange={() => toggle('mute')}
            />
          </div>
          <div className="browser-site-permission-item" data-name="browser.site-permission-item">
            <span>禁止下载</span>
            <input
              type="checkbox"
              checked={!!tab.sitePermissions?.blockDownload}
              onChange={() => toggle('blockDownload')}
            />
          </div>
          <div className="browser-site-permission-item" data-name="browser.site-permission-item">
            <span>禁止通知</span>
            <input
              type="checkbox"
              checked={!!tab.sitePermissions?.blockNotification}
              onChange={() => toggle('blockNotification')}
            />
          </div>
      </Popover>
    </div>
  );
}
