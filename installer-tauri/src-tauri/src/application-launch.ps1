$ErrorActionPreference = "Stop"
$env:LIB = ""
$env:LIBPATH = ""
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    switch ($env:SIDEKICK_LAUNCH_ACTION) {
        "descendants" {
            $session = (Get-Process -Id $PID).SessionId
            $records = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $_.SessionId -eq $session })
            $owners = [Collections.Generic.HashSet[int]]::new()
            $null = $owners.Add([int]$env:SIDEKICK_LAUNCH_PID)
            do { $changed = $false; foreach ($record in $records) { if ($owners.Contains([int]$record.ParentProcessId) -and $owners.Add([int]$record.ProcessId)) { $changed = $true } } } while ($changed)
            $children = @($records | Where-Object { $owners.Contains([int]$_.ProcessId) } | ForEach-Object {
                @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine; Created = if ($_.CreationDate -is [DateTime]) { [long]$_.CreationDate.ToFileTimeUtc() } else { $null } }
            })
            ConvertTo-Json -InputObject $children -Depth 4 -Compress
        }
        "close" {
            $target = Get-Process -Id ([int]$env:SIDEKICK_LAUNCH_PID) -ErrorAction SilentlyContinue
            if ($null -ne $target) {
                if ($target.SessionId -ne (Get-Process -Id $PID).SessionId -or $target.Path -ine $env:SIDEKICK_LAUNCH_EXECUTABLE) { throw "Application identity changed" }
                $null = $target.CloseMainWindow()
            }
        }
        default { throw "Unknown application launch operation" }
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
