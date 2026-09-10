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
  | 'location'
  | 'installing'
  | 'done'

/** 每个模式的步骤序列（步骤条展示用） */
const MODE_STEPS: Record<InstallMode, { id: StepId | 'repair' | 'uninstall'; label: string }[]> = {
  install: [
    { id: 'welcome', label: '欢迎' },
    { id: 'license', label: '许可协议' },
    { id: 'location', label: '安装位置' },
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

/** 选项分页：功能开关 / 应用行为 / 日志（独立安装组件仅在安装前选择） */
type OptionsTab = 'toggles' | 'behavior' | 'logging'

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
  // 安装完成后是否打开使用指南（首次启动引导窗）；默认不勾选
  const [showGuideAfterInstall, setShowGuideAfterInstall] = useState(false)
  const [optionsTab, setOptionsTab] = useState<OptionsTab>('behavior')
  // 当前正在查看的协议（tab 激活项；默认打开首个协议）
  const [activeLicense, setActiveLicense] = useState<string | null>(null)

  // 残留清理：用户勾选要清理的其他位置
  const [cleanupPaths, setCleanupPaths] = useState<string[]>([])
  // 卸载数据策略：keep（保留默认）/ export（导出加密备份后删除）/ delete（直接删除）
  const [dataStrategy, setDataStrategy] = useState<'keep' | 'export' | 'delete'>('keep')
  const [backupPath, setBackupPath] = useState('')
  const [backupPassword, setBackupPassword] = useState('')

  // 许可协议
  const [acceptedLicenses, setAcceptedLicenses] = useState<string[]>([])

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

  // ---- 协议 tab 默认激活首个协议 ----
  useEffect(() => {
    if (!info) return
    const first = info.licenses[0]
    setActiveLicense((cur) => cur ?? first?.id ?? null)
  }, [info])

  // ---- 已有安装 → 默认选择「修复安装」（仅扫描首次返回时联动一次，不覆盖用户手动选择）----
  const scanInitRef = useRef(false)
  useEffect(() => {
    if (!scan || scanInitRef.current) return
    scanInitRef.current = true
    if (scan.locations.length > 0) setMode('repair')
  }, [scan])

  // ---- 已安装位置预读 install-config.json 作选项初始值 ----
  const preloadDirRef = useRef<string | null>(null)
  useEffect(() => {
    if (!info || !scan || preloadDirRef.current !== null) return
    if (scan.locations.length === 0) return
    const dir = scan.recommendedDir
    preloadDirRef.current = dir
    window.installer
      .readInstallConfig(dir)
      .then((cfg) => {
        if (!cfg) return
        setFeatures((prev) => {
          const next = { ...prev }
          Object.keys(prev).forEach((id) => {
            const m = cfg.modules?.[id]
            if (m && typeof m.enabled === 'boolean') next[id] = m.enabled
          })
          return next
        })
        setOptions((prev) => {
          const next = { ...prev }
          Object.keys(prev).forEach((id) => {
            const v = cfg.options?.[id]
            if (v !== undefined && v !== null) next[id] = v as boolean | string
          })
          return next
        })
      })
      .catch(() => {/* 预读失败不阻塞 */})
  }, [info, scan])

  // ---- 安装模式：选择其他安装位置后自动勾选清理（可手动取消）----
  useEffect(() => {
    if (mode !== 'install') return
    const others = (scan?.locations ?? []).filter(
      (l) => l.path.toLowerCase() !== installDir.toLowerCase()
    )
    if (others.length === 0) return
    setCleanupPaths((prev) => {
      let changed = false
      const next = [...prev]
      for (const l of others) {
        if (!next.includes(l.path)) {
          next.push(l.path)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [scan, installDir, mode])

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
      showGuideAfterInstall,
      features,
      options,
      mode,
      cleanupPaths,
      dataStrategy,
      backupPath,
      backupPassword,
      acceptedLicenses
    })
  }, [installDir, forAllUsers, features, options, launchAfterInstall, showGuideAfterInstall, mode, cleanupPaths, dataStrategy, backupPath, backupPassword, acceptedLicenses])

  // ---- 完成/关闭向导：写入最终配置（install/repair）后再关窗 ----
  const finalizeAndClose = useCallback(async () => {
    if (installDone && (mode === 'install' || mode === 'repair') && installDir) {
      try {
        await window.installer.flushConfig({
          installDir,
          forAllUsers,
          createDesktopShortcut: true,
          launchAfterInstall,
          showGuideAfterInstall,
          features,
          options,
          mode
        })
      } catch {
        // 静默失败：主程序首次启动时将回退到默认配置
      }
    }
    window.installer.closeWindow()
  }, [installDone, mode, installDir, forAllUsers, launchAfterInstall, showGuideAfterInstall, features, options])

  // ---- 关闭窗口（二次确认；完成页直接写配置并关闭）----
  const handleClose = useCallback(() => {
    if (step === 'installing') {
      setShowCloseConfirm(true)
      return
    }
    if (step === 'done') {
      finalizeAndClose()
      return
    }
    setShowCloseConfirm(true)
  }, [step, finalizeAndClose])

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

  /** 选取卸载时加密备份的保存路径（.sabackup） */
  const browseBackup = useCallback(async () => {
    const defaultName = `SidekickAI-用户数据-${new Date().toISOString().slice(0, 10)}.sabackup`
    const picked = await window.installer.saveBackupDialog(defaultName)
    if (picked) setBackupPath(picked)
  }, [])

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

  // 逐个勾选/取消某个协议的同意
  const toggleLicense = useCallback((id: string) => {
    setAcceptedLicenses((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
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

  // ---- 扫描完成后：本机无安装 → 修复/卸载不可用，强制回到正常安装 ----
  useEffect(() => {
    if (scan && scan.locations.length === 0 && mode !== 'install') {
      setMode('install')
    }
  }, [scan, mode])

  // ---- 渲染：首页（模式选择）----
  const renderWelcome = () => {
    const hasInstall = (scan?.locations.length ?? 0) > 0
    // 扫描完成且本机无安装时隐藏修复/卸载入口；扫描中先按可全部选择渲染
    const showRepairUninstall = !scan || hasInstall
    return (
      <>
        <h1 className="content__title">欢迎使用 SidekickAI</h1>
        <p className="content__subtitle">
          AI 时代的个人操作台。请选择要执行的操作。
        </p>
        {scan && hasInstall && (
          <div className="hint hint--warning" style={{ marginTop: 14 }}>
            <span className="hint__icon">!</span>
            <span>{scan.residualHint}</span>
          </div>
        )}
        {scan && hasInstall && (
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
              {hasInstall ? '覆盖已检测到的安装位置' : '全新安装 SidekickAI（约 1 分钟）'}
            </div>
          </div>
          {showRepairUninstall && (
            <div
              className={`mode-card ${mode === 'repair' ? 'mode-card--selected' : ''}`}
              onClick={() => setMode('repair')}
            >
              <div className="mode-card__icon">◈</div>
              <div className="mode-card__title">修复安装</div>
              <div className="mode-card__desc">校验并替换损坏的核心文件，保留配置与数据</div>
            </div>
          )}
          {showRepairUninstall && (
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
            <span>版本 {info.version}</span>
            <span>架构 {info.arch === 'arm64' ? 'ARM64' : 'x64'}</span>
            <span>所需空间 {info.requiredSpace}</span>
          </div>
        )}
      </>
    )
  }

  // ---- 渲染：协议页（标签栏式切换，固定高度正文）----

  const renderLicense = () => {
    const docs = info?.licenses ?? []
    const active = docs.find((d) => d.id === activeLicense) ?? docs[0]
    return (
      <>
        <h1 className="content__title">许可协议</h1>
        <p className="content__subtitle">请逐个阅读并勾选同意以下协议。</p>
        <div className="tabs" style={{ marginTop: 16 }}>
          {docs.map((d) => (
            <div
              key={d.id}
              className={`tab ${active?.id === d.id ? 'tab--active' : ''}`}
              onClick={() => setActiveLicense(d.id)}
            >
              {d.title}
            </div>
          ))}
        </div>
        <div className="license-body" style={{ marginTop: 14 }}>
          {active?.body ?? ''}
        </div>
        {active && (
          <div
            className="check-row license-accept"
            onClick={() => toggleLicense(active.id)}
          >
            <div className={`checkbox ${acceptedLicenses.includes(active.id) ? 'checkbox--checked' : ''}`}>
              {acceptedLicenses.includes(active.id) ? '✓' : ''}
            </div>
            <div className="check-row__text">我已阅读并同意《{active.title}》</div>
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
          <p className="content__subtitle">确认安装位置；可勾选清理其他安装位置。</p>

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
                <div className="card__desc">安装到系统 Program Files 目录</div>
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
                <div className="card__desc">安装到当前用户的本地应用目录</div>
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
          {renderComponents()}
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
        {mode === 'repair' && renderComponents()}
        {mode === 'uninstall' && locations.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="field-label">用户数据（%APPDATA%\sidekick-ai）</div>
            <div
              className={`card card--selectable ${dataStrategy === 'keep' ? 'card--selected' : ''}`}
              onClick={() => setDataStrategy('keep')}
            >
              <div className="card__header">
                <div className="radio">
                  <div className="radio__dot" />
                </div>
                <div>
                  <div className="card__title">保留用户数据</div>
                  <div className="card__desc">
                    配置、Profile、会话登录态、书签等全部留在磁盘上，之后可重新安装找回
                  </div>
                </div>
              </div>
            </div>
            <div
              className={`card card--selectable ${dataStrategy === 'export' ? 'card--selected' : ''}`}
              onClick={() => setDataStrategy('export')}
            >
              <div className="card__header">
                <div className="radio">
                  <div className="radio__dot" />
                </div>
                <div>
                  <div className="card__title">导出加密备份后删除</div>
                  <div className="card__desc">打包全部用户数据并加密为 .sabackup 文件，再删除本机数据</div>
                </div>
              </div>
            </div>
            {dataStrategy === 'export' && (
              <div className="export-fields">
                <div className="field-label">备份保存位置</div>
                <div className="path-row">
                  <input
                    className="input input--mono"
                    value={backupPath}
                    onChange={(e) => setBackupPath(e.target.value)}
                    placeholder="选择 .sabackup 保存路径"
                    spellCheck={false}
                  />
                  <button className="btn" onClick={browseBackup}>
                    浏览
                  </button>
                </div>
                <div className="field-label" style={{ marginTop: 10 }}>备份密码</div>
                <input
                  className="input"
                  type="password"
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                  placeholder="加密备份用，之后可通过「导入备份」恢复"
                />
                <div className="hint" style={{ marginTop: 8 }}>
                  <span className="hint__icon">!</span>
                  <span>请务必牢记密码；密码丢失将无法解密还原数据。</span>
                </div>
              </div>
            )}
            <div
              className={`card card--selectable ${dataStrategy === 'delete' ? 'card--selected' : ''}`}
              onClick={() => setDataStrategy('delete')}
            >
              <div className="card__header">
                <div className="radio">
                  <div className="radio__dot" />
                </div>
                <div>
                  <div className="card__title">直接删除不保留</div>
                  <div className="card__desc">连同配置、Profile、缓存和日志一并删除，不可恢复</div>
                </div>
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

  // ---- 渲染：独立安装组件（需要独立安装才能使用的功能，安装前选定）----
  const renderComponents = (embedded = false) => {
    const requiredFeatures = info?.features.filter((f) => f.installRequired) ?? []
    if (requiredFeatures.length === 0) return null
    return (
      <div style={{ marginTop: embedded ? 0 : 18 }}>
        <div className="field-label">独立安装组件</div>
        <div className="opt-group">
          {requiredFeatures.map((f) => (
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
      </div>
    )
  }

  const renderOptions = (embedded = false) => {
    const behaviorOptions = info?.options.filter((o) => o.page === 'behavior') ?? []
    const loggingOptions = info?.options.filter((o) => o.page === 'logging') ?? []
    const toggleFeatures = info?.features.filter((f) => !f.installRequired) ?? []
    const tabs: { id: OptionsTab; label: string }[] = [
      { id: 'toggles', label: '功能开关' },
      { id: 'behavior', label: '应用行为' },
      { id: 'logging', label: '日志' }
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
        <div className="tabs" style={{ marginTop: embedded ? 10 : undefined }}>
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

        {optionsTab === 'toggles' && (
          <div style={{ marginTop: 16 }}>
            <div className="field-label">功能开关</div>
            <div className="opt-group">
              {toggleFeatures.map((f) => (
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
              {toggleFeatures.length === 0 && <div className="opt-desc">无功能开关</div>}
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

  // ---- 渲染：执行中（小型状态标志；安装/修复时下方随时可调选项）----

  const renderInstalling = () => {
    if (errorMsg) {
      return (
        <div style={{ width: '100%' }}>
          <div className="state-head">
            <div className="state-dot state-dot--error">!</div>
            <div className="state-text state-text--error">
              {mode === 'uninstall' ? '卸载失败' : mode === 'repair' ? '修复失败' : '安装失败'}
            </div>
          </div>
          <div className="error-box" style={{ maxWidth: 420, textAlign: 'left', marginTop: 10 }}>
            {errorMsg}
          </div>
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
        {mode !== 'uninstall' && (
          <div style={{ marginTop: 22 }}>{renderOptions(true)}</div>
        )}
      </div>
    )
  }

  // ---- 渲染：完成页（小标志 + 可调选项；配置在点击完成/关闭时写入）----

  const renderDone = () => {
    const isUninstall = mode === 'uninstall'
    const isRepair = mode === 'repair'
    return (
      <>
        <div className="done-wrap">
          <div className="done__icon">✓</div>
          <div className="done__title">{isUninstall ? '卸载完成' : isRepair ? '修复完成' : '安装完成'}</div>
          <div className="done__desc">
            {isUninstall
              ? dataStrategy === 'export'
                ? `SidekickAI 已卸载；用户数据已加密导出至：${backupPath}`
                : dataStrategy === 'delete'
                  ? 'SidekickAI 及其用户数据已完全移除。'
                  : 'SidekickAI 已卸载；用户数据已保留。'
              : isRepair
                ? `已修复：${finalDir || installDir}`
                : `SidekickAI 已成功安装到：${finalDir || installDir}`}
          </div>
          {!isUninstall && residualNote && (
            <div className="hint hint--warning" style={{ marginTop: 10, textAlign: 'left' }}>
              <span className="hint__icon">!</span>
              <span>{residualNote} 可重新运行安装器再次清理。</span>
            </div>
          )}
        </div>
        {!isUninstall && (
          <div style={{ marginTop: 18 }}>
            {renderOptions(true)}
            <div className="hint" style={{ marginTop: 10 }}>
              <span className="hint__icon">✓</span>
              <span>选项将在点击「完成」或关闭窗口后写入并生效。</span>
            </div>
          </div>
        )}
      </>
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
            <button className="btn btn--primary" onClick={finalizeAndClose}>
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
        onNext = () => startRun()
        next = '立即安装'
      } else {
        const hasTarget = (scan?.locations ?? []).some((l) => l.path === installDir)
        const exportReady =
          mode !== 'uninstall' ||
          dataStrategy !== 'export' ||
          (backupPath.trim() !== '' && backupPassword !== '')
        nextDisabled = !hasTarget || !exportReady
        onNext = () => startRun()
        next = mode === 'repair' ? '开始修复' : '开始卸载'
      }
    }
    return (
      <div className="content__footer">
        {step === 'license' && info && info.licenses.length > 0 && (
          <button
            className="btn"
            onClick={() => setAcceptedLicenses(info.licenses.map((d) => d.id))}
          >
            一键同意所有协议
          </button>
        )}
        <div className="footer__spacer" />
        <div className="footer__actions">
          {step !== 'welcome' && (
            <button
              className="btn"
              onClick={() => {
                if (step === 'location' && mode !== 'install') setStep('welcome')
                else if (step === 'location') setStep('license')
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
