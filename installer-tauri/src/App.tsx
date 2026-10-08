import { edition } from '../../packages/product-contract/identity'
// Installation and repair share the maintenance wizard. Uninstallation delegates
// to the same page used by the standalone uninstaller.

import { useState, useEffect, useCallback, useRef } from 'react'
import './styles.css'
import UninstallPage from '../../installer-shared/uninstall/UninstallPage'
import { uninstallApi } from '../../installer-shared/uninstall/api'
import { afterCancelRequest, afterCloseWindow } from './close-flow'
import { hostContext, prepareCloudAssets } from './cloud'
import type { CloudAssetWire, DistributionPrepared, InstallationResourceStatus, InstallationRecovery, InstallerInfo, InstallMode, ScanResult } from './global'
import { MODE_STEPS, type OptionsTab, type StepId } from './types'
import { WizardShell, CloseConfirmation } from '../../installer-shared/presentation/Wizard'
import { completionLaunch, finalizeWizard, type CompletionIntent } from '../../installer-shared/presentation/finalize'
import { completionErrorText } from './completion-error'
import StepWelcome from './steps/StepWelcome'
import StepLicense from './steps/StepLicense'
import StepLocation from './steps/StepLocation'
import StepInstalling from './steps/StepInstalling'
import StepDone from './steps/StepDone'
import OperationDetails from '../../installer-shared/operation-details/OperationDetails'
import { directoryForScope, operationName, visibleLogLines } from './operation-presentation'


