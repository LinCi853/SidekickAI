import { useEffect, useState } from 'react';
import type { PlatformCapabilities } from '../../../lib/electron-api';
import {
  getPlatformCapabilities,
  clearAllData,
  openExportWindow,
  updateAppSettings,
} from '../../../lib/electron-api';
import Button from '../../ui/Button';
import { SectionTitle } from '../../ui';
import { useSettingsDraft } from '../../../hooks/useSettingsData';

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

const STORAGE_LABELS: Record<string, string> = {
  dpapi: 'Windows DPAPI',
  keychain: 'macOS Keychain',
  libsecret: 'Linux libsecret',
  fallback: 'XOR 降级',
};

export default function AboutSection() {
  const { draft, setDraft } = useSettingsDraft();
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');

  // 从草稿派生弹窗白名单
  const whitelist = draft?.popupWhitelist || [];

  useEffect(() => {
    void getPlatformCapabilities().then(setCaps).catch(() => {});
  }, []);

  const handleClearAllData = async () => {
    setClearing(true);
    try {
      await clearAllData();
    } catch {
      setClearing(false);
      setConfirming(false);
    }
  };

  const handleOpenExportWindow = async () => {
    try {
      await openExportWindow();
    } catch (err) {
      console.error('[AboutSection] 打开数据迁移窗口失败:', err);
    }
  };

  const handleAddOrigin = async () => {
    const origin = newOrigin.trim();
    if (!origin) return;
    if (whitelist.includes(origin)) {
      setNewOrigin('');
      return;
    }
    const next = [...whitelist, origin];
    setDraft({ popupWhitelist: next });
    setNewOrigin('');
    try {
      await updateAppSettings({ popupWhitelist: next });
    } catch (err) {
      console.error('[AboutSection] 加入白名单失败:', err);
      setDraft({ popupWhitelist: whitelist });
    }
  };

  const handleRemoveOrigin = async (origin: string) => {
    const next = whitelist.filter((x) => x !== origin);
    setDraft({ popupWhitelist: next });
    try {
      await updateAppSettings({ popupWhitelist: next });
    } catch (err) {
      console.error('[AboutSection] 移除白名单失败:', err);
      setDraft({ popupWhitelist: whitelist });
    }
  };

  return (
    <section data-name="settings.about.section">
      <SectionTitle>关于</SectionTitle>
      <div className="about-row" data-name="settings.about.name-row"><span data-name="settings.about.name-label">名称</span><span data-name="settings.about.name-value">SidekickAI（工百窗）</span></div>
      <div className="about-row" data-name="settings.about.version-row"><span data-name="settings.about.version-label">版本</span><span data-name="settings.about.version-value">v0.5.1</span></div>
      <div className="about-row" data-name="settings.about.platform-row">
        <span data-name="settings.about.platform-label">平台</span>
        <span data-name="settings.about.platform-value">{caps ? `${PLATFORM_LABELS[caps.platform] ?? caps.platform} (${caps.arch})` : '—'}</span>
      </div>
      <div className="about-row" data-name="settings.about.secure-storage-row">
        <span data-name="settings.about.secure-storage-label">安全存储</span>
        <span style={{ color: caps?.hasSecureStorage ? 'var(--success)' : 'var(--danger)' }} data-name="settings.about.secure-storage-value">
          {caps ? `${caps.hasSecureStorage ? '✓' : '✗'} ${STORAGE_LABELS[caps.storageBackend] ?? caps.storageBackend}` : '—'}
        </span>
      </div>
      <div className="about-row" data-name="settings.about.global-shortcut-row">
        <span data-name="settings.about.global-shortcut-label">全局快捷键</span>
        <span style={{ color: caps?.hasGlobalShortcut ? 'var(--success)' : 'var(--danger)' }} data-name="settings.about.global-shortcut-value">
          {caps ? (caps.hasGlobalShortcut ? '✓ 可用' : '✗ 不可用') : '—'}
        </span>
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionTitle>弹窗白名单</SectionTitle>
      </div>
      <div className="block-rule-form-stack" data-name="settings.about.whitelist-list">
        {whitelist.length === 0 ? (
          <div className="settings-section-hint" data-name="settings.about.whitelist-empty">暂无白名单条目</div>
        ) : (
          whitelist.map((origin, idx) => (
            <div key={origin} className="about-row" data-name={`settings.about.whitelist-item-${idx + 1}`} data-index={idx + 1} data-id={origin}>
              <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }} data-name={`settings.about.whitelist-item-${idx + 1}-value`}>{origin}</span>
              <Button
                variant="text"
                danger
                className="voice-uninstall-btn"
                onClick={() => void handleRemoveOrigin(origin)}
                data-name={`settings.about.whitelist-item-${idx + 1}-remove-button`}
              >
                移除
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="voice-field-row" data-name="settings.about.whitelist-add-row">
        <input
          type="text"
          className="voice-input input-underline"
          value={newOrigin}
          onChange={(e) => setNewOrigin(e.target.value)}
          placeholder="https://example.com/"
          data-name="settings.about.whitelist-add-input"
        />
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleAddOrigin()}
          disabled={!newOrigin.trim()}
          data-name="settings.about.whitelist-add-button"
        >
          添加
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionTitle>数据管理</SectionTitle>
      </div>
      <div className="block-rule-form-stack" data-name="settings.about.data-management-stack">
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleOpenExportWindow()}
          data-name="settings.about.export-button"
        >
          数据迁移
        </button>
        {!confirming ? (
          <button
            type="button"
            className="btn-primary-flat is-danger"
            onClick={() => setConfirming(true)}
            data-name="settings.about.clear-data-button"
          >
            清除所有数据
          </button>
        ) : (
          <div className="block-rule-form-stack" data-name="settings.about.clear-confirm">
            <div className="settings-section-hint" data-name="settings.about.clear-confirm-hint">
              此操作将删除全部设置、对话历史、提示词、语音模型等数据，并重启应用。不可恢复，确定继续？
            </div>
            <div className="proxy-actions" data-name="settings.about.clear-confirm-actions">
              <button
                type="button"
                className="btn-text"
                style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
                onClick={() => setConfirming(false)}
                disabled={clearing}
                data-name="settings.about.clear-cancel-button"
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary-flat is-danger"
                onClick={handleClearAllData}
                disabled={clearing}
                data-name="settings.about.clear-confirm-button"
              >
                {clearing ? '清除中…' : '确认清除'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
