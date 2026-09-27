// installer-tauri/src/tabs/OptionsTab.tsx
// 安装选项：应用行为 + 日志（安装前决策）
// 不在此展示默认内置模块开关：可选大组件在 ComponentsPanel，其余默认安装

import type { InstallerInfo } from '../global'
import type { OptionsTab as OptionsTabId } from '../types'

export interface OptionsTabProps {
  info: InstallerInfo | null
  optionsTab: OptionsTabId
  setOptionsTab: (tab: OptionsTabId) => void
  launchAfterInstall: boolean
  setLaunchAfterInstall: (value: boolean) => void
  showGuideAfterInstall: boolean
  setShowGuideAfterInstall: (value: boolean) => void
  options: Record<string, boolean | string>
  toggleOption: (id: string) => void
  setChoiceOption: (id: string, value: string) => void
  embedded?: boolean
}

export default function OptionsTab({
  info,
  optionsTab,
  setOptionsTab,
  launchAfterInstall,
  setLaunchAfterInstall,
  showGuideAfterInstall,
  setShowGuideAfterInstall,
  options,
  toggleOption,
  setChoiceOption,
  embedded = false,
}: OptionsTabProps) {
  const behaviorOptions = info?.options.filter((o) => o.page === 'behavior') ?? []
  const loggingOptions = info?.options.filter((o) => o.page === 'logging') ?? []
  const tabs: { id: OptionsTabId; label: string }[] = [
    { id: 'behavior', label: '应用行为' },
    { id: 'logging', label: '日志' },
  ]
  return (
    <>
      {embedded ? (
        <div className="field-label">安装选项</div>
      ) : (
        <h1 className="content__title">安装选项</h1>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="check-row" onClick={() => setLaunchAfterInstall(!launchAfterInstall)}>
          <div className={`checkbox ${launchAfterInstall ? 'checkbox--checked' : ''}`}>
            {launchAfterInstall ? '✓' : ''}
          </div>
          <div className="check-row__text">
            向导关闭后启动 SidekickAI
            <div className="opt-desc">点击完成或关闭安装向导时自动打开 SidekickAI</div>
          </div>
        </div>
        <div className="check-row" onClick={() => setShowGuideAfterInstall(!showGuideAfterInstall)}>
          <div className={`checkbox ${showGuideAfterInstall ? 'checkbox--checked' : ''}`}>
            {showGuideAfterInstall ? '✓' : ''}
          </div>
          <div className="check-row__text">
            安装完成后打开使用指南
            <div className="opt-desc">额外介绍窗口布局与常用快捷键（可稍后在菜单中再次打开）</div>
          </div>
        </div>
      </div>
      <div className="tabs" style={{ marginTop: embedded ? 10 : 14 }}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${optionsTab === t.id ? 'tab--active' : ''}`}
            onClick={() => setOptionsTab(t.id)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {optionsTab === 'behavior' && (
        <div style={{ marginTop: 16 }}>
          <div className="field-label">应用行为</div>
          <div className="opt-group">
            {behaviorOptions.map((opt) => (
              <div
                key={opt.id}
                className="check-row check-row--rich"
                onClick={() => toggleOption(opt.id)}
              >
                <div className={`checkbox ${options[opt.id] ? 'checkbox--checked' : ''}`}>
                  {options[opt.id] ? '✓' : ''}
                </div>
                <div className="check-row__text">
                  <div className="opt-title">{opt.label}</div>
                  <div className="opt-desc">{opt.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {optionsTab === 'logging' && (
        <div style={{ marginTop: 16 }}>
          <div className="field-label">日志</div>
          <div className="opt-group">
            {loggingOptions.map((opt) => {
              if (opt.type === 'choice') {
                return (
                  <div key={opt.id} className="opt-row">
                    <div className="opt-row__label">
                      <div className="opt-title">{opt.label}</div>
                      <div className="opt-desc">{opt.description}</div>
                    </div>
                    <select
                      className="select"
                      value={String(options[opt.id] ?? opt.defaultValue)}
                      onChange={(e) => setChoiceOption(opt.id, e.target.value)}
                    >
                      {(opt.choices ?? []).map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              }
              return (
                <div key={opt.id} className="check-row check-row--rich" onClick={() => toggleOption(opt.id)}>
                  <div className={`checkbox ${options[opt.id] ? 'checkbox--checked' : ''}`}>
                    {options[opt.id] ? '✓' : ''}
                  </div>
                  <div className="check-row__text">
                    <div className="opt-title">{opt.label}</div>
                    <div className="opt-desc">{opt.description}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
