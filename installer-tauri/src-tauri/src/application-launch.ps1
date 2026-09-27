$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    switch ($env:SIDEKICK_LAUNCH_ACTION) {
        "inventory" {
            $session = (Get-Process -Id $PID).SessionId
            $records = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -Filter "Name='SidekickAI.exe' OR Name='SidekickAI-OpenSource.exe'" | Where-Object { $_.SessionId -eq $session } | Select-Object ProcessId, ExecutablePath, CommandLine)
            @{ session = $session; home = $env:USERPROFILE; processes = $records } | ConvertTo-Json -Depth 4 -Compress
        }
        "request" {
            $pipe = [IO.Pipes.NamedPipeClientStream]::new(".", $env:SIDEKICK_LAUNCH_PIPE, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
            try {
                $pipe.Connect(1000)
                $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 1024, $true)
                $writer.AutoFlush = $true
                $writer.WriteLine($env:SIDEKICK_LAUNCH_REQUEST)
                $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
                $pending = $reader.ReadLineAsync()
                if (-not $pending.Wait(1500)) { throw "Application response timed out" }
                $pending.Result
            } finally { $pipe.Dispose() }
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
