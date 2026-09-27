// Installation directory selection and confirmed maintenance targets.

import type {
  CloudAssetWire,
  InstallerInfo,
  InstallMode,
  ScanResult,
} from '../global'
import type { OptionsTab as OptionsTabId } from '../types'
import ComponentsPanel from '../components/ComponentsPanel'
import OptionsTab from '../tabs/OptionsTab'

export interface StepLocationProps {
  actionName: string
  mode: InstallMode
  info: InstallerInfo | null
  scan: ScanResult | null
  installDir: string
  setInstallDir: (dir: string) => void
  forAllUsers: boolean
  setForAllUsers: (value: boolean) => void
  browseDir: () => void
  cleanupPaths: string[]
  toggleCleanup: (path: string) => void
  features: Record<string, boolean>
  toggleFeature: (id: string) => void
  cloudNotice: string
  cloudAssets: CloudAssetWire[]
  optionsTab: OptionsTabId
  setOptionsTab: (tab: OptionsTabId) => void
  launchAfterInstall: boolean
  setLaunchAfterInstall: (value: boolean) => void
  showGuideAfterInstall: boolean
  setShowGuideAfterInstall: (value: boolean) => void
  options: Record<string, boolean | string>
  toggleOption: (id: string) => void
  setChoiceOption: (id: string, value: string) => void
}

export default function StepLocation({
  actionName,
  mode,
  info,
  scan,
  installDir,
  setInstallDir,
  forAllUsers,
  setForAllUsers,
  browseDir,
  cleanupPaths,
  toggleCleanup,
  features,
  toggleFeature,
  cloudNotice,
  cloudAssets,
  optionsTab,
  setOptionsTab,
  launchAfterInstall,
  setLaunchAfterInstall,
  showGuideAfterInstall,
  setShowGuideAfterInstall,
  options,
  toggleOption,
  setChoiceOption,
}: StepLocationProps) {
  const otherLocations = (scan?.locations ?? []).filter(
    (l) => l.path.toLowerCase() !== installDir.toLowerCase()
  )

  if (mode === 'install') {
    return (
      <>
        <h1 className="content__title">安装选项</h1>
        <p className="content__subtitle">确认安装位置与应用行为后再开始安装。</p>

        <div className="field-label" style={{ marginTop: 14 }}>安装模式</div>
        <div
          className={`card card--selectable ${forAllUsers ? 'card--selected' : ''}`}
          onClick={() => setForAllUsers(true)}
        >
          <div className="card__header">
            <div className="radio">
              <div className="radio__dot" />
            </div>
            <div>
              <div className="card__title">为本机所有用户安装</div>
              <div className="card__desc">本机用户均可使用，需要管理员权限；下方可自选安装目录</div>
            </div>
          </div>
        </div>
        <div
          className={`card card--selectable ${!forAllUsers ? 'card--selected' : ''}`}
          onClick={() => setForAllUsers(false)}
        >
          <div className="card__header">
            <div className="radio">
              <div className="radio__dot" />
            </div>
            <div>
              <div className="card__title">仅为我安装</div>
              <div className="card__desc">为当前用户登记，下方可自选安装目录</div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="field-label">安装位置</div>
          <div className="path-row">
            <input
              className="input input--mono"
              aria-label="安装位置"
              value={installDir}
              onChange={(e) => setInstallDir(e.target.value)}
              spellCheck={false}
            />
            <button className="btn" onClick={browseDir}>
              浏览
            </button>
          </div>
          <p className="opt-desc">默认目录仅为建议，可输入路径或点击“浏览”自选。同一路线可在原目录覆盖升级；若目录属于另一条路线，请先卸载原路线（默认保留用户数据），再使用该目录安装。</p>
        </div>

        {otherLocations.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="field-label">清理其他安装位置</div>
            <div className="loc-list">
              {otherLocations.map((loc) => (
                <div
                  key={loc.path}
                  className="check-row check-row--rich"
                  onClick={() => toggleCleanup(loc.path)}
                >
                  <div className={`checkbox ${cleanupPaths.includes(loc.path) ? 'checkbox--checked' : ''}`}>
                    {cleanupPaths.includes(loc.path) ? '✓' : ''}
                  </div>
                  <div className="check-row__text">
                    <div className="opt-title">{loc.path}</div>
                    <div className="opt-desc">清理该位置的旧版本文件</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <ComponentsPanel
          info={info}
          features={features}
          toggleFeature={toggleFeature}
          cloudNotice={cloudNotice}
          cloudAssets={cloudAssets}
        />
        <div style={{ marginTop: 18 }}>
          <OptionsTab
            info={info}
            optionsTab={optionsTab}
            setOptionsTab={setOptionsTab}
            launchAfterInstall={launchAfterInstall}
            setLaunchAfterInstall={setLaunchAfterInstall}
            showGuideAfterInstall={showGuideAfterInstall}
            setShowGuideAfterInstall={setShowGuideAfterInstall}
            options={options}
            toggleOption={toggleOption}
            setChoiceOption={setChoiceOption}
            embedded
          />
        </div>
      </>
    )
  }
  // Maintenance only targets a selected installation from the scan.
  const locations = scan?.locations ?? []
  return (
    <>
      <h1 className="content__title">{mode === 'repair' ? `选择${actionName}目标` : '选择卸载目标'}</h1>
      <p className="content__subtitle">
        {mode === 'repair'
          ? `选择要${actionName}的安装位置；配置与用户数据会保留。`
          : '选择要卸载的安装位置。'}
      </p>
      {locations.length === 0 ? (
        <div className="error-box" style={{ marginTop: 14 }}>
          未检测到已安装的 SidekickAI。{mode === 'repair' ? '请先执行正常安装。' : ''}
        </div>
      ) : (
        <div className="loc-list">
          {locations.map((loc) => (
            <div
              key={loc.path}
              className={`card card--selectable ${installDir === loc.path ? 'card--selected' : ''}`}
              onClick={() => setInstallDir(loc.path)}
            >
              <div className="card__header">
                <div className="radio">
                  <div className="radio__dot" />
                </div>
                <div>
                  <div className="card__title" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 13 }}>
                    {loc.path}
                  </div>
                  <div className="card__desc">
                    {loc.version && `v${loc.version} · `}
                    {loc.registered ? '已注册卸载项' : '未注册'}
                    {loc.runningPid > 0 ? ` · 运行中 (PID ${loc.runningPid})` : ''}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </>
  )
}
