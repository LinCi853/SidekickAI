// installer-tauri/src/steps/StepWelcome.tsx
// 首页：模式选择（正常安装 / 修复 / 卸载）+ 已有安装位置摘要

import type { Dispatch, SetStateAction } from 'react'
import type { InstallerInfo, InstallMode, ScanResult } from '../global'
import LocationItem from '../components/LocationItem'
import { formatVersion } from '../../../installer-shared/presentation/version'

export interface StepWelcomeProps {
  actionName: string
  mode: InstallMode
  setMode: Dispatch<SetStateAction<InstallMode>>
  scan: ScanResult | null
  info: InstallerInfo | null
}

export default function StepWelcome({ mode, setMode, scan, info, actionName }: StepWelcomeProps) {
  const hasInstall = (scan?.locations.length ?? 0) > 0
  const showRepair = !scan || hasInstall
  const showUninstall = showRepair || Boolean(scan?.otherEditions?.length)
  return (
    <>
      <h1 className="content__title">欢迎安装工百窗{info?.editionLabel ? ` · ${info.editionLabel}` : ''}</h1>
      <p className="content__subtitle">
        AI 时代的个人操作台。请选择要执行的操作。
      </p>
      {Boolean(scan?.otherEditions?.length) && <div className="hint hint--warning" role="status" style={{ marginTop: 14 }}>
        <div>
          <strong>检测到另一版工百窗已安装</strong>
          {scan!.otherEditions!.map(location => <div key={location.path} style={{ marginTop: 8 }}>
            <div title={location.version ?? undefined}>{location.label} · {formatVersion(location.version || '版本未知')} · {location.arch === 'arm64' ? 'ARM64' : location.arch}</div>
            <div style={{ overflowWrap: 'anywhere' }}>{location.path}</div>
          </div>)}
          <p>两版可以分别安装，用户数据保持独立。请为本次安装选择独立目录。</p>
        </div>
      </div>}
      {scan?.otherEditionsWarning && <div className="hint hint--warning" role="alert" style={{ marginTop: 14 }}>{scan.otherEditionsWarning}</div>}
      {scan && hasInstall && (
        <div className="hint hint--warning" style={{ marginTop: 14 }}>
          <span className="hint__icon">!</span>
          <span>{scan.residualHint}</span>
        </div>
      )}
      {scan && hasInstall && (
        <div className="loc-list">
          {scan.locations.map((loc) => (
            <LocationItem key={loc.path} loc={loc} isTarget={loc.path === scan.recommendedDir} />
          ))}
        </div>
      )}
      <div className="mode-grid">
        <div
          className={`mode-card ${mode === 'install' ? 'mode-card--selected' : ''}`}
          onClick={() => setMode('install')}
        >
          <div className="mode-card__icon">◆</div>
          <div className="mode-card__title">正常安装</div>
          <div className="mode-card__desc">
            {hasInstall ? '覆盖已检测到的安装位置' : '全新安装 SidekickAI（约 1 分钟）'}
          </div>
        </div>
        {showRepair && (
          <div
            className={`mode-card ${mode === 'repair' ? 'mode-card--selected' : ''}`}
            onClick={() => setMode('repair')}
          >
            <div className="mode-card__icon">◈</div>
            <div className="mode-card__title">{actionName === '修复' ? '修复安装' : actionName}</div>
            <div className="mode-card__desc">更新完整程序与运行库，保留配置与数据</div>
          </div>
        )}
        {showUninstall && (
          <div
            className={`mode-card ${mode === 'uninstall' ? 'mode-card--selected' : ''}`}
            onClick={() => setMode('uninstall')}
          >
            <div className="mode-card__icon">▣</div>
            <div className="mode-card__title">卸载</div>
            <div className="mode-card__desc">移除 SidekickAI，可选择保留用户数据</div>
          </div>
        )}
      </div>
      {info && (
        <div className="space-row" style={{ marginTop: 20 }}>
          <span title={info.version}>版本 {formatVersion(info.version)}</span>
          <span>架构 {info.arch === 'arm64' ? 'ARM64' : 'x64'}</span>
          <span>所需空间 {info.requiredSpace}</span>
        </div>
      )}
    </>
  )
}
