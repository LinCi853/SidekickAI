'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 20000
const POWERSHELL_TIMEOUT_MARGIN_MS = 30000

// The installer must show a usable first screen before it can enter the candidate set.
// The toolkit verify entry deliberately never executes Setup, so this probe owns the
// process cleanup as well: it kills the started tree by PID and then confirms that no
// process still runs from the same executable path.
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$exe = $env:PROBE_EXE
$timeoutMs = [int]$env:PROBE_TIMEOUT_MS
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$ok = $false
$title = ''
$rootLength = 0
$reason = ''
$button = ''
$leaked = $false
$procId = $null
try {
  $proc = Start-Process -FilePath $exe -PassThru
  $procId = $proc.Id
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $window = $null
  $windows = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
    if ($proc.HasExited) { $reason = "process-exited:$($proc.ExitCode)"; break }
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -gt 0 -and $windows[0].Current.Name) {
      $window = $windows[0]
      $title = $windows[0].Current.Name
      break
    }
  }
  if (-not $window) {
    if (-not $reason) { $reason = 'window-missing' }
  } else {
    $primaryLabels = @('继续', '安装', '开始安装', '下一步', '立即安装', '重新安装', '修复安装')
    $primaryFound = $false
    # The first screen is only usable once the web content has rendered; keep polling
    # until the content subtree and its primary button are both present.
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 200
      if ($proc.HasExited) { $reason = "process-exited:$($proc.ExitCode)"; break }
      $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
      if ($windows.Count -gt 0) {
        $window = $windows[0]
        $title = $window.Current.Name
      }
      if (-not $window) { $reason = 'window-closed'; break }
      $errorDialog = $false
      $primaryFound = $false
      $webview = $null
      $document = $null
      $descendants = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($element in $descendants) {
        try {
          $className = $element.Current.ClassName
          if (-not $webview -and $className -like 'Chrome_WidgetWin*') { $webview = $element }
          if (-not $document -and $element.Current.ControlType.ProgrammaticName -eq 'ControlType.Document') { $document = $element }
          if ($element.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') {
            if ($element.Current.IsEnabled -and $primaryLabels -contains $element.Current.Name -and -not $primaryFound) {
              $primaryFound = $true
              $button = $element.Current.Name
            }
          }
          if ($element.Current.Name -match '^\s*(错误|失败)') { $errorDialog = $true }
        } catch { }
      }
      foreach ($candidate in $windows) {
        try {
          if ($candidate.Current.ClassName -eq '#32770') { $errorDialog = $true }
          if ($candidate.Current.Name -match '错误|失败|Error') { $errorDialog = $true }
        } catch { }
      }
      $rootLength = 0
      if ($webview) {
        try {
          $rootLength = $webview.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count
        } catch { $rootLength = 0 }
      }
      if ($rootLength -eq 0 -and $document) {
        try {
          $rootLength = $document.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count
        } catch { $rootLength = 0 }
      }
      if ($rootLength -eq 0) { $rootLength = $descendants.Count }
      if ($errorDialog) { $reason = 'error-dialog'; break }
      if ($rootLength -gt 0 -and $primaryFound) { $ok = $true; break }
    }
    if (-not $ok -and -not $reason) {
      if ($rootLength -eq 0) { $reason = 'window-content-empty' }
      elseif (-not $primaryFound) { $reason = 'primary-button-unavailable' }
    }
  }
} catch {
  $reason = "launch-failed:$($_.Exception.Message)"
} finally {
  $durationMs = [int]$watch.ElapsedMilliseconds
  if ($procId) {
    try { & taskkill.exe /PID $procId /T /F *> $null } catch { }
    Start-Sleep -Milliseconds 600
    $name = [System.IO.Path]::GetFileName($exe)
    $left = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $exe })
    if ($left.Count -gt 0) {
      $leaked = $true
      foreach ($entry in $left) { try { & taskkill.exe /PID $entry.ProcessId /T /F *> $null } catch { } }
    }
  }
  [ordered]@{
    ok = $ok
    title = $title
    rootLength = [int]$rootLength
    durationMs = $durationMs
    reason = $reason
    button = $button
    leaked = $leaked
  } | ConvertTo-Json -Compress
}
`

function runProbe(file, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const executable = path.resolve(file)
  if (process.platform !== 'win32')
    return { ok: false, title: '', rootLength: 0, durationMs: 0, reason: 'unsupported-platform' }
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      timeout: timeoutMs + POWERSHELL_TIMEOUT_MARGIN_MS,
      windowsHide: true,
      env: { ...process.env, PROBE_EXE: executable, PROBE_TIMEOUT_MS: String(timeoutMs) },
    },
  )
  const output = (run.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
  try {
    const result = JSON.parse(output)
    return {
      ok: result.ok === true,
      title: typeof result.title === 'string' ? result.title : '',
      rootLength: Number.isInteger(result.rootLength) ? result.rootLength : 0,
      durationMs: Number.isInteger(result.durationMs) ? result.durationMs : 0,
      reason: typeof result.reason === 'string' ? result.reason : '',
      button: typeof result.button === 'string' ? result.button : '',
      leaked: result.leaked === true,
    }
  } catch {
    const detail = (run.stderr || run.error?.message || output || 'no probe output')
      .trim()
      .split(/\r?\n/)
      .pop()
    return {
      ok: false,
      title: '',
      rootLength: 0,
      durationMs: 0,
      reason: 'probe-output-invalid:' + detail,
    }
  }
}

function probeInstallers({ installers = [], skip = false, skipReason, timeoutMs } = {}) {
  const reason = skipReason || 'skipped by --skip-launch-probe'
  if (skip)
    return {
      attempted: false,
      reason,
      results: installers.map((item) => ({
        architecture: item.architecture,
        file: path.resolve(item.path),
        attempted: false,
        ok: null,
        title: '',
        rootLength: 0,
        durationMs: 0,
        reason,
      })),
    }
  return {
    attempted: true,
    reason: '',
    results: installers.map((item) => {
      const probe = runProbe(item.path, { timeoutMs })
      return {
        architecture: item.architecture,
        file: path.resolve(item.path),
        attempted: true,
        ...probe,
      }
    }),
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, probeInstallers, runProbe }
