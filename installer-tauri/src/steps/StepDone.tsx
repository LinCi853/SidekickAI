// Completed deployment with a separate application opening state.

import type { InstallerInfo, InstallMode } from '../global'
import type { CompletionIntent } from '../../../installer-shared/presentation/finalize'

export interface StepDoneProps {
  info: InstallerInfo | null
  finalizing?: boolean
  completionIntent: CompletionIntent
  completionStatus?: string
  actionName: string
  mode: InstallMode
  finalDir: string
  installDir: string
  residualNote: string
  closeBanner: string
}

export default function StepDone({
  info, completionIntent, completionStatus, finalizing,
  actionName,
  mode,
  finalDir,
  installDir,
  residualNote,
  closeBanner,
}: StepDoneProps) {
  const isRepair = mode === 'repair'
  return (
    <>
      <div className="done-wrap">
        <div className="done__icon">✓</div>
        <div className="done__title">{`工百窗${info?.editionLabel ? ` · ${info.editionLabel}` : ''}${actionName}完成`}</div>
        <div className="done__desc">版本 {info?.version}</div>
        <div className="done__desc">
          {isRepair
            ? `已${actionName}：${finalDir || installDir}`
            : `SidekickAI 已安装到：${finalDir || installDir}`}
        </div>
        {finalizing && <p role="status">{completionStatus || (completionIntent === 'open' ? '正在核对启动条件…' : '正在完成安装设置并关闭向导。')}</p>}
        {residualNote && (
          <div className="hint hint--warning" style={{ marginTop: 10, textAlign: 'left' }}>
            <span className="hint__icon">!</span>
            <span>{residualNote} 可重新运行安装器再次清理。</span>
          </div>
        )}
        {closeBanner && (
          <div role="status" className="hint" style={{ marginTop: 10, textAlign: 'left' }}>
            <span className="hint__icon">…</span>
            <span>{closeBanner}</span>
          </div>
        )}
      </div>
      <div className="hint" style={{ marginTop: 18 }}>
        <span className="hint__icon">✓</span>
        <span>{isRepair ? '现有设置、安装配置、已下载资源与业务数据均已保留。' : '本次所选配置将在首次启动时应用，业务数据保留。'}</span>
      </div>
    </>
  )
}
