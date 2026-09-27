import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import { WizardShell, CloseConfirmation, DataPolicyPicker } from '../presentation/Wizard'
import { uninstallApi } from './api'
import { uninstallFailureMessage } from './result-summary'
import { describeDataScope } from './data-scope'
import OperationDetails from '../operation-details/OperationDetails'

import type {
  BackupCategory,
  BackupFormat,
  DataStrategy,
  UninstallApi,
  UninstallError,
  UninstallEvent,
  UninstallInfo,
  UninstallLocation,
  UninstallResult,
  UninstallScanResponse,
} from './protocol'


export interface UninstallPageProps {
  api?: UninstallApi
  /** Used for diagnostics only; the backend remains the source of truth. */
  entry?: 'standalone' | 'installer'
}

type UninstallStep = 'target' | 'policy' | 'executing' | 'done'
type BackupPreset = 'minimal' | 'recommended' | 'full' | 'custom'

const CATEGORIES: Array<{
  key: BackupCategory
  title: string
  description: string
  required?: boolean
}> = [
  { key: 'basicData', title: '基础数据', description: '配置、笔记、模块状态和数据库（必选）', required: true },
  { key: 'cookies', title: '登录凭据', description: 'Cookies / Local Storage，恢复后可减少重新登录' },
  { key: 'indexedDB', title: '应用数据', description: 'IndexedDB 离线数据' },
  { key: 'cache', title: '离线缓存', description: 'Cache、GPUCache、Crashpad 等可再生成数据' },
]

