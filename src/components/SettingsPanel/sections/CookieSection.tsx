import { useState } from 'react';
import { updateAppSettings } from '../../../lib/electron-api';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';
import { useSettingsDraft } from '../../../hooks/useSettingsData';
import { useFeedbackToast } from '../../../hooks/useFeedbackToast';

/* =====================================================================
   CookieSection —— Cookie 弹窗自动处理设置（需求 7）
   - 总开关：开启后 dom-ready 注入 cookie handler 脚本
   - 白名单：自动点击"接受全部"按钮
   - 黑名单：直接隐藏所有 cookie 弹窗
   - 冷却时间：同域名 N 毫秒内重复弹窗静默忽略
   自管理 state，参照 StorageSection 模式（useSettingsDraft 加载 + updateAppSettings 持久化）
   ===================================================================== */

export default function CookieSection() {
  const { draft, setDraft } = useSettingsDraft();
  const { feedback: feedbackMsg, showFeedback: showToast } = useFeedbackToast(2500);
  const [feedbackType, setFeedbackType] = useState<'success' | 'error'>('success');
  const [whitelistDraft, setWhitelistDraft] = useState('');
  const [blacklistDraft, setBlacklistDraft] = useState('');

  // 从草稿派生设置值
  const enabled = draft?.cookieHandlerEnabled ?? true;
  const whitelist = draft?.cookieWhitelist ?? [];
  const blacklist = draft?.cookieBlacklist ?? [];
  const cooldownMs = draft?.cookiePopupCooldownMs ?? 60000;

  const showFeedback = (type: 'success' | 'error', msg: string) => {
    setFeedbackType(type);
    showToast(msg);
  };

  const handleToggleEnabled = async (next: boolean) => {
    const prev = enabled;
    setDraft({ cookieHandlerEnabled: next });
    try {
      await updateAppSettings({ cookieHandlerEnabled: next });
    } catch (e) {
      console.error('[CookieSection] 更新总开关失败:', e);
      setDraft({ cookieHandlerEnabled: prev });
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
    setDraft({ cookieWhitelist: next });
    setWhitelistDraft('');
    try {
      await updateAppSettings({ cookieWhitelist: next });
      showFeedback('success', `已添加 ${domain}`);
    } catch (e) {
      console.error('[CookieSection] 添加白名单失败:', e);
      setDraft({ cookieWhitelist: whitelist });
      showFeedback('error', '保存失败');
    }
  };

  const handleRemoveWhitelist = async (domain: string) => {
    const next = whitelist.filter((d) => d !== domain);
    setDraft({ cookieWhitelist: next });
    try {
      await updateAppSettings({ cookieWhitelist: next });
    } catch (e) {
      console.error('[CookieSection] 删除白名单失败:', e);
      setDraft({ cookieWhitelist: whitelist });
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
    setDraft({ cookieBlacklist: next });
    setBlacklistDraft('');
    try {
      await updateAppSettings({ cookieBlacklist: next });
      showFeedback('success', `已添加 ${domain}`);
    } catch (e) {
      console.error('[CookieSection] 添加黑名单失败:', e);
      setDraft({ cookieBlacklist: blacklist });
      showFeedback('error', '保存失败');
    }
  };

  const handleRemoveBlacklist = async (domain: string) => {
    const next = blacklist.filter((d) => d !== domain);
    setDraft({ cookieBlacklist: next });
    try {
      await updateAppSettings({ cookieBlacklist: next });
    } catch (e) {
      console.error('[CookieSection] 删除黑名单失败:', e);
      setDraft({ cookieBlacklist: blacklist });
    }
  };

  const handleCooldownChange = async (value: number) => {
    const clamped = Math.max(0, Math.min(600000, value));
    const prev = cooldownMs;
    setDraft({ cookiePopupCooldownMs: clamped });
    try {
      await updateAppSettings({ cookiePopupCooldownMs: clamped });
    } catch (e) {
      console.error('[CookieSection] 更新冷却时间失败:', e);
      setDraft({ cookiePopupCooldownMs: prev });
    }
  };

  return (
    <section data-name="settings.cookie.section">
      <SectionTitle>Cookie 弹窗处理</SectionTitle>

      {/* 总开关 */}
      <FormRow label="启用自动处理">
        <Toggle
          checked={enabled}
          onChange={handleToggleEnabled}
          aria-label="启用 Cookie 弹窗自动处理"
          data-name="settings.cookie.enabled-toggle"
        />
      </FormRow>

      {/* 冷却时间 */}
      <FormRow label="冷却时间（毫秒）">
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
          className="input-underline settings-cookie-cooldown-input"
          data-name="settings.cookie.cooldown-input"
        />
      </FormRow>

      {/* 白名单 */}
      <FormRow stack label="白名单">
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
          className="input-underline"
          data-name="settings.cookie.whitelist-input"
        />
        <button
          type="button"
          className="btn-outline btn-outline-sm"
          onClick={() => void handleAddWhitelist()}
          disabled={!whitelistDraft.trim()}
          data-name="settings.cookie.whitelist-add-button"
        >
          添加
        </button>
      </FormRow>
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
      <FormRow stack label="黑名单">
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
          className="input-underline"
          data-name="settings.cookie.blacklist-input"
        />
        <button
          type="button"
          className="btn-outline btn-outline-sm"
          onClick={() => void handleAddBlacklist()}
          disabled={!blacklistDraft.trim()}
          data-name="settings.cookie.blacklist-add-button"
        >
          添加
        </button>
      </FormRow>
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

      {feedbackMsg && (
        <div
          className={`feedback-text ${feedbackType === 'success' ? 'ok' : 'fail'}`}
          style={{ marginTop: 8 }}
          data-name="settings.cookie.feedback"
        >
          {feedbackMsg}
        </div>
      )}
    </section>
  );
}
