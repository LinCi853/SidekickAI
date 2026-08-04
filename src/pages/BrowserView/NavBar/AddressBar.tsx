/* =====================================================================
   pages/BrowserView/NavBar/AddressBar.tsx —— 地址栏（v0.0.9）
   左：站点权限按钮 / 中：地址输入 / 右：收藏星标 + 外部打开
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserTabState, Profile, SearchHistoryEntry } from '../../../lib/electron-api';
import { listSearchHistory, openExternal } from '../../../lib/electron-api';
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

function toSearchUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}`;
}

export default function AddressBar({ tab, profile, themeColor, onNavigate, addressBarRef }: AddressBarProps) {
  const [urlDraft, setUrlDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHistoryEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    setUrlDraft(tab?.url || '');
  }, [tab?.url]);

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
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const input = urlDraft.trim();
        if (!input) return;
        const url = isUrl(input) ? (input.startsWith('http') ? input : `https://${input}`) : toSearchUrl(input);
        onNavigate(url);
        setIsEditing(false);
        setShowSuggestions(false);
      } else if (e.key === 'Escape') {
        setIsEditing(false);
        setShowSuggestions(false);
        setUrlDraft(tab?.url || '');
      }
    },
    [urlDraft, tab?.url, onNavigate],
  );

  const isSecure = tab?.url?.startsWith('https://');

  return (
    <div className="browser-address-wrapper" data-name="browser.address-bar">
      <SitePermissionButton tab={tab} />
      <span className="browser-address-security" data-name="browser.address-security">
        {isSecure ? '🔒' : tab?.url ? '⚠' : ''}
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
              <span className="browser-suggestion-icon" data-name="browser.suggestion-icon">🔍</span>
              <span className="browser-suggestion-text" data-name="browser.suggestion-text">{entry.query}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
