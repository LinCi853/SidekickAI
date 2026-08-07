/* =====================================================================
   pages/BrowserView/NavBar/AddressBar.tsx —— 地址栏（v0.0.9）
   左：站点权限按钮 / 中：地址输入 / 右：收藏星标 + 外部打开
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserTabState, Profile, SearchHistoryEntry } from '../../../lib/electron-api';
import { listSearchHistory, openExternal, getAppSettings, onAppSettingsChanged } from '../../../lib/electron-api';
import { LockIcon, AlertIcon, SearchIcon } from '@/components/icons';
import SitePermissionButton from './SitePermissionButton';
import StarButton from './StarButton';

interface AddressBarProps {
  tab: BrowserTabState | null;
  profile: Profile;
  themeColor: string;
  onNavigate: (url: string) => void;
  addressBarRef: React.MutableRefObject<HTMLInputElement | null>;
}

function isUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[\w-]+(\.[\w-]+)+\/?/.test(trimmed)) return true;
  return false;
}

/** G1：根据配置的 urlTemplate 生成搜索 URL（{query} 占位符替换为编码后的查询词） */
function toSearchUrl(query: string, urlTemplate: string): string {
  const template = urlTemplate || 'https://www.bing.com/search?q={query}';
  return template.replace('{query}', encodeURIComponent(query.trim()));
}

export default function AddressBar({ tab, profile, themeColor, onNavigate, addressBarRef }: AddressBarProps) {
  const [urlDraft, setUrlDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHistoryEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  // G1：当前默认搜索引擎的 urlTemplate（订阅全局设置变更以保持同步）
  const [searchUrlTemplate, setSearchUrlTemplate] = useState<string>('https://www.bing.com/search?q={query}');

  useEffect(() => {
    setUrlDraft(tab?.url || '');
  }, [tab?.url]);

  // G1：加载默认搜索引擎配置，并订阅跨窗口设置变更
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void getAppSettings().then((s) => {
      setSearchUrlTemplate(s.defaultSearchEngine?.urlTemplate || 'https://www.bing.com/search?q={query}');
    });
    unsubscribe = onAppSettingsChanged((s) => {
      setSearchUrlTemplate(s.defaultSearchEngine?.urlTemplate || 'https://www.bing.com/search?q={query}');
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsEditing(true);
    e.target.select();
    void listSearchHistory(profile.id, undefined, 8).then((entries) => {
      setSuggestions(entries);
      setShowSuggestions(entries.length > 0);
    });
  }, [profile.id]);

  const handleBlur = useCallback(() => {
    setTimeout(() => {
      setIsEditing(false);
      setShowSuggestions(false);
    }, 200);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const input = urlDraft.trim();
        if (!input) return;
        const url = isUrl(input) ? (input.startsWith('http') ? input : `https://${input}`) : toSearchUrl(input, searchUrlTemplate);
        onNavigate(url);
        setIsEditing(false);
        setShowSuggestions(false);
      } else if (e.key === 'Escape') {
        // G2：ESC 退出地址栏编辑状态，恢复 urlDraft 并失焦（焦点交回 webview）
        e.preventDefault();
        e.stopPropagation();
        setUrlDraft(tab?.url || '');
        setShowSuggestions(false);
        setIsEditing(false);
        e.currentTarget.blur();
      }
    },
    [urlDraft, tab?.url, onNavigate, searchUrlTemplate],
  );

  const isSecure = tab?.url?.startsWith('https://');

  return (
    <div className="browser-address-wrapper" data-name="browser.address-bar">
      <SitePermissionButton tab={tab} />
      <span className="browser-address-security" data-name="browser.address-security">
        {isSecure ? <LockIcon className="browser-address-security-icon" /> : tab?.url ? <AlertIcon className="browser-address-security-icon" /> : null}
      </span>
      <input
        ref={addressBarRef}
        className="browser-address-input"
        type="text"
        value={urlDraft}
        spellCheck={false}
        placeholder="输入地址或搜索"
        onChange={(e) => setUrlDraft(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        data-name="browser.address-input"
      />
      {tab?.url && (
        <StarButton
          url={tab.url}
          title={tab.title}
          favicon={tab.favicon}
          profile={profile}
          themeColor={themeColor}
        />
      )}
      {tab?.url && (
        <button
          type="button"
          className="browser-address-external" data-name="browser.address-external"
          onClick={() => void openExternal(tab.url)}
          title="在外部浏览器中打开"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      )}
      {showSuggestions && suggestions.length > 0 && (
        <div className="browser-suggestions" data-name="browser.suggestions">
          {suggestions.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="browser-suggestion-item" data-name="browser.suggestion-item"
              onMouseDown={() => {
                onNavigate(entry.url);
                setIsEditing(false);
                setShowSuggestions(false);
              }}
            >
              <span className="browser-suggestion-icon" data-name="browser.suggestion-icon"><SearchIcon className="browser-suggestion-svg" /></span>
              <span className="browser-suggestion-text" data-name="browser.suggestion-text">{entry.query}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