const DEFAULT_CATEGORIES: BackupCategory[] = ['basicData', 'cookies', 'indexedDB']

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return String(error || '未知错误')
}

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `uninstall-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
}

function targetKey(location: UninstallLocation): string {
  return location.id.token
}

function displayArch(arch: UninstallLocation['arch']): string {
  return arch === 'arm64' ? 'ARM64' : arch === 'x64' ? 'x64' : '未知架构'
}

function displayScope(scope: UninstallLocation['scope']): string {
  if (scope === 'allUsers') return '所有用户'
  if (scope === 'perUser') return '当前用户'
  if (scope === 'portable') return '便携版'
  return '未知范围'
}

function formatPhase(phase: UninstallEvent['phase']): string {
  const labels: Record<UninstallEvent['phase'], string> = {
    accepted: '请求已接受',
    scanning: '正在扫描目标',
    validating: '正在验证目标',
    stopping: '正在关闭 SidekickAI',
    backingUp: '正在导出备份',
    commit: '正在提交卸载',
    removingShortcuts: '正在清理快捷方式',
    removingData: '正在处理用户数据',
    removingInstall: '正在移除安装文件',
    removingRegistry: '正在清理卸载信息',
    verifying: '正在验证清理结果',
    completed: '卸载完成',
    cancelled: '已取消卸载',
    failed: '卸载失败',
  }
  return labels[phase]
}

function resultError(result: UninstallResult): UninstallError | null {
  return result.error ?? null
}

export default function UninstallPage({ api = uninstallApi, entry = 'standalone' }: UninstallPageProps) {
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [step, setStep] = useState<UninstallStep>('target')
  const [info, setInfo] = useState<UninstallInfo | null>(null)
  const [scan, setScan] = useState<UninstallScanResponse | null>(null)
  const [selectedToken, setSelectedToken] = useState<string | null>(null)
  const [additionalTokens, setAdditionalTokens] = useState<string[]>([])
  const [strategy, setStrategy] = useState<DataStrategy>('keep')
  const [backupPath, setBackupPath] = useState('')
  const [backupPassword, setBackupPassword] = useState('')
  const [backupEncrypt, setBackupEncrypt] = useState(true)
  const [backupCategories, setBackupCategories] = useState<BackupCategory[]>(DEFAULT_CATEGORIES)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('正在准备卸载…')
  const [bootstrapError, setBootstrapError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [terminalResult, setTerminalResult] = useState<UninstallResult | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isChoosingBackup, setIsChoosingBackup] = useState(false)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [committed, setCommitted] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [logPath, setLogPath] = useState('')
  const [logError, setLogError] = useState('')

  const activeOperationIdRef = useRef<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const lastSequenceRef = useRef(-1)
  const startInFlightRef = useRef(false)
  const closeStartedRef = useRef(false)
  const terminalRef = useRef(false)
  const mountedRef = useRef(true)

  const locations = scan?.locations ?? []
  const selectedLocation = useMemo(
    () => locations.find((location) => targetKey(location) === selectedToken) ?? null,
    [locations, selectedToken],
  )
  const selectableLocations = useMemo(() => locations.filter((location) => location.removable), [locations])
  const selectedAdditionalLocations = useMemo(
    () => selectableLocations.filter((location) => additionalTokens.includes(targetKey(location))),
    [additionalTokens, selectableLocations],
  )
  const dataScope = describeDataScope(scan, selectedLocation
    ? [selectedLocation.id.token, ...selectedAdditionalLocations.map(location => location.id.token)]
    : [])
  const dataScopeIssue = strategy === 'keep' ? null : dataScope.issue
  const backupFormat: BackupFormat = backupEncrypt ? 'sabackup' : 'zip'
  const backupPreset = useMemo<BackupPreset>(() => {
    const current = new Set(backupCategories)
    const same = (expected: BackupCategory[]) => expected.length === current.size && expected.every((item) => current.has(item))
    if (same(['basicData', 'cookies'])) return 'minimal'
    if (same(['basicData', 'cookies', 'indexedDB'])) return 'recommended'
    if (same(['basicData', 'cookies', 'indexedDB', 'cache'])) return 'full'
    return 'custom'
  }, [backupCategories])

  const applyScan = useCallback((nextScan: UninstallScanResponse) => {
    setScan(nextScan)
    const recommended = nextScan.recommendedTargetId?.token
    const firstRemovable = nextScan.locations.find((location) => location.removable)?.id.token ?? null
    const nextSelected = nextScan.locations.some((location) => location.id.token === recommended && location.removable)
      ? recommended ?? firstRemovable
      : firstRemovable
    setSelectedToken(nextSelected)
    setAdditionalTokens([])
  }, [])

  const refreshScan = useCallback(async () => {
    setConnectionAttempt((attempt) => attempt + 1)
  }, [])

  const processEvent = useCallback((event: UninstallEvent) => {
    if (terminalRef.current || event.protocolVersion !== 1) return
    const activeOperationId = activeOperationIdRef.current
    const activeRequestId = activeRequestIdRef.current
    if (!activeRequestId || event.requestId !== activeRequestId) return
    if (!event.operationId || (activeOperationId && event.operationId !== activeOperationId)) return
    if (event.sequence <= lastSequenceRef.current) return
    activeOperationIdRef.current = event.operationId
    lastSequenceRef.current = event.sequence
    if (['commit', 'removingShortcuts', 'removingData', 'removingInstall', 'removingRegistry', 'verifying'].includes(event.phase)) setCommitted(true)

    setProgress((current) => Math.max(current, Math.min(100, Math.max(0, event.progress))))
    setStatusText(event.message || formatPhase(event.phase))
    setHistory(lines => [...lines, `${new Date().toLocaleTimeString()} · ${event.message || formatPhase(event.phase)}`])
    setLogPath(event.logPath || '')
    setLogError(event.logError || '')

    if (!event.terminal) return
    terminalRef.current = true
    startInFlightRef.current = false
    setCancelRequested(false)
    if (!event.result || event.result.requestId !== activeRequestId || event.result.operationId !== event.operationId || event.result.phase !== event.phase) {
      setOperationError('后端未返回卸载终态结果，未确认任何成功清理。')
      setTerminalResult(null)
      setStep('done')
      return
    }
    setTerminalResult(event.result)
    if (event.result.state === 'completed') {
      setProgress(100)
      setStep('done')
    } else {
      setStep('done')
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const offEvent = api.onEvent(processEvent)
    const diagnosticsApi = api as UninstallApi & { onEventError?: (cb: (error: unknown) => void) => () => void }
    const offEventError = diagnosticsApi.onEventError?.((error: unknown) => {
      if (!mountedRef.current) return
      const message = `卸载进度监听失败：${errorMessage(error)}`
      if (activeOperationIdRef.current) setOperationError(message)
      else setBootstrapError(message)
    })

    return () => {
      mountedRef.current = false
      offEvent()
      offEventError?.()
    }
  }, [api, processEvent, connectionAttempt])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setBootstrapError('')
    void Promise.all([api.getInfo(), api.scan(), api.whenReady?.()])
      .then(([nextInfo, nextScan]) => {
        if (cancelled || !mountedRef.current) return
        setInfo(nextInfo)
        applyScan(nextScan)
      })
      .catch((error: unknown) => {
        if (!cancelled && mountedRef.current) setBootstrapError(`卸载器初始化失败：${errorMessage(error)}`)
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, applyScan, connectionAttempt])

  const chooseTarget = useCallback((location: UninstallLocation) => {
    if (!location.removable) return
    setSelectedToken(targetKey(location))
    setAdditionalTokens((current) => current.filter((token) => token !== targetKey(location)))
  }, [])

  const toggleAdditional = useCallback((location: UninstallLocation) => {
    if (!location.removable || targetKey(location) === selectedToken) return
    const token = targetKey(location)
    setAdditionalTokens((current) => (current.includes(token) ? current.filter((item) => item !== token) : [...current, token]))
  }, [selectedToken])

  const toggleCategory = useCallback((category: BackupCategory) => {
    if (category === 'basicData') return
    setBackupCategories((current) => {
      const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category]
      return next.includes('basicData') ? next : ['basicData', ...next]
    })
  }, [])

  const applyPreset = useCallback((preset: Exclude<BackupPreset, 'custom'>) => {
    if (preset === 'minimal') setBackupCategories(['basicData', 'cookies'])
    else if (preset === 'recommended') setBackupCategories(['basicData', 'cookies', 'indexedDB'])
    else setBackupCategories(['basicData', 'cookies', 'indexedDB', 'cache'])
  }, [])

  const chooseBackupPath = useCallback(async () => {
    setIsChoosingBackup(true)
    setOperationError('')
    const suggestedName = `SidekickAI-用户数据-${new Date().toISOString().slice(0, 10)}.${backupFormat}`
    try {
      const selected = await api.chooseBackupPath(backupFormat, suggestedName)
      if (mountedRef.current && selected) setBackupPath(selected)
    } catch (error: unknown) {
      if (mountedRef.current) setOperationError(`选择备份位置失败：${errorMessage(error)}`)
    } finally {
      if (mountedRef.current) setIsChoosingBackup(false)
    }
  }, [api, backupFormat])

  const validateBackup = useCallback((): string | null => {
    if (strategy !== 'export') return null
    const path = backupPath.trim()
    if (!path) return '请选择备份保存位置。'
    if (!isAbsoluteWindowsPath(path)) return '备份保存位置必须是绝对 Windows 路径。'
    const expectedExtension = backupEncrypt ? '.sabackup' : '.zip'
    if (!path.toLowerCase().endsWith(expectedExtension)) return `备份文件必须使用 ${expectedExtension} 扩展名。`
    if (backupEncrypt && backupPassword.length < 6) return '加密备份密码至少需要 6 位。'
    if (!backupCategories.includes('basicData')) return '基础数据是必选备份范围。'
    return null
  }, [backupCategories, backupEncrypt, backupPassword, backupPath, strategy])

  const beginUninstall = useCallback(async () => {
    if (startInFlightRef.current || terminalRef.current || isLoading || bootstrapError || !info || !scan || !selectedLocation) return
    if (!selectedLocation.removable) {
      setOperationError('所选目标不可移除，请选择可验证的 SidekickAI 安装。')
      return
    }
    if (dataScopeIssue) {
      setOperationError(dataScopeIssue)
      return
    }
    const backupError = validateBackup()
    if (backupError) {
      setOperationError(backupError)
      return
    }

    const id = requestId()
    startInFlightRef.current = true
    terminalRef.current = false
    activeOperationIdRef.current = null
    activeRequestIdRef.current = id
    lastSequenceRef.current = -1
    setOperationError('')
    setTerminalResult(null)
    setCancelRequested(false)
    setProgress(0)
    setStatusText('正在准备卸载…')
    setHistory([])
    setLogPath('')
    setLogError('')
    setStep('executing')

    const request = {
      protocolVersion: 1 as const,
      requestId: id,
      scanId: scan.scanId,
      targetId: selectedLocation.id,
      strategy,
      ...(strategy === 'export'
        ? {
            backup: {
              format: backupFormat,
              outputPath: backupPath.trim(),
              encrypt: backupEncrypt,
              ...(backupEncrypt ? { password: backupPassword } : {}),
              categories: backupCategories,
            },
          }
        : {}),
      additionalTargetIds: selectedAdditionalLocations.map((location) => location.id),
      confirmation: 'delete-v1' as const,
    }

    try {
      const accepted = await api.start(request)
      if (!mountedRef.current) return
      if (accepted.state !== 'accepted' || accepted.requestId !== id || !accepted.operationId) {
        throw new Error('卸载器返回了无效的 accepted 响应。')
      }
      if (activeOperationIdRef.current && activeOperationIdRef.current !== accepted.operationId) throw new Error('卸载操作标识不一致，请检查当前操作。')
      activeOperationIdRef.current = accepted.operationId
      if (!terminalRef.current) setStatusText('卸载请求已接受，正在执行…')
    } catch (error: unknown) {
      if (!mountedRef.current || terminalRef.current) return
      if (activeOperationIdRef.current) {
        setOperationError(`请求响应异常，但操作已建立，请等待结果：${errorMessage(error)}`)
        return
      }
      startInFlightRef.current = false
      activeRequestIdRef.current = null
      setStep('policy')
      setOperationError(`开始卸载失败：${errorMessage(error)}`)
    }
  }, [api, backupCategories, backupEncrypt, backupFormat, backupPassword, backupPath, bootstrapError, dataScopeIssue, info, isLoading, scan, selectedAdditionalLocations, selectedLocation, strategy, validateBackup])

  const requestCancel = useCallback(async () => {
    const operationId = activeOperationIdRef.current
    if (!operationId || terminalRef.current || cancelRequested) return
    setCancelRequested(true)
    try {
      const response = await api.cancel(operationId)
      if (!mountedRef.current) return
      if (response.state === 'tooLate') {
        setCommitted(true)
        setCancelRequested(false)
        setOperationError('删除已经开始，当前操作无法取消；请等待卸载结果。')
      } else if (response.state === 'notFound') {
        setCancelRequested(false)
        setOperationError('未找到正在执行的卸载操作，请等待后端终态。')
      } else {
        setStatusText('正在等待安全取消点…')
      }
    } catch (error: unknown) {
      if (mountedRef.current) {
        setCancelRequested(false)
        setOperationError(`取消卸载失败：${errorMessage(error)}`)
      }
    }
  }, [api, cancelRequested])

  const closeWindow = useCallback(async () => {
    if (closeStartedRef.current) return
    closeStartedRef.current = true
    try {
      await api.close()
    } catch (error: unknown) {
      closeStartedRef.current = false
      if (mountedRef.current) setOperationError(`关闭卸载器失败：${errorMessage(error)}`)
    }
  }, [api])

  const confirmClose = useCallback(() => {
    setShowCloseConfirm(false)
    if (startInFlightRef.current && !terminalRef.current) {
      if (committed) setOperationError('删除已经开始，无法中断；请等待最终结果。')
      else if (activeOperationIdRef.current) void requestCancel()
      else setOperationError('正在提交请求，请等待请求返回后再取消。')
      return
    }
    void closeWindow()
  }, [closeWindow, committed, requestCancel])

  const handleClose = useCallback(() => {
    if (step === 'done') void closeWindow()
    else setShowCloseConfirm(true)
  }, [step, closeWindow])

  useEffect(() => api.onCloseRequested?.(handleClose), [api, handleClose])

  const resetForRetry = useCallback(async () => {
    activeOperationIdRef.current = null
    activeRequestIdRef.current = null
    lastSequenceRef.current = -1
    terminalRef.current = false
    startInFlightRef.current = false
    setTerminalResult(null)
    setOperationError('')
    setCommitted(false)
    setProgress(0)
    setStep('target')
    await refreshScan()
  }, [refreshScan])

  const canContinue = Boolean(selectedLocation?.removable)
  const backupError = validateBackup()
  const canStart = canContinue && !isLoading && !startInFlightRef.current && !backupError && !dataScopeIssue

  const renderTarget = () => (
    <>
      <h1 className="uninstall-content__title">选择卸载目标</h1>
      <p className="uninstall-content__subtitle">已扫描概念版、社区版及历史版本。请选择要移除的安装，其他位置默认保留。</p>
      {locations.length === 0 ? (
        <div className="uninstall-error-box">
          <strong>未发现可验证的 SidekickAI 安装</strong>
          <span>请确认安装目录仍包含 SidekickAI 核心文件。卸载器不会跳转到安装或修复页面。</span>
        </div>
      ) : (
        <div className="uninstall-location-list">
          {locations.map((location) => {
            const selected = targetKey(location) === selectedToken
            return (
              <button
                type="button"
                key={targetKey(location)}
                className={`uninstall-location-card ${selected ? 'uninstall-location-card--selected' : ''} ${!location.removable ? 'uninstall-location-card--disabled' : ''}`}
                onClick={() => chooseTarget(location)}
                disabled={!location.removable}
              >
                <span className={`uninstall-radio ${selected ? 'uninstall-radio--selected' : ''}`} />
                <span className="uninstall-location-card__body">
                  <span className="uninstall-location-card__path">{location.displayPath || location.path}</span>
                  <span className="uninstall-location-card__meta">
                    {location.edition === 'concept' ? '概念版' : '社区版'} ·{' '}
                    {location.version ? `v${location.version} · ` : ''}
                    {displayScope(location.scope)} · {displayArch(location.arch)}
                    {location.identityConfidence === 'degraded' ? ' · 降级身份' : ''}
                    {location.runningPids.length > 0 ? ` · 运行中 (${location.runningPids.join(', ')})` : ''}
                  </span>
                  {!location.removable && <span className="uninstall-location-card__reason">不可移除：{location.nonRemovableReason || '目标身份未确认'}</span>}
                </span>
                {location.recommended && <span className="uninstall-badge">推荐</span>}
              </button>
            )
          })}
        </div>
      )}
      {selectableLocations.length > 1 && selectedLocation && (
        <div className="uninstall-additional-section">
          <div className="uninstall-field-label">同时清理其他安装位置（可选）</div>
          <div className="uninstall-location-list">
            {selectableLocations
              .filter((location) => targetKey(location) !== selectedToken)
              .map((location) => {
                const checked = additionalTokens.includes(targetKey(location))
                return (
                  <button
                    type="button"
                    key={targetKey(location)}
                    className={`uninstall-check-row ${checked ? 'uninstall-check-row--checked' : ''}`}
                    onClick={() => toggleAdditional(location)}
                  >
                    <span className={`uninstall-checkbox ${checked ? 'uninstall-checkbox--checked' : ''}`}>{checked ? '✓' : ''}</span>
                    <span>{location.edition === 'concept' ? '概念版' : '社区版'} · {location.version || '未知版本'} · {location.displayPath || location.path}</span>
                  </button>
                )
              })}
          </div>
        </div>
      )}
    </>
  )

  const renderPolicy = () => (
    <>
      <h1 className="uninstall-content__title">用户数据处理</h1>
      <p className="uninstall-content__subtitle">
        {selectedLocation ? `已选择：${selectedLocation.displayPath || selectedLocation.path}` : '请先选择一个可卸载目标。'}
      </p>
      {operationError && <div className="uninstall-error-box" role="alert">{operationError}</div>}
      <DataPolicyPicker value={strategy} onChange={setStrategy} exportDescription="备份按所选范围导出；导出成功并验证后删除本机数据。未选类别不会被保留。">
          <div className="uninstall-export-panel">
            <div className="uninstall-field-label">导出范围</div>
            <div className="uninstall-preset-row">
              {(
                [
                  ['minimal', '最小'],
                  ['recommended', '推荐'],
                  ['full', '完整'],
                ] as const
              ).map(([preset, label]) => (
                <button type="button" key={preset} className={`uninstall-btn uninstall-preset-btn ${backupPreset === preset ? 'uninstall-preset-btn--active' : ''}`} onClick={() => applyPreset(preset)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="uninstall-category-list">
              {CATEGORIES.map((category) => (
                <button
                  type="button"
                  key={category.key}
                  className={`uninstall-check-row ${backupCategories.includes(category.key) ? 'uninstall-check-row--checked' : ''} ${category.required ? 'uninstall-check-row--locked' : ''}`}
                  onClick={() => toggleCategory(category.key)}
                  disabled={category.required}
                >
                  <span className={`uninstall-checkbox ${backupCategories.includes(category.key) ? 'uninstall-checkbox--checked' : ''}`}>{backupCategories.includes(category.key) ? '✓' : ''}</span>
                  <span>
                    <strong>{category.title}</strong>
                    <small>{category.description}</small>
                  </span>
                  {category.required && <em>必选</em>}
                </button>
              ))}
            </div>
            <button type="button" className="uninstall-check-row" onClick={() => setBackupEncrypt((current) => !current)}>
              <span className={`uninstall-checkbox ${backupEncrypt ? 'uninstall-checkbox--checked' : ''}`}>{backupEncrypt ? '✓' : ''}</span>
              <span>
                <strong>加密备份</strong>
                <small>加密保存为 .sabackup；关闭后导出明文 .zip。</small>
              </span>
            </button>
            <div className="uninstall-field-label">备份保存位置</div>
            <div className="uninstall-path-row">
              <input className={`uninstall-input ${backupPath && backupError ? 'uninstall-input--error' : ''}`} value={backupPath} onChange={(event) => setBackupPath(event.target.value)} placeholder={backupEncrypt ? '选择 .sabackup 保存路径' : '选择 .zip 保存路径'} spellCheck={false} />
              <button type="button" className="uninstall-btn" onClick={() => void chooseBackupPath()} disabled={isChoosingBackup}>{isChoosingBackup ? '打开中…' : '浏览'}</button>
            </div>
            {backupEncrypt && <input className="uninstall-input" type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="备份密码（至少 6 位）" />}
            {backupError && <div className="uninstall-inline-error">{backupError}</div>}
          </div>
      </DataPolicyPicker>
      {dataScope.roots.length > 0 && <div className="uninstall-hint">
        <strong>{strategy === 'keep' ? '将保留以下用户数据：' : '本次涉及的用户数据：'}</strong>
        {dataScope.roots.map(root => <div key={root.path}>{root.path}</div>)}
      </div>}
      {dataScopeIssue && <div className="uninstall-error-box" role="alert">{dataScopeIssue}</div>}
      {strategy === 'export' && <div className="uninstall-hint">导出失败、不完整或无法校验时，后端必须保留所有目标数据和安装文件。</div>}
    </>
  )

  const renderExecuting = () => {
    const error = terminalResult ? resultError(terminalResult) : null
    const terminal = Boolean(terminalResult)
    return (
      <div className="uninstall-state-panel">
        <div className={`uninstall-state-icon ${terminal && terminalResult?.state !== 'completed' ? 'uninstall-state-icon--error' : ''}`}>{terminal ? (terminalResult?.state === 'completed' ? '✓' : '!') : <span className="uninstall-spinner" />}</div>
        <h1 className="uninstall-state-title">{terminal ? (terminalResult?.state === 'completed' ? '卸载完成' : terminalResult?.state === 'cancelled' ? '已取消卸载' : '卸载失败') : '正在卸载 SidekickAI'}</h1>
        <p className="uninstall-state-message">{statusText}</p>
        <div className="uninstall-progress-track"><div className="uninstall-progress-fill" style={{ width: `${progress}%` }} /></div>
        <div className="uninstall-progress-meta"><span>{Math.round(progress)}%</span>{cancelRequested && <span>正在等待安全取消点</span>}</div>
        {error && <div className="uninstall-error-box"><strong>{error.code}</strong><span>{error.message}</span><span>已完成的副作用不会自动回滚，请按结果检查。</span></div>}
        {terminalResult && terminalResult.warnings.length > 0 && <div className="uninstall-warning-box">{terminalResult.warnings.join('；')}</div>}
        {operationError && <div className="uninstall-error-box">{operationError}</div>}
      </div>
    )
  }

  const renderDone = () => {
    const result = terminalResult
    if (!result) {
      return (
        <div className="uninstall-state-panel">
          <div className="uninstall-state-icon uninstall-state-icon--error">!</div>
          <h1 className="uninstall-state-title">无法确认卸载结果</h1>
          <p className="uninstall-state-message">{operationError || '后端没有返回可验证的终态结果，未显示成功。'}</p>
        </div>
      )
    }
    const succeeded = result.state === 'completed'
    const cancelled = result.state === 'cancelled'
    return (
      <div className="uninstall-state-panel">
        <div className={`uninstall-state-icon ${succeeded ? '' : 'uninstall-state-icon--error'}`}>{succeeded ? '✓' : cancelled ? 'Ⅱ' : '!'}</div>
        <h1 className="uninstall-state-title">{succeeded ? '卸载完成' : cancelled ? '已取消卸载' : '卸载失败'}</h1>
        <p className="uninstall-state-message">
          {succeeded
            ? strategy === 'keep'
              ? 'SidekickAI 已卸载，用户数据已保留。'
              : strategy === 'export'
                ? `SidekickAI 已卸载；备份已验证并保存至：${result.backup?.path || backupPath}`
                : 'SidekickAI 及其用户数据已按确认范围移除。'
            : cancelled
              ? '操作在不可逆删除前取消，未将取消视为回滚。'
              : uninstallFailureMessage(result)}
        </p>
        {result.error && <div className="uninstall-error-box" role="alert"><strong>{result.error.code}</strong><span>{result.error.message}</span></div>}
        {result.warnings.length > 0 && <div className="uninstall-warning-box">{result.warnings.join('；')}</div>}
        {result.removedInstallPaths.length > 0 && <div className="uninstall-result-list">已处理安装位置：{result.removedInstallPaths.join('；')}</div>}
        {result.removedDataRoots.length > 0 && <div className="uninstall-result-list">已处理数据目录：{result.removedDataRoots.join('；')}</div>}
        {operationError && <div className="uninstall-error-box">{operationError}</div>}
      </div>
    )
  }

  const steps: Array<{ id: UninstallStep; label: string }> = [
    { id: 'target', label: '选择目标' },
    { id: 'policy', label: '数据处理' },
    { id: 'executing', label: '卸载中' },
    { id: 'done', label: '完成' },
  ]
  const currentIndex = steps.findIndex((item) => item.id === step)

  const renderFooter = () => {
    if (step === 'executing') {
      return <div className="uninstall-footer"><span className="uninstall-footer__spacer" /><button type="button" className="uninstall-btn" onClick={handleClose} disabled={committed || cancelRequested || terminalResult?.state === 'completed'}>{committed ? '正在删除，请等待…' : cancelRequested ? '等待取消…' : '取消卸载'}</button></div>
    }
    if (step === 'done') {
      return (
        <div className="uninstall-footer">
          <span className="uninstall-footer__spacer" />
          {terminalResult?.state !== 'completed' && <button type="button" className="uninstall-btn" onClick={() => void resetForRetry()}>重新扫描</button>}
          <button type="button" className="uninstall-btn uninstall-btn--primary" onClick={() => void closeWindow()}>{terminalResult?.state === 'completed' ? '完成' : '关闭'}</button>
        </div>
      )
    }
    return (
      <div className="uninstall-footer">
        {step === 'policy' && <button type="button" className="uninstall-btn" onClick={() => { setOperationError(''); setStep('target') }}>上一步</button>}
        <span className="uninstall-footer__spacer" />
        <button type="button" className="uninstall-btn" onClick={handleClose}>取消</button>
        {step === 'target' && <button type="button" className="uninstall-btn uninstall-btn--primary" onClick={() => { setOperationError(''); setStep('policy') }} disabled={!canContinue || isLoading}>继续</button>}
        {step === 'policy' && <button type="button" className="uninstall-btn uninstall-btn--primary" onClick={() => void beginUninstall()} disabled={!canStart}>开始卸载</button>}
      </div>
    )
  }

  return (
    <WizardShell  kind="uninstall" version={info?.uninstallerVersion} stages={steps} currentIndex={currentIndex}
      onClose={handleClose} className="uninstall-app"
      footer={!bootstrapError && renderFooter()}
      overlay={showCloseConfirm && <CloseConfirmation busy={step === 'executing'} onCancel={() => setShowCloseConfirm(false)} onConfirm={confirmClose} />}>

            {bootstrapError ? (
              <div className="uninstall-error-box uninstall-error-box--large"><strong>卸载器初始化失败</strong><span>{bootstrapError}</span><button type="button" className="uninstall-btn" onClick={() => void refreshScan()}>重新扫描</button></div>
            ) : isLoading && !scan ? (
              <div className="uninstall-loading"><span className="uninstall-spinner uninstall-spinner--large" /><span>正在扫描可卸载的 SidekickAI 安装…</span></div>
            ) : (
              <>
                {step === 'target' && renderTarget()}
                {step === 'policy' && renderPolicy()}
                {step === 'executing' && renderExecuting()}
                {step === 'done' && renderDone()}
                {step !== 'target' && <OperationDetails summary={[
                  ['操作', '卸载'], ['目标位置', [selectedLocation?.displayPath || '', ...selectedAdditionalLocations.map(item => item.displayPath)].filter(Boolean).join('；')],
                  ['当前版本', selectedLocation?.version || '未知'],
                  ['用户数据', strategy === 'keep' ? '保留' : strategy === 'export' ? '导出并验证备份后移除' : '移除确认范围内的数据'],
                  ['备份位置', strategy === 'export' ? backupPath : ''],
                ]} lines={history} logPath={logPath} logError={logError}
                  onOpenLog={logPath && api.openLog ? () => api.openLog!(logPath) : undefined} />}

              </>
            )}

    </WizardShell>
  )
}
