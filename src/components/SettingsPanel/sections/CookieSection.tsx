import { useEffect, useState } from 'react';
import { getAppSettings, updateAppSettings } from '../../../lib/electron-api';
import Toggle from '../../ui/Toggle';

/* =====================================================================
   CookieSection —— Cookie 弹窗自动处理设置（需求 7）
   - 总开关：开启后 dom-ready 注入 cookie handler 脚本
   - 白名单：自动点击"接受全部"按钮
   - 黑名单：直接隐藏所有 cookie 弹窗
   - 冷却时间：同域名 N 毫秒内重复弹窗静默忽略
   自管理 state，参照 StorageSection 模式（useEffect 加载 + updateAppSettings 持久化）
   ===================================================================== */

export default function CookieSection() {
  const [enabled, setEnabled] = useState(true);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [cooldownMs, setCooldownMs] = useState(60000);
  const [whitelistDraft, setWhitelistDraft] = useState('');
  const [blacklistDraft, setBlacklistDraft] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    getAppSettings()
      .then((cfg) => {
        setEnabled(cfg.cookieHandlerEnabled ?? true);
        setWhitelist(cfg.cookieWhitelist ?? []);
        setBlacklist(cfg.cookieBlacklist ?? []);
        setCooldownMs(cfg.cookiePopupCooldownMs ?? 60000);
      })
      .catch((e) => console.error('[CookieSection] 加载 cookie 设置失败:', e));
  }, []);

  const showFeedback = (type: 'success' | 'error', msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 2500);
  };

  const handleToggleEnabled = async (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    try {
      await updateAppSettings({ cookieHandlerEnabled: next });
    } catch (e) {
      console.error('[CookieSection] 更新总开关失败:', e);
      setEnabled(prev);
    }
  };

  /** 规范化域名输入：去除协议、路径、空白，转小写 */
  const normalizeDomain = (raw: string): string => {
    let s = raw.trim().toLowerCase();
    // 去除协议前缀
    s = s.replace(/^https?:\/\//, '');
    // 去除路径部分
    const slashIdx = s.indexOf('/');
    if (slashIdx !== -1) s = s.slice(0, slashIdx);
    return s;
  };

  const handleAddWhitelist = async () => {
    const domain = normalizeDomain(whitelistDraft);
    if (!domain) return;
    if (whitelist.includes(domain)) {
      showFeedback('error', '该域名已在白名单中');
      return;
    }
    const next = [...whitelist, domain];
    setWhitelist(next);
    setWhitelistDraft('');
    try {
      await updateAppSettings({ cookieWhitelist: next });
      showFeedback('success', `已添加 ${domain}`);
    } catch (e) {
      console.error('[CookieSection] 添加白名单失败:', e);
      setWhitelist(whitelist);
      showFeedback('error', '保存失败');
    }
  };

  const handleRemoveWhitelist = async (domain: string) => {
    const next = whitelist.filter((d) => d !== domain);
    setWhitelist(next);
    try {
      await updateAppSettings({ cookieWhitelist: next });
    } catch (e) {
      console.error('[CookieSection] 删除白名单失败:', e);
      setWhitelist(whitelist);
    }
  };

  const handleAddBlacklist = async () => {
    const domain = normalizeDomain(blacklistDraft);
    if (!domain) return;
    if (blacklist.includes(domain)) {
      showFeedback('error', '该域名已在黑名单中');
      return;
    }
    const next = [...blacklist, domain];
    setBlacklist(next);
    setBlacklistDraft('');
    try {
      await updateAppSettings({ cookieBlacklist: next });
      showFeedback('success', `已添加 ${domain}`);
    } catch (e) {
      console.error('[CookieSection] 添加黑名单失败:', e);
      setBlacklist(blacklist);
      showFeedback('error', '保存失败');
    }
  };

  const handleRemoveBlacklist = async (domain: string) => {
    const next = blacklist.filter((d) => d !== domain);
    setBlacklist(next);
    try {
      await updateAppSettings({ cookieBlacklist: next });
    } catch (e) {
      console.error('[CookieSection] 删除黑名单失败:', e);
      setBlacklist(blacklist);
    }
  };

  const handleCooldownChange = async (value: number) => {
    const clamped = Math.max(0, Math.min(600000, value));
    const prev = cooldownMs;
    setCooldownMs(clamped);
    try {
      await updateAppSettings({ cookiePopupCooldownMs: clamped });
    } catch (e) {
      console.error('[CookieSection] 更新冷却时间失败:', e);
      setCooldownMs(prev);
    }
  };

  return (
    <section data-name="settings.cookie.section">
      <div className="settings-section-title" data-name="settings.cookie.title">Cookie 弹窗处理</div>

      {/* 总开关 */}
      <div className="voice-config-row" data-name="settings.cookie.enabled-row">
        <label className="voice-config-label" data-name="settings.cookie.enabled-label">
          <span className="voice-config-name" data-name="settings.cookie.enabled-name">启用自动处理</span>
        </label>
        <Toggle
          checked={enabled}
          onChange={handleToggleEnabled}
          aria-label="启用 Cookie 弹窗自动处理"
          data-name="settings.cookie.enabled-toggle"
        />
      </div>

      {/* 冷却时间 */}
      <div className="voice-config-row" data-name="settings.cookie.cooldown-row">
        <label className="voice-config-label" data-name="settings.cookie.cooldown-label">
          <span className="voice-config-name" data-name="settings.cookie.cooldown-name">冷却时间（毫秒）</span>
        </label>
        <input
          type="number"
          min={0}
          max={600000}
          step={1000}
          value={cooldownMs}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) void handleCooldownChange(v);
          }}
          className="ua-preset-select"
          style={{ width: 120 }}
          data-name="settings.cookie.cooldown-input"
        />
      </div>
      <div className="hotkey-section-hint" data-name="settings.cookie.cooldown-hint">
        同一域名在冷却时间内反复弹窗会被静默忽略（0 表示总是处理）
      </div>

      {/* 白名单 */}
      <div className="settings-section-title" style={{ marginTop: 16, fontSize: 13 }} data-name="settings.cookie.whitelist-title">白名单（自动点击"接受全部"）</div>
      <div className="voice-config-row" data-name="settings.cookie.whitelist-add-row">
        <input
          type="text"
          value={whitelistDraft}
          onChange={(e) => setWhitelistDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void handleAddWhitelist();
            }
          }}
          placeholder="example.com"
          className="ua-preset-select"
          style={{ flex: 1, minWidth: 0 }}
          data-name="settings.cookie.whitelist-input"
        />
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleAddWhitelist()}
          disabled={!whitelistDraft.trim()}
          data-name="settings.cookie.whitelist-add-button"
        >
          添加
        </button>
      </div>
      <div className="cookie-domain-list" data-name="settings.cookie.whitelist-list">
        {whitelist.length === 0 ? (
          <div className="cookie-domain-empty" data-name="settings.cookie.whitelist-empty">暂无白名单域名</div>
        ) : (
          whitelist.map((domain) => (
            <div key={domain} className="cookie-domain-item" data-name={`settings.cookie.whitelist-item-${domain}`}>
              <span className="cookie-domain-name" data-name="settings.cookie.whitelist-item-name">{domain}</span>
              <button
                type="button"
                className="cookie-domain-remove"
                onClick={() => void handleRemoveWhitelist(domain)}
                aria-label={`删除 ${domain}`}
                data-name="settings.cookie.whitelist-remove-button"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* 黑名单 */}
      <div className="settings-section-title" style={{ marginTop: 16, fontSize: 13 }} data-name="settings.cookie.blacklist-title">黑名单（直接隐藏所有 cookie 弹窗）</div>
      <div className="voice-config-row" data-name="settings.cookie.blacklist-add-row">
        <input
          type="text"
          value={blacklistDraft}
          onChange={(e) => setBlacklistDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void handleAddBlacklist();
            }
          }}
          placeholder="example.com"
          className="ua-preset-select"
          style={{ flex: 1, minWidth: 0 }}
          data-name="settings.cookie.blacklist-input"
        />
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleAddBlacklist()}
          disabled={!blacklistDraft.trim()}
          data-name="settings.cookie.blacklist-add-button"
        >
          添加
        </button>
      </div>
      <div className="cookie-domain-list" data-name="settings.cookie.blacklist-list">
        {blacklist.length === 0 ? (
          <div className="cookie-domain-empty" data-name="settings.cookie.blacklist-empty">暂无黑名单域名</div>
        ) : (
          blacklist.map((domain) => (
            <div key={domain} className="cookie-domain-item" data-name={`settings.cookie.blacklist-item-${domain}`}>
              <span className="cookie-domain-name" data-name="settings.cookie.blacklist-item-name">{domain}</span>
              <button
                type="button"
                className="cookie-domain-remove"
                onClick={() => void handleRemoveBlacklist(domain)}
                aria-label={`删除 ${domain}`}
                data-name="settings.cookie.blacklist-remove-button"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {feedback && (
        <div
          className={`settings-feedback ${feedback.type === 'success' ? 'ok' : 'fail'}`}
          style={{ marginTop: 8 }}
          data-name="settings.cookie.feedback"
        >
          {feedback.msg}
        </div>
      )}
    </section>
  );
}
