// installer-tauri/src/steps/StepDone.tsx
// 完成页：完成信息；配置已在安装前决策

import type { InstallerInfo, InstallMode } from '../global'

export interface StepDoneProps {
  info: InstallerInfo | null
  finalizing?: boolean
  launchAfterInstall: boolean
  setLaunchAfterInstall: (value: boolean) => void
  actionName: string
  mode: InstallMode
  finalDir: string
  installDir: string
  residualNote: string
  closeBanner: string
}

export default function StepDone({
  info, launchAfterInstall, setLaunchAfterInstall, finalizing,
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
        <label style={{ display: 'block', marginTop: 18 }}>
          <input type="checkbox" disabled={finalizing} checked={launchAfterInstall} onChange={event => setLaunchAfterInstall(event.target.checked)} />
          {` 完成后打开本次安装的工百窗${info?.editionLabel ? ` · ${info.editionLabel}` : ''}`}
        </label>
        {finalizing && <p role="status">{launchAfterInstall ? '正在等待已有程序保存退出，并确认本次安装的窗口打开。' : '正在完成安装设置。'}</p>}
        {residualNote && (
          <div className="hint hint--warning" style={{ marginTop: 10, textAlign: 'left' }}>
            <span className="hint__icon">!</span>
            <span>{residualNote} 可重新运行安装器再次清理。</span>
          </div>
        )}
        {closeBanner && (
          <div className="hint hint--warning" style={{ marginTop: 10, textAlign: 'left' }}>
            <span className="hint__icon">!</span>
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
