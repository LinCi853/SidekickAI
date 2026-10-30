import { product, edition } from '../../../../packages/product-contract'
import { useCallback, useEffect, useState } from 'react'
import type { PlatformCapabilities } from '../../../lib/electron-api'
import {
  getPlatformCapabilities,
  clearAllData,
  openExportWindow,
  openExternal,
} from '../../../lib/electron-api'
import { SectionTitle } from '../../ui'
import UpdateStatus from '../../UpdateStatus'

// 关于页只负责把用户送到官网；联系方式与二维码由官网页面承载。
const SITE = 'https://www.oxysigned.com/'

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

const STORAGE_LABELS: Record<string, string> = {
  dpapi: 'Windows DPAPI',
  keychain: 'macOS Keychain',
  libsecret: 'Linux libsecret',
  fallback: 'XOR 降级',
}

/** 设置窗口未获剪贴板写入权限时退回选区复制，保证点击可复制。 */
async function writeClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

export default function AboutSection() {
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleOpenLink = useCallback((url: string) => {
    void openExternal(url).catch((error) => {
      console.error('[AboutSection] 打开外部链接失败:', error)
    })
  }, [])

  const handleCopyDeviceId = useCallback(() => {
    if (!caps?.deviceId) return
    void writeClipboard(caps.deviceId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [caps?.deviceId])

  useEffect(() => {
    void getPlatformCapabilities()
      .then(setCaps)
      .catch(() => {})
  }, [])

  const handleClearAllData = async () => {
    setClearing(true)
    try {
      await clearAllData()
    } catch {
      setClearing(false)
      setConfirming(false)
    }
  }

  const handleOpenExportWindow = async () => {
    try {
      await openExportWindow()
    } catch (err) {
      console.error('[AboutSection] 打开数据迁移窗口失败:', err)
    }
  }

  return (
    <section data-name="settings.about.section">
      <SectionTitle>关于</SectionTitle>
      <div className="about-row" data-name="settings.about.name-row">
        <span data-name="settings.about.name-label">名称</span>
        <button
          type="button"
          className="about-name-link"
          onClick={() => handleOpenLink(SITE)}
          title="打开官网"
          data-name="settings.about.name-value"
        >
          {product.name}（{product.displayName} · {edition.label}）
        </button>
      </div>
      <div className="about-row about-version-row" data-name="settings.about.version-row">
        <span data-name="settings.about.version-label">版本</span>
        <div className="about-version-content">
          <span data-name="settings.about.version-value">v{caps?.appVersion ?? '—'}</span>
          <UpdateStatus />
        </div>
      </div>
      <div className="about-row" data-name="settings.about.device-id-row">
        <span data-name="settings.about.device-id-label">设备码</span>
        <span
          data-name="settings.about.device-id-value"
          onClick={handleCopyDeviceId}
          title="点击复制"
          style={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}
        >
          {caps?.deviceId ?? '—'}
          {copied && <span style={{ color: 'var(--success)', marginLeft: 8 }}>已复制</span>}
        </span>
      </div>
      <div className="about-row" data-name="settings.about.platform-row">
        <span data-name="settings.about.platform-label">平台</span>
        <span data-name="settings.about.platform-value">
          {caps ? `${PLATFORM_LABELS[caps.platform] ?? caps.platform} (${caps.arch})` : '—'}
        </span>
      </div>
      <div className="about-row" data-name="settings.about.secure-storage-row">
        <span data-name="settings.about.secure-storage-label">安全存储</span>
        <span
          style={{ color: caps?.hasSecureStorage ? 'var(--success)' : 'var(--danger)' }}
          data-name="settings.about.secure-storage-value"
        >
          {caps
            ? `${caps.hasSecureStorage ? '✓' : '✗'} ${STORAGE_LABELS[caps.storageBackend] ?? caps.storageBackend}`
            : '—'}
        </span>
      </div>
      <div className="about-row" data-name="settings.about.global-shortcut-row">
        <span data-name="settings.about.global-shortcut-label">全局快捷键</span>
        <span
          style={{ color: caps?.hasGlobalShortcut ? 'var(--success)' : 'var(--danger)' }}
          data-name="settings.about.global-shortcut-value"
        >
          {caps ? (caps.hasGlobalShortcut ? '✓ 可用' : '✗ 不可用') : '—'}
        </span>
      </div>

      <SectionTitle className="section-title-spacer">数据管理</SectionTitle>
      <div className="block-rule-form-stack" data-name="settings.about.data-management-stack">
        {/* 两个按钮都很短，横向并排；此前塞进纵向堆叠容器，被拆成两行 */}
        <div className="confirm-action-row" data-name="settings.about.data-management-actions">
          <button
            type="button"
            className="btn-outline btn-outline-sm"
            onClick={() => void handleOpenExportWindow()}
            data-name="settings.about.export-button"
          >
            数据迁移
          </button>
          {!confirming && (
            <button
              type="button"
              className="btn-primary-flat is-danger"
              onClick={() => setConfirming(true)}
              data-name="settings.about.clear-data-button"
            >
              清除所有数据
            </button>
          )}
        </div>
        {confirming && (
          <div className="block-rule-form-stack" data-name="settings.about.clear-confirm">
            <div
              className="settings-section-hint is-compact"
              data-name="settings.about.clear-confirm-hint"
            >
              确认清除？不可恢复。
            </div>
            <div className="confirm-action-row" data-name="settings.about.clear-confirm-actions">
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
  )
}
