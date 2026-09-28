# 工百窗启动引导：确保 Node.js 运行环境可用。
# 一般由 launch.bat 调用，无需手动运行。成功时向标准输出打印一行 Node.js 所在目录，
# 进度与提示写入标准错误，便于调用方用 for /f 只捕获目录。
# 可选开关：
#   -CheckOnly        只检查不安装（环境不满足时退出码 2）
#   -WithBuildTools   额外安装 Windows C++ 构建工具（原生模块编译失败时使用，需管理员授权）

param(
  [string]$MinVersion = '',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'SidekickAI\tools'),
  [string]$NodeMajor = '24',
  [switch]$CheckOnly,
  [switch]$WithBuildTools
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Note([string]$message) { [Console]::Error.WriteLine($message) }

function Test-NodeDir([string]$dir, [version]$min) {
  if (-not $dir) { return $null }
  $nodeExe = Join-Path $dir 'node.exe'
  if (-not (Test-Path $nodeExe)) { return $null }
  if (-not (Test-Path (Join-Path $dir 'npm.cmd'))) { return $null }
  try { $reported = (& $nodeExe -v).Trim() } catch { return $null }
  if ($reported -notmatch '^v(\d+(\.\d+){1,2})$') { return $null }
  if ([version]($reported.TrimStart('v')) -lt $min) { return $null }
  return $dir
}

$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $MinVersion) {
  $engines = (Get-Content (Join-Path $workspaceRoot 'package.json') -Raw | ConvertFrom-Json).engines.node
  $MinVersion = $engines.TrimStart('>=')
}
$min = [version]$MinVersion

$portableDir = Join-Path $InstallRoot 'node'
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$candidates = @()
if ($pathNode) { $candidates += (Split-Path -Parent $pathNode.Source) }
if (Test-Path (Join-Path $portableDir 'node.exe')) { $candidates += $portableDir }

$ready = $null
foreach ($dir in ($candidates | Select-Object -Unique)) {
  $ready = Test-NodeDir $dir $min
  if ($ready) { break }
}

if (-not $ready) {
  if ($CheckOnly) { Note("Node.js 环境不满足要求（需要 >= $min）。"); exit 2 }
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $sources = @(
    @{ Name = "国内镜像 npmmirror"; Base = "https://registry.npmmirror.com/-/binary/node/latest-v$NodeMajor.x" },
    @{ Name = "官方源 nodejs.org"; Base = "https://nodejs.org/dist/latest-v$NodeMajor.x" }
  )
  foreach ($source in $sources) {
    try {
      Note("未找到可用的 Node.js（需要 >= $min），正在从 $($source.Name) 获取 v$NodeMajor …")
      $shasums = (Invoke-WebRequest -UseBasicParsing -Uri "$($source.Base)/SHASUMS256.txt" -TimeoutSec 30).Content
      $line = ($shasums -split "`n") | Where-Object { $_ -match "node-v\d+\.\d+\.\d+-win-$arch\.zip" } | Select-Object -First 1
      if (-not $line) { throw '清单中没有对应架构的压缩包' }
      $fields = $line.Trim() -split '\s+', 2
      $zipName = Split-Path -Leaf $fields[1].Trim()
      $zipPath = Join-Path ([IO.Path]::GetTempPath()) $zipName
      Note("正在下载 $zipName（约 30 MB，视网络情况需要几分钟）…")
      Invoke-WebRequest -UseBasicParsing -Uri "$($source.Base)/$zipName" -OutFile $zipPath -TimeoutSec 900
      $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
      if ($actual -ne $fields[0].ToLower()) { throw '下载文件的 SHA-256 校验不通过' }
      $staging = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
      Note('正在解压并安装到用户目录（无需管理员权限）…')
      Expand-Archive -Path $zipPath -DestinationPath $staging -Force
      $extracted = Get-ChildItem $staging -Directory | Select-Object -First 1
      if (-not $extracted -or -not (Test-Path (Join-Path $extracted.FullName 'node.exe'))) { throw '压缩包内容异常' }
      if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
      New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
      Copy-Item (Join-Path $extracted.FullName '*') $portableDir -Recurse -Force
      Remove-Item $staging -Recurse -Force
      Remove-Item $zipPath -Force
      $ready = Test-NodeDir $portableDir $min
      if ($ready) { break }
      throw '安装结果校验未通过'
    } catch {
      Note("  $($source.Name) 不可用：$($_.Exception.Message)")
      $ready = $null
    }
  }
  if (-not $ready) {
    Note("自动安装失败。请手动安装 Node.js LTS（https://nodejs.org/ ，需 $min 以上）后重新运行 launch.bat。")
    exit 1
  }
}

if ($WithBuildTools) {
  Note('正在安装 Windows C++ 构建工具（Visual Studio Build Tools，体积较大且需要管理员授权）…')
  $installer = Join-Path ([IO.Path]::GetTempPath()) 'vs_BuildTools.exe'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $installer -TimeoutSec 300
    $process = Start-Process -FilePath $installer -ArgumentList '--add Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended', '--passive', '--norestart' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "安装程序退出码 $($process.ExitCode)" }
    Note('C++ 构建工具安装完成。')
  } catch {
    Note("构建工具安装未完成：$($_.Exception.Message)。可稍后重试，或到 https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/ 手动安装。")
    exit 1
  }
}

$version = (& (Join-Path $ready 'node.exe') -v).Trim()
Note("Node.js $version 已就绪：$ready")
Write-Output $ready
