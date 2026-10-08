import { useEffect, useState } from 'react'
import { Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import type { UpdateState } from '../../electron/updates/types'
import './UpdateStatus.css'

const UPDATE_HINTS: Record<UpdateState['phase'], string> = {
  idle: '', checking: '检查中', current: '已是最新', available: '有新版',
  downloading: '下载中', ready: '', failed: '更新失败',
}

export default function UpdateStatus() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle', offer: null, downloadedBytes: 0, error: null })
  const [pending, setPending] = useState(false)
  const busy = pending || state.phase === 'checking' || state.phase === 'downloading'
  useEffect(() => {
    let disposed = false
    void window.electron?.updates?.getState().then(value => { if (!disposed) setState(value) }).catch(() => {})
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => { void window.electron.updates.getState().then(setState).catch(() => {}) }, 500)
    return () => clearInterval(timer)
  }, [pending])
  async function run(action: () => Promise<UpdateState>) {
    if (pending) return
    setPending(true)
    try { setState(await action()) }
    catch (error) { setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) })) }
    finally { setPending(false) }
  }
  const hint = state.error ? '更新失败'
    : state.phase === 'ready' ? (state.offer?.kind === 'portable' ? 'ZIP 已保存' : '向导已打开')
      : UPDATE_HINTS[state.phase]
  return <>
    <span className="about-update" data-name="settings.about.updates">
      {hint && <span className={'about-update-hint' + (state.error ? ' is-error' : state.phase === 'available' ? ' is-available' : '')} role="status" title={state.error ?? undefined}>{hint}</span>}
      <button type="button" className={'btn-icon about-update-btn' + (state.phase === 'checking' ? ' is-spinning' : '')} aria-label="检查更新" title="检查更新" disabled={busy} onClick={() => void run(() => window.electron.updates.check())}>
        <RefreshCw size={14} />
      </button>
      <button type="button" className="btn-icon about-update-btn" aria-label="发行记录" title="发行记录" onClick={() => void window.electron.updates.openReleases().catch(error => setState(current => ({ ...current, error: String(error) })))}>
        <ExternalLink size={14} />
      </button>
      {state.phase === 'downloading' && <button type="button" className="btn-icon about-update-btn" aria-label="暂停下载" title="暂停下载" onClick={() => void window.electron.updates.cancel()}><X size={14} /></button>}
    </span>
    {state.offer && ['available', 'downloading'].includes(state.phase) && <div className="about-update-detail">
      <p className="settings-section-hint">新版本 {state.offer.version} · {(state.offer.sizeBytes / 1024 ** 2).toFixed(1)} MiB</p>
      {state.offer.notes && <p className="settings-section-hint about-update-notes">{state.offer.notes}</p>}
      {state.phase === 'available' && <button type="button" className="btn-outline btn-outline-sm" disabled={pending} onClick={() => void run(() => window.electron.updates.accept(state.offer!.id))}>
        <Download size={14} />{state.offer.kind === 'portable' ? '保存新版绿色 ZIP' : '下载并打开安装向导'}
      </button>}
      {state.phase === 'downloading' && <progress max={state.offer.sizeBytes} value={state.downloadedBytes} aria-label="下载进度" />}
    </div>}
    {state.phase === 'ready' && <p className="settings-section-hint about-update-detail">{state.offer?.kind === 'portable' ? '新版 ZIP 已保存，现有资料保持原位置。' : '安装向导已打开，等待维护操作。'}</p>}
    {state.error && <p className="settings-section-hint about-update-detail is-error" role="alert">{state.error}</p>}
  </>
}
