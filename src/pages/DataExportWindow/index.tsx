import { useEffect, useRef, useState } from 'react'
import WindowResizeHandles from '../../components/WindowResizeHandles'
import { IconButton, PinToggleButton } from '../../components/ui'
import { useEscToCloseWindow } from '../../hooks/useEscToCloseWindow'
import { useWindowMaximizedAndPinned } from '../../hooks/useWindowMaximizedAndPinned'
import { minimizeWindow, closeCurrentWindow, selectExportPath, exportData, selectImportFile, importData, inspectBackup, importDataDecrypted, detectBackupEncrypted } from '../../lib/electron-api'
import './index.css'

const BACKUP_OPTIONS = { basicData: true, cookies: true, indexedDB: true, cache: false, voiceAssets: false }

export default function DataExportWindow() {
  const { isMaximized, isPinned, handleMaximize, handleTogglePin } = useWindowMaximizedAndPinned()
  const [exportPassword, setExportPassword] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [importFilePath, setImportFilePath] = useState<string | null>(null)
  const [importNeedsPassword, setImportNeedsPassword] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const passwordInput = useRef<HTMLInputElement>(null)
  const busy = exporting || importing
  useEscToCloseWindow()
  useEffect(() => { if (importNeedsPassword) passwordInput.current?.focus() }, [importNeedsPassword])

  const handleExport = async () => {
    if (busy) return
    if (exportPassword && exportPassword.length < 6) { window.alert('备份密码至少需要 6 位。'); return }
    setExporting(true); setMessage('')
    try {
      const target = await selectExportPath(!!exportPassword)
      if (!target) return
      const result = await exportData(target, BACKUP_OPTIONS, exportPassword ? { password: exportPassword } : undefined)
      if (result.success) { setMessage('备份已保存。'); setExportPassword('') }
      else if (!result.error?.includes('后台继续')) window.alert(result.error ?? '备份失败，请重试。')
    } catch (error) { window.alert((error as Error).message) }
    finally { setExporting(false) }
  }

  const handleSelectFile = async () => {
    if (busy) return
    try {
      const file = await selectImportFile()
      if (!file) return
      const encrypted = await detectBackupEncrypted(file)
      setImportFilePath(file); setImportPassword(''); setImportNeedsPassword(encrypted); setMessage('')
    } catch (error) { window.alert((error as Error).message) }
  }

  const handleImport = async () => {
    if (busy || !importFilePath || importNeedsPassword && !importPassword) return
    setImporting(true); setMessage('')
    let prepared = false
    try {
      const password = importNeedsPassword ? importPassword : undefined
      const inspection = await inspectBackup(importFilePath, password)
      if (!inspection.success) {
        if (inspection.encrypted) setImportNeedsPassword(true)
        window.alert(inspection.error ?? '无法读取此备份。')
        return
      }
      const scope = inspection.mode === 'limited' ? '将合并通用配置，并替换对应的网页登录资料。' : '将用备份替换对应的当前数据。'
      if (!window.confirm(scope + '\n完成后自动重启，是否继续？')) return
      const result = password ? await importDataDecrypted(importFilePath, password, inspection.fingerprint) : await importData(importFilePath, inspection.fingerprint)
      if (!result.success) {
        if ('encrypted' in result && result.encrypted) setImportNeedsPassword(true)
        window.alert(result.error ?? '导入失败，请重试。')
        return
      }
      prepared = true; setImportPassword(''); setMessage('正在重启…')
    } catch (error) { window.alert((error as Error).message) }
    finally { if (!prepared) setImporting(false) }
  }

  return <>
    <WindowResizeHandles />
    <div className="data-export-view app-shell" data-name="data-export.container">
        <div className="data-export-top" data-name="data-export.topbar">
          <div className="data-export-top-drag" data-name="data-export.topbar-drag">
            <span className="data-export-top-title" data-name="data-export.topbar-title">数据迁移</span>
          </div>
          <div className="data-export-top-actions" data-name="data-export.topbar-actions">
            <PinToggleButton
              isPinned={isPinned}
              onToggle={handleTogglePin}
              data-name="data-export.topbar-pin-button"
            />
            <IconButton
              type="button"
              aria-label="最小化"
              title="最小化"
              data-name="data-export.topbar-minimize-button"
              onClick={() => void minimizeWindow()}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-minimize-icon">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </IconButton>
            <IconButton
              type="button"
              aria-label={isMaximized ? '还原' : '最大化'}
              title={isMaximized ? '还原' : '最大化'}
              data-name="data-export.topbar-maximize-button"
              onClick={() => void handleMaximize()}
            >
              {isMaximized ? (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-restore-icon">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-maximize-icon">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
              )}
            </IconButton>
            <IconButton
              type="button"
              variant="close"
              aria-label="关闭"
              title="关闭"
              data-name="data-export.topbar-close-button"
              onClick={() => void closeCurrentWindow()}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="data-export.topbar-close-icon">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </IconButton>
          </div>
        </div>


      <div className="data-export-body">
        <section className="data-export-section" data-name="data-export.export-section">
          <h2>导出备份</h2>
          <p>保存应用设置和数据，方便以后恢复。</p>
          <input className="input" type="password" aria-label="备份密码（选填）" placeholder="备份密码（选填，至少 6 位）" autoComplete="new-password" value={exportPassword} onChange={event => setExportPassword(event.target.value)} disabled={busy} data-name="data-export.encrypt-password-input" />
          <button className="btn-primary-flat" disabled={busy} onClick={handleExport} data-name="data-export.export-button">{exporting ? '正在备份…' : '导出备份'}</button>
        </section>
        <section className="data-export-section" data-name="data-export.import-section">
          <h2>导入备份</h2>
          <p>选择备份文件，自动恢复可用数据。</p>
          {importFilePath && <div className="data-export-file" data-name="data-export.import-file-path">{importFilePath}</div>}
          {importNeedsPassword && <input ref={passwordInput} className="input" type="password" aria-label="备份密码" placeholder="输入备份密码" autoComplete="off" value={importPassword} onChange={event => setImportPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void handleImport() }} disabled={busy} data-name="data-export.import-password-input" />}
          <div className="data-export-actions">
            <button className="btn-outline" disabled={busy} onClick={handleSelectFile} data-name="data-export.select-file-button">{importFilePath ? '重新选择' : '选择备份文件'}</button>
            {importFilePath && <button className="btn-primary-flat" disabled={busy || importNeedsPassword && !importPassword} onClick={handleImport} data-name={importNeedsPassword ? 'data-export.import-decrypt-button' : 'data-export.confirm-import-button'}>{importing ? '正在导入…' : '导入'}</button>}
          </div>
        </section>
        {message && <p role="status" data-name="data-export.status">{message}</p>}
      </div>
    </div>
  </>
}