export default function App() {
  const [mode, setMode] = useState<InstallMode>('install')
  const [step, setStep] = useState<StepId>('welcome')
  const [info, setInfo] = useState<InstallerInfo | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [bootstrapError, setBootstrapError] = useState('')
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  // Explicit "cannot cancel / cannot close yet" banner; never shown as a fake
  // cancelled or completed state while the backend is still busy.
  const [closeBanner, setCloseBanner] = useState('')

  // 安装选项
  const [installDir, setInstallDir] = useState('')
  const [stagingDir, setStagingDir] = useState('')
  const [recoveries, setRecoveries] = useState<InstallationRecovery[]>([])
  const pendingRecovery = recoveries.find(item => item.installDir.replace(/\\/g, '/').toLowerCase() === installDir.replace(/\\/g, '/').toLowerCase())
  const [forAllUsers, setForAllUsers] = useState(false)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [options, setOptions] = useState<Record<string, boolean | string>>({})
  const [completionIntent, setCompletionIntent] = useState<CompletionIntent>('close')
  // 安装完成后是否打开使用指南（首次启动引导窗）；默认不勾选
  const [showGuideAfterInstall, setShowGuideAfterInstall] = useState(false)
  const [cloudNotice, setCloudNotice] = useState('')
  const [cloudAssets, setCloudAssets] = useState<CloudAssetWire[]>([])
  const [optionsTab, setOptionsTab] = useState<OptionsTab>('behavior')
  // 当前正在查看的协议（tab 激活项；默认打开首个协议）
  const [activeLicense, setActiveLicense] = useState<string | null>(null)

  // 残留清理：用户勾选要清理的其他位置
  const [cleanupPaths, setCleanupPaths] = useState<string[]>([])

  // 许可协议
  const [acceptedLicenses, setAcceptedLicenses] = useState<string[]>([])

  // 安装进度
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [installDone, setInstallDone] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [finalDir, setFinalDir] = useState('')
  const [residualNote, setResidualNote] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [logPath, setLogPath] = useState('')
  const [logError, setLogError] = useState('')
  const [preparationLines, setPreparationLines] = useState<string[]>([])
  const selectedLocation = scan?.locations.find(location => location.path.replace(/\\/g, '/').toLowerCase() === installDir.replace(/\\/g, '/').toLowerCase())
  const actionName = operationName(mode, selectedLocation?.version, info?.version)
  const operationSummary: Array<[string, string]> = [
    ['操作', actionName], ['目标位置', installDir],
    ['安装暂存', stagingDir || '系统临时目录'],
    ['版本', `${selectedLocation?.version || '未安装'} → ${info?.version || '读取中'}`],
    ['架构', info?.arch === 'arm64' ? 'ARM64' : 'x64'],
    ['程序文件', '校验并更新主程序、完整运行库和卸载组件'],
    ['设置与资源', mode === 'repair' ? '保留现有设置、安装配置和已下载资源'
      : edition.cloudResources ? '应用本次所选设置，并尝试获取默认资源' : '应用本次所选设置，内置工具与默认内容随本体提供'],
    ['用户数据', '保留现有业务数据和恢复副本'],
  ]

  const installingRef = useRef(false)
  const preparationRef = useRef(false)
  const distributionPreparingRef = useRef(false)
  const recoveringCommittedRef = useRef(false)
  const finalizingRef = useRef(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  // A cancel was accepted and the window must close as soon as the backend
  // emits its terminal event, not immediately.
  const cancelPendingRef = useRef(false)

  useEffect(() => {
    let active = true
    Promise.all([window.installer.getInfo(), window.installer.scanInstallations(), window.installer.pendingInstallations()]).then(([data, installations, pending]) => {
      if (!active) return
      const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
      const selected = installations.locations.find(location => normalize(location.path) === normalize(installations.recommendedDir)) || installations.locations[0]
      setInfo(data)
      setScan(installations)
      setRecoveries(pending)
      setInstallDir(pending[0]?.installDir || selected?.path || data.perUserDefaultDir)
      setForAllUsers(pending[0]?.forAllUsers ?? selected?.forAllUsers ?? false)
      setCleanupPaths(pending[0]?.cleanupPaths ?? [])
      setMode(data.uninstallEntry ? 'uninstall' : pending.length ? 'install' : selected ? 'repair' : 'install')
      if (pending.length && !data.uninstallEntry) setStep('location')
    }).catch((error: unknown) => {
      if (active) setBootstrapError('安装器初始化失败：' + String(error))
    })
    return () => { active = false }
  }, [])

  const selectScope = useCallback((allUsers: boolean) => {
    setForAllUsers(allUsers)
    if (info && !selectedLocation) setInstallDir(current => directoryForScope(
      current, forAllUsers ? info.defaultDir : info.perUserDefaultDir,
      allUsers ? info.defaultDir : info.perUserDefaultDir,
    ))
  }, [info, forAllUsers, selectedLocation])
  // ---- 协议 tab 默认激活首个协议 ----
  useEffect(() => {
    if (!info) return
    const first = info.licenses[0]
    setActiveLicense((cur) => cur ?? first?.id ?? null)
  }, [info])

  useEffect(() => {
    if (!info || !scan || !installDir) return
    let active = true
    setLoadingConfig(true)
    const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
    const installed = scan.locations.find(location => normalize(location.path) === normalize(installDir))
    if (!pendingRecovery && installed?.forAllUsers !== undefined) setForAllUsers(installed.forAllUsers)
    const config = installed && !pendingRecovery ? window.installer.readInstallConfig(installDir) : Promise.resolve(null)
    config.then(cfg => {
      if (!active) return
      setFeatures(Object.fromEntries(info.features.map(feature => [feature.id, cfg?.modules?.[feature.id]?.enabled ?? (feature.defaultEnabled && (!feature.installRequired || Boolean(feature.required)))])))
      setOptions(Object.fromEntries(info.options.map(option => [option.id, cfg?.options?.[option.id] ?? option.defaultValue])))
    }).catch((error: unknown) => {
      if (active) setBootstrapError('无法读取所选安装配置：' + String(error))
    }).finally(() => { if (active) setLoadingConfig(false) })
    return () => { active = false }
  }, [info?.features, info?.options, scan, installDir, pendingRecovery])
  // ---- 订阅安装事件 ----
  useEffect(() => {
    const offDistribution = window.installer.onDistributionProgress(payload => {
      setStatusText(payload.message)
      setProgress(payload.totalBytes > 0 ? Math.min(85, payload.downloadedBytes / payload.totalBytes * 85) : 0)
    })
    const offStatus = window.installer.onStatus(msg => setStatusText(mode === 'repair' ? msg.split('修复').join(actionName) : msg))
    const offLog = window.installer.onLog(payload => {
      setLogLines(visibleLogLines(payload.text).map(line => mode === 'repair' ? line.split('修复').join(actionName) : line))
      setLogPath(payload.path || '')
      setLogError(payload.error || '')
    })
    const offProgress = window.installer.onProgress((p) => setProgress(p))
    const offDone = window.installer.onDone((payload) => {
      setProgress(100)
      setStatusText(`${actionName}完成`)
      setFinalDir(payload.installDir)
      setResidualNote(payload.residualNote || '')
      setInstallDone(true)
      installingRef.current = false
      cancelPendingRef.current = false
      setCloseBanner('')
      setStep('done')
    })
    const offError = window.installer.onError((msg) => {
      setErrorMsg(msg)
      installingRef.current = false
      setStatusText('操作失败')
      // A cancelled operation still emits `install-error`; close once that
      // terminal event arrives instead of closing the protected window early.
      if (cancelPendingRef.current) {
        cancelPendingRef.current = false
        void window.installer.closeWindow().then((closed) => {
          const outcome = afterCloseWindow(closed)
          if (outcome.kind === 'stay') setCloseBanner(outcome.banner)
        })
      }
    })
    return () => {
      offDistribution()
      offStatus()
      offLog()
      offProgress()
      offDone()
      offError()
    }
  }, [mode, actionName])

  // 步骤条当前索引
  const steps = mode === 'uninstall' ? [] : MODE_STEPS[mode].map(item => item.id === 'installing' ? { ...item, label: `${actionName}中` } : item)
  const currentStepObj = steps.find((s) => s.id === step)
  const currentIndex = currentStepObj ? steps.indexOf(currentStepObj) : 0

  // ---- 开始执行（按模式）----
  const startRun = useCallback(async () => {
    if (installingRef.current) return
    installingRef.current = true
    preparationRef.current = true
    cancelPendingRef.current = false
    setCloseBanner('')
    setProgress(4)
    setErrorMsg('')
    setLogLines([])
    setLogPath('')
    setLogError('')
    setPreparationLines([`开始${actionName}：${selectedLocation?.version || '未安装'} → ${info?.version || ''}`])
    setStatusText(`正在准备${actionName}…`)
    setStep('installing')
    let preparationHeld = false
    const stopForCancellation = () => {
      if (!cancelPendingRef.current) return false
      installingRef.current = false
      setStatusText('已取消')
      return true
    }
    try {
      if (!await window.installer.beginPreparation()) {
        installingRef.current = false
        setStatusText('正在等待当前维护向导…')
        return
      }
      preparationHeld = true
      if (stopForCancellation()) return
      // Resource acquisition follows the edition's installation contract.
      let preparedAssets: CloudAssetWire[] = []
      let resources: InstallationResourceStatus[] = []
      const currentRecoveries = await window.installer.pendingInstallations()
      if (stopForCancellation()) return
      setRecoveries(currentRecoveries)
      const recovery = currentRecoveries.find(item => item.installDir.replace(/\\/g, '/').toLowerCase() === installDir.replace(/\\/g, '/').toLowerCase())
      recoveringCommittedRef.current = recovery?.state === 'committed'
      let distribution: DistributionPrepared | null = null
      if (!recovery) {
        distributionPreparingRef.current = true
        distribution = await window.installer.prepareDistribution()
        distributionPreparingRef.current = false
        if (stopForCancellation()) return
        setInfo(current => current ? { ...current, version: distribution!.productVersion, arch: distribution!.nativeArchitecture } : current)
      }
      if (!recovery && mode === 'install' && edition.cloudResources) {
        setStatusText('正在检查云端资源…')
        setPreparationLines(lines => [...lines, '正在检查云端默认资源'])
        const prepared = await prepareCloudAssets({
          host: hostContext(distribution?.nativeArchitecture ?? info?.arch ?? 'x64', distribution?.productVersion ?? info?.version ?? ''),
          selectedComponents: Object.entries(features)
            .filter(([, enabled]) => enabled)
            .map(([id]) => id),
        })
        preparedAssets = prepared.assets
        resources = prepared.resources
        setCloudNotice(prepared.notice)
        setPreparationLines(lines => [...lines, prepared.notice])
        setCloudAssets(preparedAssets)
        setStatusText(`正在准备${actionName}…`)
      }
      if (stopForCancellation()) return
      preparationRef.current = false
      await window.installer.start({
        installDir,
        stagingDir,
        forAllUsers: recovery?.forAllUsers ?? forAllUsers,
        createDesktopShortcut: true,
        launchAfterInstall: false,
        showGuideAfterInstall,
        features,
        options,
        mode,
        cleanupPaths: recovery?.cleanupPaths ?? cleanupPaths,
        acceptedLicenses,
        resources,
        cloudAssets: preparedAssets,
        ...(distribution ? { distributionSourcePath: distribution.sourcePath, distributionBodyProof: distribution.bodyProof,
          distributionProductVersion: distribution.productVersion, distributionReleaseId: distribution.releaseId ?? '',
          distributionReleaseSha256: distribution.releaseSha256 ?? '', distributionReleaseProof: distribution.releaseProof } : {}),
      })
    } catch (error) {
      // An early rejection (for example another operation is running) has no
      // terminal event, so surface it and leave the busy state here.
      const detail = error instanceof Error ? error.message : String(error)
      setErrorMsg(detail)
      setStatusText('操作失败')
      installingRef.current = false
    } finally {
      preparationRef.current = false
      distributionPreparingRef.current = false
      if (preparationHeld) await window.installer.endPreparation().catch(() => {})
      await window.installer.pendingInstallations().then(setRecoveries).catch(() => {})
      if (cancelPendingRef.current && !installingRef.current) {
        cancelPendingRef.current = false
        const result = afterCloseWindow(await window.installer.closeWindow())
        if (result.kind === 'stay') setCloseBanner(result.banner)
      }
    }
  }, [installDir, stagingDir, forAllUsers, features, options, showGuideAfterInstall, mode, cleanupPaths, acceptedLicenses, info, actionName, selectedLocation?.version])

  const finalizeAndClose = useCallback(async (intent: CompletionIntent) => {
    if (finalizingRef.current) return
    finalizingRef.current = true
    setCompletionIntent(intent)
    setFinalizing(true)
    setStatusText(intent === 'open' ? '正在核对启动条件…' : '正在关闭向导…')
    setCloseBanner('')
    try {
      const completedDir = finalDir || installDir
      const requestedLaunch = completionLaunch(intent)
      const saveRequired = installDone && mode === 'install' && !recoveringCommittedRef.current && Boolean(completedDir)
      await finalizeWizard({
        begin: () => window.installer.beginCompletion(),
        release: () => window.installer.endCompletion(),
        save: saveRequired ? () => window.installer.flushConfig({
          installDir: completedDir, forAllUsers, createDesktopShortcut: true, launchAfterInstall: requestedLaunch, showGuideAfterInstall, features, options, mode
        }) : undefined,
        prepareLaunch: installDone && mode !== 'uninstall' && Boolean(completedDir)
          ? () => window.installer.setPendingLaunch(completedDir, requestedLaunch, showGuideAfterInstall) : undefined,
        close: () => window.installer.closeWindow(),
      })
    } catch (error) {
      console.warn('Application completion is pending', error)
      await window.installer.setPendingLaunch(installDir, false, false).catch(() => {})
      setCloseBanner(completionErrorText(error))
    } finally { finalizingRef.current = false; setFinalizing(false) }
  }, [installDone, mode, installDir, finalDir, forAllUsers, showGuideAfterInstall, features, options])
  // ---- 关闭窗口（二次确认；完成页直接写配置并关闭）----
  const handleClose = useCallback(() => {
    if (step === 'installing') {
      setShowCloseConfirm(true)
      return
    }
    if (step === 'done') {
      finalizeAndClose('close')
      return
    }
    setShowCloseConfirm(true)
  }, [step, finalizeAndClose])

  useEffect(() => {
    if (mode !== 'uninstall') return window.installer.onCloseRequested(handleClose)
  }, [mode, handleClose])

  const confirmClose = useCallback(async () => {
    setShowCloseConfirm(false)
    if (step === 'installing' && installingRef.current) {
      // Mark the pending close before awaiting the backend so a terminal event
      // that races the response still closes the window.
      cancelPendingRef.current = true
      const preparing = preparationRef.current
      let accepted: boolean
      try {
        if (preparing) {
          if (distributionPreparingRef.current) await window.installer.cancelDistribution()
          accepted = true
        } else accepted = await window.installer.cancel()
      } catch (error) {
        if (!preparing) cancelPendingRef.current = false
        setCloseBanner(`取消请求未送达：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (!cancelPendingRef.current) {
        // A terminal event already arrived while cancel() was in flight; its
        // handler owns the close decision.
        return
      }
      const outcome = afterCancelRequest(accepted)
      if (outcome.kind === 'wait-for-terminal') {
        setStatusText('正在取消…')
        return
      }
      // Cancellation lost the race: the engine is running. Stay on the busy
      // step and explain, never report a cancellation that did not happen.
      cancelPendingRef.current = false
      if (outcome.kind === 'stay') setCloseBanner(outcome.banner)
      return
    }
    const outcome = afterCloseWindow(await window.installer.closeWindow())
    if (outcome.kind === 'stay') setCloseBanner(outcome.banner)
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

  // 逐个勾选/取消某个协议的同意
  const toggleLicense = useCallback((id: string) => {
    setAcceptedLicenses((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  // ---- 扫描完成后：普通安装器的修复入口无目标时回到安装；卸载流程自行显示无目标 ----
  useEffect(() => {
    if (scan && scan.locations.length === 0 && mode === 'repair') {
      setMode('install')
    }
  }, [scan, mode])

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
            <button className="btn" disabled={finalizing} onClick={() => finalizeAndClose('close')}>关闭向导</button>
            <button className="btn btn--primary" disabled={finalizing} onClick={() => finalizeAndClose('open')}>
              {finalizing ? (completionIntent === 'open' ? '正在打开程序…' : '正在关闭向导…') : '打开本次安装的程序'}
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
        next = `开始${actionName}`
      } else {
        const hasTarget = (scan?.locations ?? []).some((l) => l.path === installDir)
        nextDisabled = loadingConfig || !hasTarget
        onNext = () => startRun()
        next = `开始${actionName}`
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
              {step === 'location' && pendingRecovery ? pendingRecovery.state === 'committed' ? '继续清理恢复副本' : '恢复中断的安装' : next}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (mode === 'uninstall') {
    return <UninstallPage api={uninstallApi} entry="installer" />
  }

  return (
    <WizardShell  kind="install" version={info?.version} pendingVersionLabel={info?.distributionMode === 'online' ? '在线安装' : '离线安装'} stages={steps} currentIndex={currentIndex}
      onClose={handleClose} className=""
      footer={!bootstrapError && renderFooter()}
      overlay={showCloseConfirm && <CloseConfirmation busy={step === 'installing' && installingRef.current} onCancel={() => setShowCloseConfirm(false)} onConfirm={confirmClose} />}>

            {bootstrapError ? (
              <div className="error-box" style={{ margin: 'auto', maxWidth: 560, whiteSpace: 'pre-wrap' }}>
                {bootstrapError}
                {'\n\n'}
                尚未开始文件操作。请保留此错误信息；操作日志保存在本地 SidekickAI 的 installer-logs 目录。
              </div>
            ) : (
              <>
                {pendingRecovery && <div className="hint hint--warning" role="status">
                  {pendingRecovery.state === 'committed' ? '安装已完成，恢复副本尚未清理。可继续清理，无需重新安装。' : '检测到此位置有中断的安装。将先恢复原版本与入口；冲突文件单独保留，之后可重试安装。'}
                </div>}
                {step === 'welcome' && (
                  <StepWelcome
                    actionName={operationName('repair', selectedLocation?.version, info?.version)}
                    mode={mode}
                    setMode={setMode}
                    scan={scan}
                    info={info}
                  />
                )}
                {step === 'license' && (
                  <StepLicense
                    info={info}
                    activeLicense={activeLicense}
                    setActiveLicense={setActiveLicense}
                    acceptedLicenses={acceptedLicenses}
                    toggleLicense={toggleLicense}
                  />
                )}
                {step === 'location' && (
                  <StepLocation
                    stagingDir={stagingDir}
                    setStagingDir={setStagingDir}
                    browseStagingDir={async () => { const selected = await window.installer.browseDir(stagingDir); if (selected) setStagingDir(selected) }}
                    actionName={actionName}
                    mode={mode}
                    info={info}
                    scan={scan}
                    installDir={installDir}
                    setInstallDir={setInstallDir}
                    forAllUsers={forAllUsers}
                    setForAllUsers={selectScope}
                    browseDir={browseDir}
                    cleanupPaths={cleanupPaths}
                    toggleCleanup={toggleCleanup}
                    features={features}
                    toggleFeature={toggleFeature}
                    cloudNotice={cloudNotice}
                    cloudAssets={cloudAssets}
                    optionsTab={optionsTab}
                    setOptionsTab={setOptionsTab}
                    showGuideAfterInstall={showGuideAfterInstall}
                    setShowGuideAfterInstall={setShowGuideAfterInstall}
                    options={options}
                    toggleOption={toggleOption}
                    setChoiceOption={setChoiceOption}
                  />
                )}
                {step === 'installing' && (
                  <StepInstalling
                    committed={pendingRecovery?.state === 'committed'}
                    actionName={actionName}
                    mode={mode}
                    errorMsg={errorMsg}
                    statusText={statusText}
                    progress={progress}
                    closeBanner={closeBanner}
                    setStep={setStep}
                    startRun={startRun}
                  />
                )}
                {step === 'done' && (
                  <StepDone
                    info={info}
                    completionIntent={completionIntent}
                    completionStatus={statusText}
                    finalizing={finalizing}
                    actionName={actionName}
                    mode={mode}
                    finalDir={finalDir}
                    installDir={installDir}
                    residualNote={residualNote}
                    closeBanner={closeBanner}
                  />
                )}
                {['location', 'installing', 'done'].includes(step) && <OperationDetails
                  summary={operationSummary} lines={[...preparationLines, ...logLines]} logPath={logPath} logError={logError}
                  onOpenLog={logPath ? () => window.installer.openLog(logPath) : undefined} />}
              </>
            )}

    </WizardShell>
  )
}
