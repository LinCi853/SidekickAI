/* =====================================================================
   pages/BrowserView/NavBar/AddressBar.tsx —— 地址栏（v0.0.9）
   左：站点权限按钮 / 中：地址输入 / 右：收藏星标 + 外部打开
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserTabState, Profile, SearchHistoryEntry } from '../../../lib/electron-api';
import { listSearchHistory, openExternal, getAppSettings, onAppSettingsChanged } from '../../../lib/electron-api';
import Popover, { PopoverItem, PopoverDivider } from '../../../components/ui/Popover';
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
  // 明确协议（http/https/file/ftp/sidekickai 等应用内协议）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  // file:/// 本地路径
  if (/^file:\/{1,3}/i.test(trimmed)) return true;
  // 域名形式
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
    // 编辑中不同步外部 URL 变化（页面自身导航等），避免打断用户输入
    if (isEditing) return;
    setUrlDraft(tab?.url || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        let url: string;
        if (isUrl(input)) {
          if (/^https?:/i.test(input)) url = input;
          else if (/^(file|sidekickai):/i.test(input)) url = input;
          else if (/^ftp:/i.test(input)) {
            // Chromium 不支持 FTP：交给系统默认应用处理
            void openExternal(input);
            setIsEditing(false);
            setShowSuggestions(false);
            return;
          } else {
            url = input.startsWith('http') ? input : `https://${input}`;
          }
        } else {
          url = toSearchUrl(input, searchUrlTemplate);
        }
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

  // ===== 地址栏右键编辑菜单（现代浏览器标准） =====
  const [editMenu, setEditMenu] = useState<{ x: number; y: number } | null>(null);
  // 打开菜单时记录选区，菜单项执行前恢复（点击菜单项会使输入框失焦）
  const [editSelection, setEditSelection] = useState<{ start: number; end: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    e.preventDefault();
    const input = e.currentTarget;
    setEditSelection({ start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 });
    setEditMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeEditMenu = useCallback(() => setEditMenu(null), []);

  // 执行地址栏编辑命令（先恢复焦点与选区，再执行）
  const runEditCommand = useCallback((cmd: () => boolean | void) => {
    const input = addressBarRef.current;
    if (input) {
      input.focus();
      if (editSelection && input.setSelectionRange) {
        try { input.setSelectionRange(editSelection.start, editSelection.end); } catch { /* ignore */ }
      }
      cmd();
    }
    setEditMenu(null);
  }, [editSelection]);

  const execEdit = useCallback((cmd: string) => {
    runEditCommand(() => { document.execCommand(cmd); });
  }, [runEditCommand]);

  const pasteFromClipboard = useCallback(() => {
    runEditCommand(() => {
      // 异步读取剪贴板，通过 insertText 触发 React onChange 更新地址栏
      void navigator.clipboard.readText().then((text) => {
        const input = addressBarRef.current;
        if (input && text) {
          input.focus();
          document.execCommand('insertText', false, text);
        }
      }).catch(() => { /* 剪贴板不可读时忽略 */ });
    });
  }, [runEditCommand]);

  // 粘贴并转到：读取剪贴板 URL/搜索词并立即导航（Chrome 地址栏标准功能）
  const pasteAndGo = useCallback(() => {
    void navigator.clipboard.readText().then((text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const target = isUrl(trimmed) ? (trimmed.startsWith('http') ? trimmed : `https://${trimmed}`) : toSearchUrl(trimmed, searchUrlTemplate);
      onNavigate(target);
      setIsEditing(false);
      setShowSuggestions(false);
    }).catch(() => { /* ignore */ });
    setEditMenu(null);
  }, [onNavigate, searchUrlTemplate]);

  const hasSelection = !!(editSelection && editSelection.start !== editSelection.end);
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
        onContextMenu={handleContextMenu}
        data-name="browser.address-input"
      />
      {/* 地址栏右键编辑菜单 */}
      {editMenu && (
        <Popover
          isOpen={true}
          onClose={closeEditMenu}
          position={editMenu}
          variant="context-menu"
          config={{ closeOnOutsideClick: true, closeOnEsc: true }}
          dataName="browser.address-context-menu"
        >
          <PopoverItem onClick={() => execEdit('undo')} label="撤销" shortcut="Ctrl+Z" dataName="browser.address-ctx-undo" />
          <PopoverItem onClick={() => execEdit('redo')} label="重做" shortcut="Ctrl+Y" dataName="browser.address-ctx-redo" />
          <PopoverDivider />
          <PopoverItem onClick={() => execEdit('cut')} label="剪切" shortcut="Ctrl+X" disabled={!hasSelection} dataName="browser.address-ctx-cut" />
          <PopoverItem onClick={() => execEdit('copy')} label="复制" shortcut="Ctrl+C" disabled={!hasSelection} dataName="browser.address-ctx-copy" />
          <PopoverItem onClick={pasteFromClipboard} label="粘贴" shortcut="Ctrl+V" dataName="browser.address-ctx-paste" />
          <PopoverItem onClick={pasteFromClipboard} label="粘贴为纯文本" shortcut="Ctrl+Shift+V" dataName="browser.address-ctx-paste-plain" />
          <PopoverItem onClick={pasteAndGo} label="粘贴并转到" dataName="browser.address-ctx-paste-go" />
          <PopoverDivider />
          <PopoverItem onClick={() => execEdit('selectAll')} label="全选" shortcut="Ctrl+A" dataName="browser.address-ctx-select-all" />
        </Popover>
      )}
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
