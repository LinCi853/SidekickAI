import { useEffect, useRef, useState, type ReactNode } from 'react'
import './wizard.css'

export const WIZARD_DESIGN_VERSION = '1.0.0'
export type DataPolicy = 'keep' | 'export' | 'delete'
const icon = new URL('../../resources/icons/icon.png', import.meta.url).href

export interface WizardShellProps {
  edition: 'open-source' | 'online'
  kind?: 'install' | 'uninstall'
  version?: string
  stages: Array<{ id: string; label: string }>
  currentIndex: number
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  overlay?: ReactNode
  className?: string
}

export function WizardShell({ edition, kind = 'install', version, stages, currentIndex, onClose, children, footer, overlay, className = '' }: WizardShellProps) {
  const editionName = edition === 'open-source' ? '开源版' : '联网版'
  const title = '工百窗' + editionName + (kind === 'uninstall' ? '卸载向导' : '安装向导')
  return <div className={'sk-wizard ' + className} data-wizard-design={WIZARD_DESIGN_VERSION}>
    <header className="sk-wizard__titlebar" data-tauri-drag-region>
      <div className="sk-wizard__title" data-tauri-drag-region>
        <img src={icon} alt="" draggable={false} />
        <span>{title}</span>
      </div>
      <button type="button" className="sk-wizard__close" onClick={onClose} title="关闭" aria-label="关闭">✕</button>
    </header>
    <div className="sk-wizard__layout">
      <aside className="sk-wizard__brand">
        <img className="sk-wizard__mark" src={icon} alt="" draggable={false} />
        <div className="sk-wizard__name">工百窗</div>
        <div className="sk-wizard__wordmark">SidekickAI</div>
        <div className="sk-wizard__edition">{editionName}</div>
        <ol className="sk-wizard__stages" aria-label="当前进度">
          {stages.map((stage, index) => <li key={stage.id} aria-current={index === currentIndex ? 'step' : undefined} className={index < currentIndex ? 'is-complete' : ''}>
            <span>{index < currentIndex ? '✓' : index + 1}</span><strong>{stage.label}</strong>
          </li>)}
        </ol>
        <div className="sk-wizard__version">{version ? 'v' + version : '正在读取版本…'}</div>
      </aside>
      <main className="sk-wizard__content">
        <div className="sk-wizard__body">{children}</div>
        {footer && <div className="sk-wizard__footer">{footer}</div>}
      </main>
    </div>
    {overlay}
  </div>
}

export function CloseConfirmation({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    const buttons = element?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel.current(); return }
      if (event.key !== 'Tab' || !buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    element?.addEventListener('keydown', handleKey)
    return () => { element?.removeEventListener('keydown', handleKey); previous?.focus() }
  }, [])
  return <div className="sk-confirm-mask" onClick={onCancel}>
    <div ref={dialog} className="sk-confirm" role="dialog" aria-modal="true" aria-labelledby="wizard-close-title" onClick={event => event.stopPropagation()}>
      <h2 id="wizard-close-title">{busy ? '确定要取消操作吗？' : '确定要退出吗？'}</h2>
      <p>{busy ? '将请求安全取消。已开始的操作可能无法取消，请等待最终结果。' : '当前操作尚未开始，退出不会修改安装文件或用户数据。'}</p>
      <div className="sk-confirm__actions">
        <button type="button" onClick={onCancel} autoFocus>继续</button>
        <button type="button" className="sk-primary" onClick={onConfirm}>{busy ? '请求取消' : '确定退出'}</button>
      </div>
    </div>
  </div>
}

export function DataPolicyPicker({ value, onChange, exportDescription, children }: { value: DataPolicy; onChange: (value: DataPolicy) => void; exportDescription?: string; children?: ReactNode }) {
  const choices: Array<{ value: DataPolicy; title: string; description: string }> = [
    { value: 'keep', title: '保留用户数据', description: '移除应用、快捷方式和卸载登记，保留本机用户数据，重新安装后可继续使用。' },
    { value: 'export', title: '导出备份后删除', description: exportDescription || '完整导出并验证备份后，再移除本机用户数据；备份失败则保留原数据。' },
    { value: 'delete', title: '直接删除全部用户数据', description: '不生成备份，移除当前版本的数据、配置和缓存。此操作不可恢复。' },
  ]
  return <div className="sk-policy" aria-label="用户数据处理">
    {choices.map(choice => <div key={choice.value}>
      <button type="button" className={'sk-policy__choice ' + (value === choice.value ? 'is-selected' : '')} aria-pressed={value === choice.value} onClick={() => onChange(choice.value)}>
        <span className="sk-policy__radio" aria-hidden="true" />
        <span><strong>{choice.title}{choice.value === 'keep' && <em>默认</em>}</strong><small>{choice.description}</small></span>
      </button>
      {choice.value === 'export' && value === 'export' && <div className="sk-policy__export">{children}</div>}
    </div>)}
  </div>
}

export interface WizardDetailsProps {
  summary: Array<[string, string]>
  lines?: string[]
  logPath?: string
  logError?: string
  onOpenLog?: () => Promise<void>
}

export function WizardDetails({ summary, lines = [], logPath, logError, onOpenLog }: WizardDetailsProps) {
  const [actionError, setActionError] = useState('')
  return <section className="sk-details" aria-label="操作详情">
    <dl>{summary.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {lines.length > 0 && <details open><summary>执行记录（{lines.length} 条）</summary><ol>{lines.map((line, index) => <li key={index}>{line}</li>)}</ol></details>}
    {logPath && <p className="sk-details__log">日志已保存：{logPath}</p>}
    <div className="sk-details__actions">
      <button type="button" onClick={() => {
        setActionError('')
        if (!navigator.clipboard?.writeText) { setActionError('当前窗口无法访问剪贴板，请选择详情文本手动复制。'); return }
        const text = [...summary.filter(([, value]) => value).map(([label, value]) => label + '：' + value), ...lines, ...(logPath ? ['日志：' + logPath] : [])].join('\n')
        void navigator.clipboard.writeText(text).catch(error => setActionError('无法复制：' + String(error)))
      }}>复制详情</button>
      {logPath && onOpenLog && <button type="button" onClick={() => { setActionError(''); void onOpenLog().catch(error => setActionError('无法打开日志：' + String(error))) }}>打开日志</button>}
    </div>
    {(logError || actionError) && <p role="alert">{logError || actionError}</p>}
  </section>
}
