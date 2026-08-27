import { useCallback, useEffect, useState } from 'react';
import type { PlatformCapabilities } from '../../../lib/electron-api';
import {
  getPlatformCapabilities,
  clearAllData,
  openExportWindow,
} from '../../../lib/electron-api';
import { SectionTitle } from '../../ui';

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
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyDeviceId = useCallback(() => {
    if (!caps?.deviceId) return;
    void navigator.clipboard.writeText(caps.deviceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [caps?.deviceId]);

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

  return (
    <section data-name="settings.about.section">
      <SectionTitle>关于</SectionTitle>
      <div className="about-row" data-name="settings.about.name-row"><span data-name="settings.about.name-label">名称</span><span data-name="settings.about.name-value">SidekickAI（工百窗）</span></div>
      <div className="about-row" data-name="settings.about.version-row"><span data-name="settings.about.version-label">版本</span><span data-name="settings.about.version-value">v{caps?.appVersion ?? '—'}</span></div>
      <div className="about-row" data-name="settings.about.device-id-row">
        <span data-name="settings.about.device-id-label">设备码</span>
        <span
          data-name="settings.about.device-id-value"
          onClick={handleCopyDeviceId}
          title="点击复制"
          style={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}
        >
          {caps?.deviceId ?? '—'}{copied && <span style={{ color: 'var(--success)', marginLeft: 8 }}>已复制</span>}
        </span>
      </div>
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

      <SectionTitle className="section-title-spacer">数据管理</SectionTitle>
      <div className="block-rule-form-stack" data-name="settings.about.data-management-stack">
        <button
          type="button"
          className="btn-outline btn-outline-sm"
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
              确认清除？不可恢复。
            </div>
            <div className="block-rule-form-stack" data-name="settings.about.clear-confirm-actions">
              <button
                type="button"
                className="btn-outline btn-outline-sm"
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
