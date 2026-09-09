// installer/src/renderer/App.tsx
// SidekickAI 安装向导 — 三模式状态机
//   首页：正常安装（默认）/ 修复安装 / 卸载
//   install: 欢迎 → 协议 → 位置/残留确认 → 组件 → 应用设置 → 执行 → 完成
//   repair: 选择目标 → 修复确认 → 执行 → 完成
//   uninstall: 选择目标 → 数据策略 → 执行 → 完成

import { useState, useEffect, useCallback, useRef } from 'react'
import './styles.css'
import type { InstallerInfo, InstallLocation, InstallMode, ScanResult } from './global'

type StepId =
  | 'welcome'
  | 'license'
  | 'options'
  | 'location'
  | 'installing'
  | 'done'

/** 每个模式的步骤序列（步骤条展示用） */
const MODE_STEPS: Record<InstallMode, { id: StepId | 'repair' | 'uninstall'; label: string }[]> = {
  install: [
    { id: 'welcome', label: '欢迎' },
    { id: 'license', label: '许可协议' },
    { id: 'location', label: '安装位置' },
    { id: 'options', label: '安装选项' },
    { id: 'installing', label: '安装中' },
    { id: 'done', label: '完成' }
  ],
  repair: [
    { id: 'welcome', label: '选择模式' },
    { id: 'location', label: '选择目标' },
    { id: 'installing', label: '修复中' },
    { id: 'done', label: '完成' }
  ],
  uninstall: [
    { id: 'welcome', label: '选择模式' },
    { id: 'location', label: '卸载选项' },
    { id: 'installing', label: '卸载中' },
    { id: 'done', label: '完成' }
  ]
}

/** 选项分页：组件 / 应用行为 / 日志 */
type OptionsTab = 'components' | 'behavior' | 'logging'

