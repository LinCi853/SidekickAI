// installer/src/renderer/App.tsx
// SidekickAI 安装向导 — 三模式状态机
//   首页：正常安装（默认）/ 修复安装 / 卸载
//   install: 欢迎 → 协议 → 位置/残留确认 → 组件 → 应用设置 → 执行 → 完成
//   repair: 选择目标 → 修复确认 → 执行 → 完成
//   uninstall: 选择目标 → 数据策略 → 执行 → 完成

import { useState, useEffect, useCallback, useRef } from 'react'
import './styles.css'
import { WizardShell, CloseConfirmation, DataPolicyPicker, WizardDetails } from '../../installer-shared/presentation/Wizard'
import { finalizeWizard } from '../../installer-shared/presentation/finalize'
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
  const [forAllUsers, setForAllUsers] = useState(false)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [options, setOptions] = useState<Record<string, boolean | string>>({})
  const [launchAfterInstall, setLaunchAfterInstall] = useState(true)
  // 安装完成后是否打开使用指南（首次启动引导窗）；默认不勾选
  const [showGuideAfterInstall, setShowGuideAfterInstall] = useState(false)
  const [optionsTab, setOptionsTab] = useState<OptionsTab>('behavior')
  // 当前正在查看的协议（tab 激活项；默认打开首个协议）
  const [activeLicense, setActiveLicense] = useState<string | null>(null)

  const [dataStrategy, setDataStrategy] = useState<'keep' | 'export' | 'delete'>('keep')
  const [backupPath, setBackupPath] = useState('')
  const [backupPassword, setBackupPassword] = useState('')
  const [backupEncrypt, setBackupEncrypt] = useState(true)
  const backupCategories = ['basicData', 'cookies', 'indexedDB', 'cache', 'voiceAssets']

  // 许可协议
  const [acceptedLicenses, setAcceptedLicenses] = useState<string[]>([])

  // 安装进度
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [closeBanner, setCloseBanner] = useState('')
  const [installDone, setInstallDone] = useState(false)
  const [finalDir, setFinalDir] = useState('')
  const [residualNote, setResidualNote] = useState('')

  const installingRef = useRef(false)
  const finalizingRef = useRef(false)
  const [loadingConfig, setLoadingConfig] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all([window.installer.getInfo(), window.installer.scanInstallations()]).then(([data, installations]) => {
      if (!active) return
      const selected = data.initialTarget
        ? installations.locations.find(location => location.path.toLowerCase() === data.initialTarget.toLowerCase())
        : installations.locations[0]
      if (data.initialMode === 'uninstall' && !selected) throw new Error('原安装位置已不存在或不属于开源版，请保留文件并重新检查。')
      setInfo(data)
      setScan(installations)
      setInstallDir(data.initialTarget || selected?.path || data.perUserDefaultDir)
      setForAllUsers(selected?.forAllUsers ?? false)
      setMode(data.initialMode === 'uninstall' ? 'uninstall' : selected ? 'repair' : 'install')
      setFeatures(Object.fromEntries(data.features.map(feature => [feature.id, feature.defaultEnabled])))
      setOptions(Object.fromEntries(data.options.map(option => [option.id, option.defaultValue])))
    }).catch((error: unknown) => {
      if (active) setBootstrapError('安装器初始化失败：' + (error instanceof Error ? error.message : String(error)))
    })
    return () => { active = false }
  }, [])

  const selectScope = useCallback((allUsers: boolean) => {
    setForAllUsers(allUsers)
    if (info) setInstallDir(allUsers ? info.defaultDir : info.perUserDefaultDir)
  }, [info])

  // ---- 协议 tab 默认激活首个协议 ----
  useEffect(() => {
    if (!info) return
    const first = info.licenses[0]
    setActiveLicense((cur) => cur ?? first?.id ?? null)
  }, [info])

  // Configuration belongs to the selected installation, including custom targets.
  useEffect(() => {
    if (!info || !scan || !installDir) return
    let active = true
    setLoadingConfig(true)
    const installed = scan.locations.some(location => location.path.toLowerCase() === installDir.toLowerCase())
    const config = installed ? window.installer.readInstallConfig(installDir) : Promise.resolve(null)
    config
      .then((cfg) => {
        if (!active) return
        setFeatures(Object.fromEntries(info.features.map(feature => [feature.id, cfg?.modules?.[feature.id]?.enabled ?? feature.defaultEnabled])))
        setOptions(Object.fromEntries(info.options.map(option => [option.id, cfg?.options?.[option.id] ?? option.defaultValue])))
      })
      .catch((error: unknown) => {
        if (active) setBootstrapError('无法读取所选安装配置：' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => { if (active) setLoadingConfig(false) })
    return () => { active = false }
  }, [info, scan, installDir])

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
    try {
      await window.installer.start({
      installDir,
      forAllUsers,
      createDesktopShortcut: true,
      launchAfterInstall,
      showGuideAfterInstall,
      features,
      options,
      mode,
      cleanupPaths: [],
      dataStrategy,
      backupPath,
      backupPassword,
      backupEncrypt,
      backupCategories,
      acceptedLicenses
      })
    } catch (error) {
      installingRef.current = false
      setErrorMsg(error instanceof Error ? error.message : String(error))
      setStatusText('操作未完成')
    }
  }, [installDir, forAllUsers, features, options, launchAfterInstall, showGuideAfterInstall, mode, dataStrategy, backupPath, backupPassword, backupEncrypt, backupCategories, acceptedLicenses])

  // All close gestures persist the final choices before allowing native shutdown.
  const finalizeAndClose = useCallback(async () => {
    if (finalizingRef.current) return
    finalizingRef.current = true
    try {
      const saveRequired = installDone && mode !== 'uninstall' && Boolean(installDir)
      await finalizeWizard({
        save: saveRequired ? () => window.installer.flushConfig({
          installDir,
          forAllUsers,
          createDesktopShortcut: true,
          launchAfterInstall,
          showGuideAfterInstall,
          features,
          options,
          mode
        }) : undefined,
        prepareLaunch: saveRequired ? () => window.installer.setPendingLaunch(installDir, launchAfterInstall, showGuideAfterInstall) : undefined,
        close: () => window.installer.closeWindow(),
      })
    } catch (error) {
      await window.installer.setPendingLaunch(installDir, false, false).catch(() => {})
      setErrorMsg('设置未能保存或向导未能关闭：' + (error instanceof Error ? error.message : String(error)) + '。请重试完成。')
    } finally {
      finalizingRef.current = false
    }
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

  useEffect(() => window.installer.onCloseRequested(handleClose), [handleClose])

  const confirmClose = useCallback(async () => {
    try {
      if (step === 'installing' && installingRef.current) {
        if (!await window.installer.cancel()) throw new Error('取消请求未被接受，请等待当前操作完成')
        setStatusText('正在等待安全取消；提交中的操作会先完成或回滚。')
      } else {
        await window.installer.closeWindow()
      }
      setShowCloseConfirm(false)
    } catch (error) {
      setShowCloseConfirm(false)
      setCloseBanner('无法关闭向导：' + String(error))
    }
  }, [step])

  const browseDir = useCallback(async () => {
    const picked = await window.installer.browseDir(installDir)
    if (picked) setInstallDir(picked)
  }, [installDir])

  /** 选取卸载时备份的保存路径（加密 .sabackup / 明文 .zip） */
  const browseBackup = useCallback(async () => {
    const ext = backupEncrypt ? 'sabackup' : 'zip'
    const defaultName = `SidekickAI-用户数据-${new Date().toISOString().slice(0, 10)}.${ext}`
    const picked = await window.installer.saveBackupDialog(defaultName)
    if (picked) setBackupPath(picked)
  }, [backupEncrypt])

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

  // 逐个勾选/取消某个协议的同意
  const toggleLicense = useCallback((id: string) => {
    setAcceptedLicenses((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  const renderLocItem = (location: InstallLocation, selected: boolean) => (
    <div key={location.path} className="loc-item">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="loc-item__path">{location.path}</div>
        <div className="loc-item__meta">
          {location.version && <span>v{location.version}</span>}
          {location.registered && <span>已注册</span>}
          {location.runningPid > 0 && <span className="loc-running">运行中 (PID {location.runningPid})</span>}
          {selected && <span style={{ color: 'var(--brand-500)' }}>本次目标</span>}
        </div>
      </div>
    </div>
  )

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

  const renderLocation = () => {
    if (mode === 'install') {
      return (
        <>
          <h1 className="content__title">安装位置</h1>
          <p className="content__subtitle">确认安装位置与应用行为后再开始安装。</p>

          <div className="field-label" style={{ marginTop: 14 }}>安装模式</div>
          <div
            className={`card card--selectable ${forAllUsers ? 'card--selected' : ''}`}
            onClick={() => selectScope(true)}
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
            onClick={() => selectScope(false)}
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

          {renderComponents()}
          {renderOptions()}
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
            未检测到已安装的工百窗开源版。{mode === 'repair' ? '请先执行正常安装。' : ''}
          </div>
        ) : (
          <div className="loc-list">
            {locations.map((loc) => (
              <div
                key={loc.path}
                className={`card card--selectable ${installDir === loc.path ? 'card--selected' : ''}`}
                onClick={() => { setInstallDir(loc.path); setForAllUsers(loc.forAllUsers) }}
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
        {mode === 'repair' && <>{renderComponents()}{renderOptions()}</>}
        {mode === 'uninstall' && locations.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="field-label">用户数据（%APPDATA%\sidekickai-opensource）</div>
            <DataPolicyPicker value={dataStrategy} onChange={setDataStrategy}>
              <div className="export-fields export-panel">
                <p className="hint">完整备份当前开源版用户数据，包括本地资源。备份可读取且校验通过后才删除。</p>
                <div className="check-row" style={{ marginTop: 10 }} onClick={() => setBackupEncrypt(!backupEncrypt)}>
                  <div className={`checkbox ${backupEncrypt ? 'checkbox--checked' : ''}`}>
                    {backupEncrypt ? '✓' : ''}
                  </div>
                  <div className="check-row__text">
                    加密备份
                    <div className="opt-desc">AES-256-GCM；关闭则导出明文 zip</div>
                  </div>
                </div>

                <div className="field-label" style={{ marginTop: 10 }}>备份保存位置</div>
                <div className="path-row">
                  <input
                    className="input input--mono"
                    value={backupPath}
                    onChange={(e) => setBackupPath(e.target.value)}
                    placeholder={backupEncrypt ? '选择 .sabackup 保存路径' : '选择 .zip 保存路径'}
                    spellCheck={false}
                  />
                  <button className="btn" onClick={browseBackup}>
                    浏览
                  </button>
                </div>
                {backupEncrypt && (
                  <>
                    <div className="field-label" style={{ marginTop: 10 }}>备份密码</div>
                    <input
                      className="input"
                      type="password"
                      value={backupPassword}
                      onChange={(e) => setBackupPassword(e.target.value)}
                      placeholder="至少 6 位；丢失后无法解密"
                    />
                    <div className="hint" style={{ marginTop: 8 }}>
                      <span className="hint__icon">!</span>
                      <span>请务必牢记密码；密码丢失将无法解密还原数据。</span>
                    </div>
                  </>
                )}
              </div>
            </DataPolicyPicker>
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
      </div>
    )
  }

  // ---- 渲染：完成页（小标志 + 可调选项；配置在点击完成/关闭时写入）----

  const renderDone = () => {
    const isUninstall = mode === 'uninstall'
    const isRepair = mode === 'repair'
    return (
      <>
        {errorMsg && <div className="error-box" role="alert">{errorMsg}</div>}
        <div className="done-wrap">
          <div className="done__icon">✓</div>
          <div className="done__title">{isUninstall ? '卸载完成' : isRepair ? '修复完成' : '安装完成'}</div>
          <div className="done__desc">
            {isUninstall
              ? dataStrategy === 'export'
                ? `开源版已卸载；用户数据已导出至：${backupPath}`
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
              <span>{residualNote} 其他位置保持不变。</span>
            </div>
          )}
        </div>
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
    let nextDisabled = loadingConfig
    if (step === 'welcome') {
      onNext = () => setStep(mode === 'install' ? 'license' : 'location')
      next = mode === 'install' ? '下一步' : '继续'
    } else if (step === 'license') {
      onNext = () => setStep('location')
      nextDisabled = loadingConfig || !allLicensesAccepted
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
          (backupPath.trim() !== '' &&
            (!backupEncrypt || backupPassword.length >= 6) &&
            backupCategories.includes('basicData'))
        nextDisabled = loadingConfig || !hasTarget || !exportReady
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
    <WizardShell edition="open-source" kind={mode === 'uninstall' ? 'uninstall' : 'install'} version={info?.version} stages={steps} currentIndex={currentIndex}
      onClose={handleClose} className=""
      footer={!bootstrapError && info && scan && renderFooter()}
      overlay={showCloseConfirm && <CloseConfirmation busy={step === 'installing' && installingRef.current} onCancel={() => setShowCloseConfirm(false)} onConfirm={confirmClose} />}>

            {closeBanner && <div className="hint hint--warning" role="alert">{closeBanner}</div>}
            {bootstrapError ? (
              <div className="error-box" style={{ margin: 'auto', maxWidth: 560, whiteSpace: 'pre-wrap' }}>
                {bootstrapError}
                {'\n\n'}
                请保留当前错误信息，并重新运行开源版完整安装包。
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
      {!bootstrapError && ['location', 'installing', 'done'].includes(step) && <WizardDetails summary={[
        ['操作', mode === 'uninstall' ? '卸载' : mode === 'repair' ? '修复或更新' : '安装'],
        ['目标位置', installDir],
        ['版本', (scan?.locations.find(location => location.path === installDir)?.version || '未安装') + (mode === 'uninstall' ? '' : ' → ' + (info?.version || '读取中'))],
        ['安装范围', forAllUsers ? '所有用户' : '当前用户'],
        ['用户数据', mode !== 'uninstall' || dataStrategy === 'keep' ? '保留现有数据' : dataStrategy === 'export' ? '完整备份并验证后删除' : '删除当前开源版数据'],
        ['备份位置', mode === 'uninstall' && dataStrategy === 'export' ? backupPath : ''],
      ]} lines={[statusText, errorMsg].filter(Boolean)} />}
    </WizardShell>
  )
}
