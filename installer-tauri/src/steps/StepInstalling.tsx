// installer-tauri/src/steps/StepInstalling.tsx
// 执行中：仅状态与进度；选项已在「安装选项」页决策完毕

import type { InstallMode } from '../global'
import type { StepId } from '../types'

export interface StepInstallingProps {
  actionName: string
  mode: InstallMode
  errorMsg: string
  statusText: string
  progress: number
  closeBanner: string
  setStep: (step: StepId) => void
  startRun: () => void
}

export default function StepInstalling({
  actionName,
  mode,
  errorMsg,
  statusText,
  progress,
  closeBanner,
  setStep,
  startRun,
}: StepInstallingProps) {
  const banner = closeBanner ? (
    <div className="hint hint--warning" style={{ marginTop: 12, textAlign: 'left' }}>
      <span className="hint__icon">!</span>
      <span>{closeBanner}</span>
    </div>
  ) : null
  if (errorMsg) {
    return (
      <div style={{ width: '100%' }}>
        <div className="state-head">
          <div className="state-dot state-dot--error">!</div>
          <div className="state-text state-text--error">
            {`${actionName}失败`}
          </div>
        </div>
        <div className="error-box" style={{ maxWidth: 420, textAlign: 'left', marginTop: 10 }}>
          {errorMsg}
        </div>
        {banner}
        <div className="footer__actions" style={{ marginTop: 22 }}>
          <button className="btn" onClick={() => setStep('location')}>
            返回修改
          </button>
          <button className="btn btn--primary" onClick={startRun}>
            重试
          </button>
        </div>
      </div>
    )
  }
  return (
    <div style={{ width: '100%' }}>
      <div className="state-head">
        <div className="state-dot">
          <span className="state-dot__spinner" />
        </div>
        <div className="state-text">{statusText || '正在执行…'}</div>
        <div className="state-percent">{Math.round(progress)}%</div>
      </div>
      <div className="progress__bar" style={{ marginTop: 14 }}>
        <div className="progress__bar-fill" style={{ width: `${progress}%` }} />
      </div>
      {banner}
    </div>
  )
}