export default function App() {
  const [mode, setMode] = useState<InstallMode>('install')
  const [step, setStep] = useState<StepId>('welcome')
  const [info, setInfo] = useState<InstallerInfo | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [bootstrapError, setBootstrapError] = useState('')
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  // 安装选项
  const [installDir, setInstallDir] = useState('')
  const [forAllUsers, setForAllUsers] = useState(true)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [options, setOptions] = useState<Record<string, boolean | string>>({})
  const [launchAfterInstall, setLaunchAfterInstall] = useState(true)
  const [needsAdmin, setNeedsAdmin] = useState(false)
  const [optionsTab, setOptionsTab] = useState<OptionsTab>('components')

  // 残留清理：用户勾选要清理的其他位置
  const [cleanupPaths, setCleanupPaths] = useState<string[]>([])
  // 卸载数据策略
  const [deleteUserData, setDeleteUserData] = useState(false)

  // 许可协议
  const [acceptedLicenses, setAcceptedLicenses] = useState<string[]>([])
  const [readingDoc, setReadingDoc] = useState<string | null>(null)

  // 安装进度
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [installDone, setInstallDone] = useState(false)
  const [finalDir, setFinalDir] = useState('')
  const [residualNote, setResidualNote] = useState('')

  const installingRef = useRef(false)

  // ---- 初始化：读取安装器信息 + 扫描已安装位置 ----
  useEffect(() => {
    window.installer.getInfo().then((data) => {
      setInfo(data)
      setBootstrapError('')
      setInstallDir(data.defaultDir)
      const f: Record<string, boolean> = {}
      data.features.forEach((feat) => {
        f[feat.id] = feat.defaultEnabled
      })
      setFeatures(f)
      const o: Record<string, boolean | string> = {}
      data.options.forEach((opt) => {
        o[opt.id] = opt.defaultValue
      })
      setOptions(o)
      // 默认勾选已同意协议为空；默认打开用户许可
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      setBootstrapError(`安装器初始化失败：${detail}`)
    })
    window.installer.scanInstallations().then((s) => {
      setScan(s)
      // 已有安装 → 默认覆盖到原位置
      if (s.locations.length > 0) {
        setInstallDir(s.recommendedDir)
      }
    }).catch(() => {/* 扫描失败不阻塞流程 */})
  }, [])

  // ---- 安装模式切换：自动更新到对应默认目录（仅在用户主动切换时）----
  const prevModeRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (!info) return
    if (prevModeRef.current === null) {
      prevModeRef.current = forAllUsers
      return
    }
    if (prevModeRef.current !== forAllUsers) {
      prevModeRef.current = forAllUsers
      setInstallDir(forAllUsers ? info.defaultDir : info.perUserDefaultDir)
    }
  }, [forAllUsers, info])

  // ---- 检测目标安装是否需要管理员权限 ----
  useEffect(() => {
    if (!installDir) return
    window.installer.needsAdmin(installDir, forAllUsers).then(setNeedsAdmin)
  }, [installDir, forAllUsers])

  // ---- 订阅安装事件 ----
  useEffect(() => {
    const offStatus = window.installer.onStatus((msg) => setStatusText(msg))
    const offProgress = window.installer.onProgress((p) => setProgress(p))
    const offDone = window.installer.onDone((payload) => {
      setProgress(100)
      setStatusText(mode === 'uninstall' ? '卸载完成' : mode === 'repair' ? '修复完成' : '安装完成')
      setFinalDir(payload.installDir)
      setResidualNote(payload.residualNote || '')
      setInstallDone(true)
      installingRef.current = false
      setStep('done')
    })
    const offError = window.installer.onError((msg) => {
      setErrorMsg(msg)
      installingRef.current = false
      setStatusText('操作失败')
    })
    return () => {
      offStatus()
      offProgress()
      offDone()
      offError()
    }
  }, [mode])

  // 步骤条当前索引
  const steps = MODE_STEPS[mode]
  const currentStepObj = steps.find((s) => s.id === step)
  const currentIndex = currentStepObj ? steps.indexOf(currentStepObj) : 0

  // ---- 开始执行（按模式）----
  const startRun = useCallback(async () => {
    if (installingRef.current) return
    installingRef.current = true
    setProgress(4)
    setErrorMsg('')
    setStatusText(mode === 'uninstall' ? '正在准备卸载…' : mode === 'repair' ? '正在准备修复…' : '正在准备安装…')
    setStep('installing')
    await window.installer.start({
      installDir,
      forAllUsers,
      createDesktopShortcut: true,
      launchAfterInstall,
      features,
      options,
      mode,
      cleanupPaths,
      deleteUserData,
      acceptedLicenses
    })
  }, [installDir, forAllUsers, features, options, launchAfterInstall, mode, cleanupPaths, deleteUserData, acceptedLicenses])

  // ---- 关闭窗口（二次确认）----
  const handleClose = useCallback(() => {
    if (step === 'installing') {
      setShowCloseConfirm(true)
      return
    }
    if (step === 'done') {
      window.installer.closeWindow()
      return
    }
    setShowCloseConfirm(true)
  }, [step])

  const confirmClose = useCallback(async () => {
    if (step === 'installing') {
      await window.installer.cancel()
    }
    setShowCloseConfirm(false)
    window.installer.closeWindow()
  }, [step])

  const browseDir = useCallback(async () => {
    const picked = await window.installer.browseDir(installDir)
    if (picked) setInstallDir(picked)
  }, [installDir])

  // ---- 功能开关 / 选项交互 ----
  const toggleFeature = useCallback((id: string) => {
    setFeatures((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const toggleOption = useCallback((id: string) => {
    setOptions((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const setChoiceOption = useCallback((id: string, value: string) => {
    setOptions((prev) => ({ ...prev, [id]: value }))
  }, [])

  const toggleCleanup = useCallback((path: string) => {
    setCleanupPaths((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]))
  }, [])

  const toggleLicense = useCallback((id: string) => {
    setAcceptedLicenses((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]))
  }, [])

  // ---- 渲染：步骤条 ----
  const renderSteps = () => (
    <div className="steps">
      {steps.map((s, i) => {
        const cls = i === currentIndex ? 'step step--active' : i < currentIndex ? 'step step--done' : 'step'
        return (
          <div key={s.id + s.label} className={cls}>
            <div className="step__dot">{i < currentIndex ? '✓' : i + 1}</div>
            <div className="step__label">{s.label}</div>
          </div>
        )
      })}
    </div>
  )

  // ---- 渲染：安装位置条目 ----
  const renderLocItem = (loc: InstallLocation, isTarget: boolean) => (
    <div key={loc.path} className="loc-item">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="loc-item__path">{loc.path}</div>
        <div className="loc-item__meta">
          {loc.version && <span>v{loc.version}</span>}
          {loc.registered && <span>已注册</span>}
          {loc.runningPid > 0 && <span className="loc-running">运行中 (PID {loc.runningPid})</span>}
          {isTarget && <span style={{ color: 'var(--brand-500)' }}>本次目标</span>}
        </div>
      </div>
    </div>
  )

  // ---- 渲染：首页（模式选择）----
  const renderWelcome = () => (
    <>
      <h1 className="content__title">欢迎使用 SidekickAI</h1>
      <p className="content__subtitle">
        AI 时代的个人操作台。请选择要执行的操作。
      </p>
      {scan && scan.locations.length > 0 && (
        <div className="hint hint--warning" style={{ marginTop: 14 }}>
          <span className="hint__icon">!</span>
          <span>{scan.residualHint}</span>
        </div>
      )}
      {scan && scan.locations.length > 0 && (
        <div className="loc-list">
          {scan.locations.map((loc) => renderLocItem(loc, loc.path === scan.recommendedDir))}
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
            {scan && scan.locations.length > 0 ? '覆盖已检测到的安装位置' : '全新安装 SidekickAI（约 1 分钟）'}
          </div>
        </div>
        <div
          className={`mode-card ${mode === 'repair' ? 'mode-card--selected' : ''}`}
          onClick={() => setMode('repair')}
        >
          <div className="mode-card__icon">◈</div>
          <div className="mode-card__title">修复安装</div>
          <div className="mode-card__desc">校验并替换损坏的核心文件，保留配置与数据</div>
        </div>
        <div
          className={`mode-card ${mode === 'uninstall' ? 'mode-card--selected' : ''}`}
          onClick={() => setMode('uninstall')}
        >
          <div className="mode-card__icon">▣</div>
          <div className="mode-card__title">卸载</div>
          <div className="mode-card__desc">移除 SidekickAI，可选择保留用户数据</div>
        </div>
      </div>
      {info && (
        <div className="space-row" style={{ marginTop: 20 }}>
          <span>版本 {info.version}</span>
          <span>架构 {info.arch === 'arm64' ? 'ARM64' : 'x64'}</span>
          <span>所需空间 {info.requiredSpace}</span>
        </div>
      )}
    </>
  )

  // ---- 渲染：协议页（列表 + 独立弹层）----

  const renderLicense = () => {
    const docs = info?.licenses ?? []
    const requiredIds = docs.map((d) => d.id)
    const allAccepted = requiredIds.every((id) => acceptedLicenses.includes(id))
    return (
      <>
        <h1 className="content__title">许可协议</h1>
        <p className="content__subtitle">请阅读并同意以下协议后方可继续。</p>
        <div className="license-list">
          {docs.map((d) => (
            <div key={d.id} className="license-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  className={`checkbox ${acceptedLicenses.includes(d.id) ? 'checkbox--checked' : ''}`}
                  onClick={() => toggleLicense(d.id)}
                >
                  {acceptedLicenses.includes(d.id) ? '✓' : ''}
                </div>
                <div className="license-item__title">{d.title}</div>
              </div>
              <button className="btn" onClick={() => setReadingDoc(d.id)}>
                阅读
              </button>
            </div>
          ))}
        </div>
        {!allAccepted && (
          <div className="hint" style={{ marginTop: 14 }}>
            <span className="hint__icon">!</span>
            <span>需同意全部协议后才能继续。</span>
          </div>
        )}
        {readingDoc && (
          <div className="doc-mask" onClick={() => setReadingDoc(null)}>
            <div className="doc" onClick={(e) => e.stopPropagation()}>
              <div className="doc__title">{docs.find((d) => d.id === readingDoc)?.title}</div>
              <div className="doc__body">{docs.find((d) => d.id === readingDoc)?.body}</div>
              <div className="doc__actions">
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    toggleLicense(readingDoc)
                    setReadingDoc(null)
                  }}
                >
                  已阅读并同意
                </button>
                <button className="btn" onClick={() => setReadingDoc(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  // ---- 渲染：位置/残留确认页（install 与 repair/uninstall 共用骨架）----

  const otherLocations = (scan?.locations ?? []).filter(
    (l) => l.path.toLowerCase() !== installDir.toLowerCase()
  )

  const renderLocation = () => {
    if (mode === 'install') {
      return (
        <>
          <h1 className="content__title">安装位置</h1>
          <p className="content__subtitle">确认安装位置；发现多处安装时可勾选清理。</p>

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
                <div className="card__desc">需要管理员权限，安装到 Program Files</div>
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
                <div className="card__desc">无需管理员权限，安装到当前用户的本地应用目录</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="field-label">安装位置</div>
            <div className="path-row">
              <input
                className="input input--mono"
                value={installDir}
                onChange={(e) => setInstallDir(e.target.value)}
                spellCheck={false}
              />
              <button className="btn" onClick={browseDir}>
                浏览
              </button>
            </div>
            {needsAdmin ? (
              <div className="hint hint--warning">
                <span className="hint__icon">!</span>
                <span>
                  {forAllUsers
                    ? '「为本机所有用户安装」需要管理员权限，安装时系统会请求权限确认。'
                    : '此位置（受系统保护目录）需要管理员权限，建议换一个可写目录。'}
                </span>
              </div>
            ) : (
              <div className="hint">
                <span className="hint__icon">✓</span>
                <span>当前位置无需额外权限。</span>
              </div>
            )}
          </div>

          {otherLocations.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="field-label">其他安装位置（可选清理）</div>
              <div className="hint" style={{ marginBottom: 8 }}>
                <span className="hint__icon">!</span>
                <span>建议只保留一处安装。勾选后将在安装成功后自动清理；拒绝清理则无法保证只保留一处。</span>
              </div>
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
                      <div className="opt-desc">
                        {loc.runningPid > 0 ? `运行中 (PID ${loc.runningPid})，安装时将自动关闭` : '未运行'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )
    }
    // repair / uninstall：选择目标位置
    const locations = scan?.locations ?? []
    return (
      <>
        <h1 className="content__title">{mode === 'repair' ? '选择修复目标' : '选择卸载目标'}</h1>
        <p className="content__subtitle">
          {mode === 'repair'
            ? '选择要修复的安装位置。'
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
        {mode === 'uninstall' && locations.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="field-label">用户数据</div>
            <div className="check-row check-row--rich" onClick={() => setDeleteUserData(!deleteUserData)}>
              <div className={`checkbox ${deleteUserData ? 'checkbox--checked' : ''}`}>
                {deleteUserData ? '✓' : ''}
              </div>
              <div className="check-row__text">
                <div className="opt-title">同时删除配置、Profile、缓存和日志</div>
                <div className="opt-desc">默认保留用户数据；勾选后将一并删除，不可恢复</div>
              </div>
            </div>
          </div>
        )}
        {mode === 'uninstall' && otherLocations.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">同时清理其他位置</div>
            <div className="loc-list">
              {otherLocations.map((loc) => (
                <div key={loc.path} className="check-row check-row--rich" onClick={() => toggleCleanup(loc.path)}>
                  <div className={`checkbox ${cleanupPaths.includes(loc.path) ? 'checkbox--checked' : ''}`}>
                    {cleanupPaths.includes(loc.path) ? '✓' : ''}
                  </div>
                  <div className="check-row__text">
                    <div className="opt-title">{loc.path}</div>
                    <div className="opt-desc">残留安装位置，建议一并清理</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    )
  }

  // ---- 渲染：安装选项（三页签：组件 / 应用行为 / 日志）----

  const renderOptions = () => {
    const stableFeatures = info?.features.filter((f) => f.category === 'stable') ?? []
    const devFeatures = info?.features.filter((f) => f.category === 'dev') ?? []
    const behaviorOptions = info?.options.filter((o) => o.page === 'behavior') ?? []
    const loggingOptions = info?.options.filter((o) => o.page === 'logging') ?? []
    const tabs: { id: OptionsTab; label: string }[] = [
      { id: 'components', label: '组件' },
      { id: 'behavior', label: '应用行为' },
      { id: 'logging', label: '日志' }
    ]
    return (
      <>
        <h1 className="content__title">安装选项</h1>
        <div className="tabs">
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

        {optionsTab === 'components' && (
          <div style={{ marginTop: 16 }}>
            <div className="field-label">功能组件</div>
            <div className="opt-group">
              {stableFeatures.map((f) => (
                <div
                  key={f.id}
                  className={`check-row check-row--rich ${f.required ? 'check-row--locked' : ''}`}
                  onClick={() => {
                    if (!f.required) toggleFeature(f.id)
                  }}
                >
                  <div className={`checkbox ${features[f.id] ? 'checkbox--checked' : ''}`}>
                    {features[f.id] ? '✓' : ''}
                  </div>
                  <div className="check-row__text">
                    <div className="opt-title">
                      {f.name}
                      {f.required ? <span className="opt-tag">核心</span> : null}
                    </div>
                    <div className="opt-desc">{f.description}</div>
                  </div>
                </div>
              ))}
            </div>
            {devFeatures.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="field-label">实验功能</div>
                <div className="opt-group">
                  {devFeatures.map((f) => (
                    <div key={f.id} className="check-row check-row--rich" onClick={() => toggleFeature(f.id)}>
                      <div className={`checkbox ${features[f.id] ? 'checkbox--checked' : ''}`}>
                        {features[f.id] ? '✓' : ''}
                      </div>
                      <div className="check-row__text">
                        <div className="opt-title">{f.name}</div>
                        <div className="opt-desc">{f.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <div className="check-row" onClick={() => setLaunchAfterInstall(!launchAfterInstall)}>
                <div className={`checkbox ${launchAfterInstall ? 'checkbox--checked' : ''}`}>
                  {launchAfterInstall ? '✓' : ''}
                </div>
                <div className="check-row__text">安装完成后立即运行 SidekickAI</div>
              </div>
            </div>
          </div>
        )}

        {optionsTab === 'behavior' && (
          <div style={{ marginTop: 16 }}>
            <div className="field-label">应用行为</div>
            <div className="opt-group">
              {behaviorOptions.map((opt) => (
                <div key={opt.id} className="check-row check-row--rich" onClick={() => toggleOption(opt.id)}>
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

  // ---- 渲染：执行中 ----

  const renderInstalling = () => (
    <div className="progress-wrap">
      {errorMsg ? (
        <>
          <div style={{ fontSize: 40, marginBottom: 18 }}>!</div>
          <div className="progress__percent" style={{ color: 'var(--danger)' }}>
            {mode === 'uninstall' ? '卸载失败' : mode === 'repair' ? '修复失败' : '安装失败'}
          </div>
          <div className="error-box" style={{ maxWidth: 420, textAlign: 'left' }}>
            {errorMsg}
          </div>
          <div className="footer__actions" style={{ marginTop: 22 }}>
            <button className="btn" onClick={() => setStep(mode === 'install' ? 'options' : 'location')}>
              返回修改
            </button>
            <button className="btn btn--primary" onClick={startRun}>
              重试
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="progress-ring">
            <svg width="120" height="120" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="var(--surface-2)" strokeWidth="8" />
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke="var(--brand-500)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 52}
                strokeDashoffset={2 * Math.PI * 52 * (1 - progress / 100)}
                transform="rotate(-90 60 60)"
                style={{ transition: 'stroke-dashoffset 0.4s cubic-bezier(0.4,0,0.2,1)' }}
              />
            </svg>
          </div>
          <div className="progress__percent">{Math.round(progress)}%</div>
          <div className="progress__status">{statusText || '正在执行…'}</div>
          <div className="progress__bar">
            <div className="progress__bar-fill" style={{ width: `${progress}%` }} />
          </div>
        </>
      )}
    </div>
  )

  // ---- 渲染：完成页（含延后设置 + 残留提示）----

  const renderDone = () => {
    if (mode !== 'install') {
      return (
        <div className="done-wrap">
          <div className="done__icon">✓</div>
          <div className="done__title">{mode === 'repair' ? '修复完成' : '卸载完成'}</div>
          <div className="done__desc">
            {mode === 'repair'
              ? '核心文件已恢复，配置与用户数据保持不变。'
              : deleteUserData
                ? 'SidekickAI 及其用户数据已完全移除。'
                : 'SidekickAI 已卸载；用户数据已保留。'}
          </div>
          <div className="done__actions">
            <button className="btn btn--primary" onClick={() => window.installer.closeWindow()}>
              完成
            </button>
          </div>
        </div>
      )
    }
    const behaviorOptions = info?.options.filter((o) => o.page === 'behavior' || o.page === 'logging') ?? []
    return (
      <div className="done-wrap">
        <div className="done__icon">✓</div>
        <div className="done__title">安装完成</div>
        <div className="done__desc">
          SidekickAI 已成功安装到：
          <br />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{finalDir || installDir}</span>
        </div>
        {residualNote && (
          <div className="hint hint--warning" style={{ marginTop: 12, textAlign: 'left' }}>
            <span className="hint__icon">!</span>
            <span>{residualNote} 可重新运行安装器再次清理。</span>
          </div>
        )}
        {behaviorOptions.length > 0 && (
          <div className="done__settings">
            <div className="field-label" style={{ marginBottom: 4 }}>延后生效的应用设置</div>
            <div className="hint" style={{ marginBottom: 6 }}>
              <span className="hint__icon">✓</span>
              <span>以下设置已记录，应用下次启动时生效。</span>
            </div>
            <div className="opt-group">
              {behaviorOptions.map((opt) => (
                <div key={opt.id} className="opt-row" style={{ padding: '4px 0' }}>
                  <div className="opt-row__label">
                    <div className="opt-title">{opt.label}</div>
                  </div>
                  <div className="opt-desc" style={{ color: 'var(--text)' }}>
                    {opt.type === 'choice' ? String(options[opt.id] ?? opt.defaultValue) : options[opt.id] ? '已开启' : '已关闭'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="done__actions">
          <button className="btn" onClick={() => window.installer.openDir(finalDir || installDir)}>
            打开安装目录
          </button>
          <button className="btn btn--primary" onClick={() => window.installer.closeWindow()}>
            完成安装
          </button>
        </div>
      </div>
    )
  }

  // ---- 底部操作栏 ----
  const allLicensesAccepted = (info?.licenses ?? []).every((d) => acceptedLicenses.includes(d.id))

  const renderFooter = () => {
    if (step === 'installing') {
      return (
        <div className="content__footer">
          <div className="footer__spacer" />
          <div className="footer__actions">
            <button className="btn" onClick={handleClose}>
              取消
            </button>
          </div>
        </div>
      )
    }
    if (step === 'done') {
      return (
        <div className="content__footer">
          <div className="footer__spacer" />
          <div className="footer__actions">
            <button className="btn btn--primary" onClick={() => window.installer.closeWindow()}>
              完成
            </button>
          </div>
        </div>
      )
    }
    // 各步骤按钮
    let next: string | null = null
    let onNext: (() => void) | null = null
    let nextDisabled = false
    if (step === 'welcome') {
      onNext = () => setStep(mode === 'install' ? 'license' : 'location')
      next = mode === 'install' ? '下一步' : '继续'
    } else if (step === 'license') {
      onNext = () => setStep('location')
      nextDisabled = !allLicensesAccepted
      next = '下一步'
    } else if (step === 'location') {
      if (mode === 'install') {
        onNext = () => setStep('options')
        next = '下一步'
      } else {
        const hasTarget = (scan?.locations ?? []).some((l) => l.path === installDir)
        nextDisabled = !hasTarget
        onNext = () => startRun()
        next = mode === 'repair' ? '开始修复' : '开始卸载'
      }
    } else if (step === 'options') {
      onNext = () => startRun()
      next = '立即安装'
    }
    return (
      <div className="content__footer">
        <div className="footer__spacer" />
        <div className="footer__actions">
          {step !== 'welcome' && (
            <button
              className="btn"
              onClick={() => {
                if (step === 'location' && mode !== 'install') setStep('welcome')
                else if (step === 'location') setStep('license')
                else if (step === 'options') setStep('location')
                else setStep('welcome')
              }}
            >
              上一步
            </button>
          )}
          {step === 'welcome' && (
            <button className="btn btn--ghost" onClick={handleClose}>
              取消
            </button>
          )}
          {onNext && (
            <button className="btn btn--primary" disabled={nextDisabled} onClick={onNext}>
              {next}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 自建标题栏 */}
      <div className="titlebar">
        <div className="titlebar__left" data-tauri-drag-region>
          <div className="titlebar__logo">S</div>
          <div className="titlebar__title">SidekickAI 安装向导</div>
        </div>
        <div className="titlebar__actions">
          <button className="titlebar__btn titlebar__btn--close" onClick={handleClose} title="关闭">
            ✕
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="wizard">
        <div className="brand">
          <div className="brand__content">
            <div className="brand__logo">S</div>
            <div className="brand__name">SidekickAI</div>
            <div className="brand__slogan">AI 时代的个人操作台</div>
            {renderSteps()}
            {info && <div className="brand__version">v{info.version}</div>}
          </div>
        </div>

        <div className="content">
          <div className="content__body">
            {bootstrapError ? (
              <div className="error-box" style={{ margin: 'auto', maxWidth: 560, whiteSpace: 'pre-wrap' }}>
                {bootstrapError}
                {'\n\n'}
                请检查 %TEMP%\SidekickAI-install.log，并将错误信息反馈给开发者。
              </div>
            ) : (
              <>
                {step === 'welcome' && renderWelcome()}
                {step === 'license' && renderLicense()}
                {step === 'location' && renderLocation()}
                {step === 'options' && renderOptions()}
                {step === 'installing' && renderInstalling()}
                {step === 'done' && renderDone()}
              </>
            )}
          </div>
          {!bootstrapError && renderFooter()}
        </div>
      </div>

      {/* 关闭确认弹窗 */}
      {showCloseConfirm && (
        <div className="modal-mask" onClick={() => setShowCloseConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__title">
              {step === 'installing' ? '确定要取消操作吗？' : '确定要退出吗？'}
            </div>
            <div className="modal__desc">
              {step === 'installing'
                ? '当前操作尚未完成，取消后更改将不会应用。'
                : '你还没有完成操作，退出后将不会有任何更改。'}
            </div>
            <div className="modal__actions">
              <button className="btn" onClick={() => setShowCloseConfirm(false)}>
                继续
              </button>
              <button className="btn btn--primary" onClick={confirmClose}>
                确定退出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
