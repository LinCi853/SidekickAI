param([string]$Target, [int]$HoldMilliseconds)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
    [Console]::Out.WriteLine('locked')
    [Console]::Out.Flush()
    [void][Console]::ReadLine()
    [System.Threading.Thread]::Sleep($HoldMilliseconds)
} finally {
    $stream.Dispose()
}
