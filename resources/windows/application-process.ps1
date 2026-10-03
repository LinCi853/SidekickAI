param([string]$RequestFile)
$ErrorActionPreference = 'Stop'
$env:LIB = ''
$env:LIBPATH = ''
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
public sealed class SidekickApplicationProcess : IDisposable {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(int pid, out int session);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, out int value, int length, out int returned);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int type, IntPtr information, int length, out int returned);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
 [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, uint type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
 [DllImport("advapi32.dll", SetLastError=true)] static extern uint SetSecurityInfo(IntPtr handle, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint information, out IntPtr value, out uint length);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 readonly IntPtr handle;
 public readonly int pid, session;
 public readonly bool elevated;
 public readonly string executable, sid, started, commandLine;
 public SidekickApplicationProcess(int pid, bool terminate, bool account) {
  this.pid = pid;
  handle = OpenProcess(0x1000u | 0x100000u | (terminate ? 1u : 0u), false, pid);
  if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot open application process");
  IntPtr token = IntPtr.Zero;
  try {
   if (WaitForSingleObject(handle, 0) == 0) return;
   var name = new StringBuilder(32768); int size = name.Capacity; long created, exited, kernel, user;
   if (!QueryFullProcessImageName(handle, 0, name, ref size) || !ProcessIdToSessionId(pid, out session) || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException("Cannot identify application process");
   if (account) {
    if (!OpenProcessToken(handle, 8, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot identify application account");
    using (var identity = new WindowsIdentity(token)) { sid = identity.User.Value; }
    int value, returned; if (!GetTokenInformation(token, 20, out value, 4, out returned)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot identify application elevation"); elevated = value != 0;
   }
   executable = name.ToString(); started = created.ToString();
   int length; NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out length);
   if (length > 0 && length < 1024 * 1024) {
    IntPtr data = Marshal.AllocHGlobal(length);
    try { if (NtQueryInformationProcess(handle, 60, data, length, out length) == 0) commandLine = Marshal.PtrToStringUni(Marshal.ReadIntPtr(data, IntPtr.Size == 8 ? 8 : 4), (ushort)Marshal.ReadInt16(data) / 2); }
    finally { Marshal.FreeHGlobal(data); }
   }
  } catch { if (WaitForSingleObject(handle, 0) == 0) return; CloseHandle(handle); throw; }
  finally { if (token != IntPtr.Zero) CloseHandle(token); }
 }
 public bool Exited { get { return WaitForSingleObject(handle, 0) == 0; } }
 public bool MatchesSnapshot(long created) {
  // CIM creation timestamps have microsecond precision.
  return !Exited && created > 0 && Int64.Parse(started) / 10 == created / 10;
 }
 public void Verify(string path, string start, string account, int expectedSession) {
  if (Exited || !String.Equals(executable, path, StringComparison.OrdinalIgnoreCase) || started != start || sid != account || session != expectedSession) throw new InvalidOperationException("Application identity changed");
  using (var current = WindowsIdentity.GetCurrent()) { if (sid != current.User.Value || session != Process.GetCurrentProcess().SessionId) throw new InvalidOperationException("Application account or session differs"); }
 }
 public void Terminate() { if (!Exited && !TerminateProcess(handle, 0)) throw new InvalidOperationException("Cannot terminate application: " + Marshal.GetLastWin32Error()); }
 public bool Wait(int timeout) { return WaitForSingleObject(handle, (uint)timeout) == 0; }
 public void Dispose() { CloseHandle(handle); }
 public static object Prepare(string endpoint, int serverPid) {
  if (!System.Text.RegularExpressions.Regex.IsMatch(endpoint ?? "", @"^\\\\\.\\pipe\\sidekick-editions-[a-f0-9]{24}$")) throw new InvalidOperationException("Invalid application endpoint");
  string account;
  using (var owner = new SidekickApplicationProcess(serverPid, false, true)) { using (var current = WindowsIdentity.GetCurrent()) { account = current.User.Value; } if (owner.sid != account || owner.session != Process.GetCurrentProcess().SessionId) throw new InvalidOperationException("Application endpoint owner differs"); }
  IntPtr pipe = CreateFile(endpoint, 0x60000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
  if (pipe == new IntPtr(-1)) throw new InvalidOperationException("Cannot prepare application endpoint");
  try {
   uint actualPid;
   if (!GetNamedPipeServerProcessId(pipe, out actualPid) || actualPid != serverPid) throw new InvalidOperationException("Application endpoint PID differs");
   IntPtr owner, group, dacl, sacl, descriptor, encoded = IntPtr.Zero; uint length;
   if (GetSecurityInfo(pipe, 6, 7, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new InvalidOperationException("Cannot inspect application endpoint security");
   string sddl;
   try { if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 7, out encoded, out length)) throw new InvalidOperationException("Cannot decode application endpoint security"); sddl = Marshal.PtrToStringUni(encoded); }
   finally { if (encoded != IntPtr.Zero) LocalFree(encoded); LocalFree(descriptor); }
   var security = new RawSecurityDescriptor(sddl);
   if (security.DiscretionaryAcl == null || (security.Owner.Value != account && security.Owner.Value != "S-1-5-32-544")) throw new InvalidOperationException("Unexpected application endpoint security");
   bool present = false; const int access = 0x12019f;
   foreach (GenericAce item in security.DiscretionaryAcl) { var ace = item as CommonAce; if (ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && ace.SecurityIdentifier.Value == account && (ace.AccessMask & access) == access) present = true; }
   if (!present) {
    int index = security.DiscretionaryAcl.Count;
    for (int item = 0; item < security.DiscretionaryAcl.Count; item++) if ((security.DiscretionaryAcl[item].AceFlags & AceFlags.Inherited) != 0) { index = item; break; }
    security.DiscretionaryAcl.InsertAce(index, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, access, new SecurityIdentifier(account), false, null));
    byte[] bytes = new byte[security.DiscretionaryAcl.BinaryLength]; security.DiscretionaryAcl.GetBinaryForm(bytes, 0); var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try { if (SetSecurityInfo(pipe, 6, 4, IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero) != 0) throw new InvalidOperationException("Cannot update application endpoint security"); } finally { pinned.Free(); }
   }
   return new { prepared = true, pid = serverPid };
  } finally { CloseHandle(pipe); }
 }
}
public sealed class ApplicationControlPaths : IDisposable {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes; public uint Tag; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int type, out AttributeTag value, uint length);
 readonly System.Collections.Generic.List<IntPtr> handles = new System.Collections.Generic.List<IntPtr>();
 public ApplicationControlPaths(string directory, string request) {
  try {
   string current = Path.GetFullPath(directory);
   while (current != null) { Pin(current); current = Path.GetDirectoryName(current); }
   Pin(request);
  } catch { Dispose(); throw; }
 }
 void Pin(string path) {
  IntPtr handle = CreateFile(path, 0x20080, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
  if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot protect application control path");
  handles.Add(handle); AttributeTag attributes;
  if (!GetFileInformationByHandleEx(handle, 9, out attributes, 8) || (attributes.Attributes & 0x400) != 0) throw new InvalidOperationException("Application control path cannot be a link");
 }
 public static void VerifySecurity(string path, bool directory, string account) {
  FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
  string owner = ((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))).Value;
  if (owner != account && owner != "S-1-5-32-544") throw new InvalidOperationException("Application control path owner differs");
  if (directory && !security.AreAccessRulesProtected) throw new InvalidOperationException("Application control directory is not private");
  bool ownAccess = false;
  foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
   string sid = ((SecurityIdentifier)rule.IdentityReference).Value;
   if (rule.AccessControlType == AccessControlType.Allow && sid != account && sid != "S-1-5-18" && sid != "S-1-5-32-544") throw new InvalidOperationException("Application control permissions differ");
   if (sid == account && rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl) ownAccess = true;
  }
  if (!ownAccess) throw new InvalidOperationException("Application control caller access differs");
 }
 public static void WriteResponse(string directory, string response) {
  string target = Path.Combine(directory, "result.json"), temporary = Path.Combine(directory, "result-" + Guid.NewGuid().ToString("N") + ".tmp");
  if (File.Exists(target) || Directory.Exists(target)) throw new InvalidOperationException("Application control response already exists");
  try {
   byte[] bytes = new UTF8Encoding(false).GetBytes(response);
   using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
   File.Move(temporary, target);
  } finally { if (File.Exists(temporary)) File.Delete(temporary); }
 }
 public void Dispose() { foreach (IntPtr handle in handles) CloseHandle(handle); handles.Clear(); }
}
'@
function Read-Identity([int]$TargetPid, [bool]$Account = $true) {
    try { $owner = [SidekickApplicationProcess]::new($TargetPid, $false, $Account) }
    catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 87) { return $null }
        throw
    }
    try { if ($owner.Exited) { return $null }; return @{ pid = $owner.pid; executable = $owner.executable; started = $owner.started; sid = $owner.sid; session = $owner.session; commandLine = $owner.commandLine; elevated = $owner.elevated } }
    finally { $owner.Dispose() }
}
function Read-ScopedIdentity([int]$TargetPid) {
    $target = Read-Identity $TargetPid
    if ($null -eq $target) { return $null }
    $current = Read-Identity $PID
    if ($target.sid -ne $current.sid -or $target.session -ne $current.session) { throw 'Application account or session differs' }
    return $target
}
function Read-OwnedChildren($Owner, $Records) {
    $parents = [Collections.Generic.Dictionary[int,long]]::new()
    $parents.Add($Owner.pid, [long]$Owner.started)
    $seen = [Collections.Generic.HashSet[int]]::new()
    $children = [Collections.Generic.List[SidekickApplicationProcess]]::new()
    do {
        $changed = $false
        foreach ($row in $Records) {
            $childPid = [int]$row.ProcessId
            $parentPid = [int]$row.ParentProcessId
            if ($childPid -eq $Owner.pid -or $seen.Contains($childPid) -or -not $parents.ContainsKey($parentPid)) { continue }
            $null = $seen.Add($childPid)
            if ($row.CreationDate -isnot [DateTime]) { continue }
            $created = $row.CreationDate.ToFileTimeUtc()
            $child = $null
            try {
                $child = [SidekickApplicationProcess]::new($childPid, $true, $true)
                if (-not $child.MatchesSnapshot($created)) { continue }
                $ownedImage = $child.executable -ieq $Owner.executable -or $child.executable.StartsWith(([IO.Path]::GetDirectoryName($Owner.executable) + '\resources\'), [StringComparison]::OrdinalIgnoreCase)
                $maintenance = [IO.Path]::GetFileName($child.executable) -match '(?i)(?:uninstall|installer|setup)' -or $child.commandLine -match '(?:^|\s)--(?:worker|elevated|uninstall|export-user-data)(?:\s|$)'
                if ($child.sid -eq $Owner.sid -and $child.session -eq $Owner.session -and [long]$child.started -ge $parents[$parentPid] -and $ownedImage -and -not $maintenance) {
                    $children.Add($child)
                    $parents.Add($childPid, [long]$child.started)
                    $changed = $true
                    $child = $null
                }
            } catch {} finally { if ($null -ne $child) { $child.Dispose() } }
        }
    } while ($changed)
    Write-Output -NoEnumerate $children
}
function Get-OwnScriptHash {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($PSCommandPath)
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
}
function Read-PackageIdentity([string]$Executable) {
    $archive = Join-Path ([IO.Path]::GetDirectoryName($Executable)) 'resources/app.asar'
    $stream = [IO.File]::OpenRead($archive)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt32() -ne 4) { throw 'Invalid application archive' }
        $headerSize = $reader.ReadUInt32(); $null = $reader.ReadUInt32(); $jsonSize = $reader.ReadUInt32()
        if ($headerSize -lt 8 -or $headerSize -gt 33554432 -or $jsonSize -gt ($headerSize - 8)) { throw 'Invalid application archive header' }
        $header = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$jsonSize)) | ConvertFrom-Json
        $entry = $header.files.'package.json'
        if ($null -eq $entry -or $entry.link -or $entry.unpacked -or $entry.offset -notmatch '^\d+$' -or $entry.size -le 0 -or $entry.size -gt 1048576) { throw 'Invalid application package identity' }
        $offset = 8 + [long]$headerSize + [long]$entry.offset
        if (($offset + [long]$entry.size) -gt $stream.Length) { throw 'Truncated application package identity' }
        $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
        return ([Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$entry.size)) | ConvertFrom-Json)
    } finally { $stream.Dispose() }
}
try {
    $inputData = if ($RequestFile) { $null } else { $env:SIDEKICK_PROCESS_INPUT | ConvertFrom-Json }
    $scope = $null
    $protectedPaths = $null
    $verifiedScope = $false
    if ($RequestFile) {
        $requestPath = [IO.Path]::GetFullPath($RequestFile)
        $scopeDirectory = [IO.Path]::GetDirectoryName($requestPath)
        $scopeRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SidekickAI-Startup/coordination'))
        if ([IO.Path]::GetDirectoryName($scopeDirectory) -ine $scopeRoot -or [IO.Path]::GetFileName($scopeDirectory) -notmatch '^control-[a-f0-9]{64}$' -or [IO.Path]::GetFileName($requestPath) -cne 'request.json') { throw 'Invalid application control directory' }
        $protectedPaths = [ApplicationControlPaths]::new($scopeDirectory, $requestPath)
        $current = Read-Identity $PID
        [ApplicationControlPaths]::VerifySecurity($scopeDirectory, $true, $current.sid)
        [ApplicationControlPaths]::VerifySecurity($requestPath, $false, $current.sid)
        if ([IO.FileInfo]::new($requestPath).Length -gt 8192) { throw 'Application control request is too large' }
        $scope = [IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
        $caller = Read-Identity ([int]$scope.caller.pid)
        if ($scope.protocol -ne 1 -or $scope.nonce -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::GetFileName($scopeDirectory) -cne ('control-' + $scope.nonce) -or $scope.expiresAt -isnot [long] -and $scope.expiresAt -isnot [int] -or $scope.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -or $scope.expiresAt -gt ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 180000) -or $scope.scriptHash -cne (Get-OwnScriptHash)) { throw 'Application control request expired or changed' }
        if ($caller.sid -ne $current.sid -or $caller.session -ne $current.session -or $scope.caller.sid -ne $caller.sid -or $scope.caller.session -ne $caller.session -or $scope.caller.executable -ine $caller.executable -or $scope.caller.started -cne $caller.started) { throw 'Application control caller identity changed' }
        if ($scope.action -notin @('inspect', 'inventory', 'terminate', 'close', 'activate', 'request', 'peer', 'prepare')) { throw 'Invalid application control action' }
        $verifiedScope = $true
        $env:SIDEKICK_PROCESS_ACTION = [string]$scope.action
        $inputData = $scope.input
    }
    $operationOutput = & { switch ($env:SIDEKICK_PROCESS_ACTION) {
        'elevate' {
            if ($inputData.action -notin @('inspect', 'inventory', 'terminate', 'close', 'activate', 'request', 'peer', 'prepare')) { throw 'Invalid application control action' }
            $caller = Read-Identity ([int]$env:SIDEKICK_PROCESS_CALLER_PID)
            $nonce = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
            $directory = Join-Path $env:LOCALAPPDATA ('SidekickAI-Startup/coordination/control-' + $nonce)
            $null = [IO.Directory]::CreateDirectory($directory)
            $security = [Security.AccessControl.DirectorySecurity]::new()
            $security.SetAccessRuleProtection($true, $false)
            foreach ($sid in @($caller.sid, 'S-1-5-18', 'S-1-5-32-544')) { $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
            [IO.Directory]::SetAccessControl($directory, $security)
            $request = @{ protocol = 1; nonce = $nonce; expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 120000; caller = $caller; scriptHash = Get-OwnScriptHash; action = $inputData.action; input = $inputData.input }
            $requestPath = Join-Path $directory 'request.json'
            [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
            $parameters = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath.Replace('"','\"') + '" -RequestFile "' + $requestPath + '"'
            $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList $parameters -Verb RunAs -WindowStyle Hidden -PassThru
            if (-not $child.WaitForExit(110000)) { throw 'Application control authorization timed out' }
            if ($child.ExitCode -ne 0) { throw 'Application control request was refused' }
            $resultPath = Join-Path $directory 'result.json'
            if (-not [IO.File]::Exists($resultPath) -or (Get-Item -LiteralPath $resultPath).Length -gt 4194304) { throw 'Application control response is unavailable' }
            $answer = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
            if ($answer.nonce -cne $nonce -or $answer.protocol -ne 1) { throw 'Application control response identity changed' }
            if ($null -ne $answer.error) { throw [InvalidOperationException]::new([string]$answer.error) }
            [string]$answer.result
        }
        'prepare' { [SidekickApplicationProcess]::Prepare([string]$inputData.endpoint, [int]$inputData.server) | ConvertTo-Json -Compress }
        'inspect' { Read-ScopedIdentity ([int]$inputData.pid) | ConvertTo-Json -Compress }
        'inspect-image' { Read-Identity ([int]$inputData.pid) $false | ConvertTo-Json -Compress }
        'inventory' {
            $own = Read-Identity $PID
            $records = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -Filter "Name='SidekickAI.exe' OR Name='SidekickAI-OpenSource.exe'" | Where-Object { $_.SessionId -eq $own.session })
            $verified = @($records | ForEach-Object {
                $row = $_; $identity = Read-Identity ([int]$row.ProcessId)
                if ($null -ne $identity -and $identity.sid -eq $own.sid) {
                    @{ ProcessId = $identity.pid; ParentProcessId = $row.ParentProcessId; ExecutablePath = $identity.executable; CommandLine = $identity.commandLine; Started = $identity.started; Sid = $identity.sid; Session = $identity.session }
                }
            })
            ConvertTo-Json -InputObject $verified -Depth 4 -Compress
        }
        { $_ -in 'request', 'peer' } {
            $pipeName = ([string]$inputData.endpoint) -replace '^\\\\\.\\pipe\\', ''
            if ($pipeName -notmatch '^sidekick-editions-[a-f0-9]{24}$') { throw 'Invalid application endpoint' }
            $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
            try {
                $pipe.Connect(1000); [uint32]$serverPid = 0
                if (-not [SidekickApplicationProcess]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$serverPid)) { throw 'Cannot verify application endpoint' }
                if ($env:SIDEKICK_PROCESS_ACTION -eq 'peer') { Read-ScopedIdentity ([int]$serverPid) | ConvertTo-Json -Compress; break }
                $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 1024, $true); $writer.AutoFlush = $true
                $writer.WriteLine(($inputData.request | ConvertTo-Json -Compress))
                $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
                $pending = $reader.ReadLineAsync()
                if (-not $pending.Wait([int]$inputData.timeoutMs)) { throw [TimeoutException]::new('Application response timed out') }
                if ($pending.Result.Length -gt 4096) { throw 'Application response is too large' }
                $reply = $pending.Result | ConvertFrom-Json
                if ($reply.pid -ne $serverPid) { throw 'Application endpoint owner differs' }
                $reply | ConvertTo-Json -Depth 5 -Compress
            } finally { $pipe.Dispose() }
        }
        { $_ -in 'activate', 'close', 'terminate' } {
            $action = $env:SIDEKICK_PROCESS_ACTION
            $owner = [SidekickApplicationProcess]::new([int]$inputData.pid, $action -eq 'terminate', $true)
            try {
                if ($owner.Exited) { @{ stopped = $true; activated = $false } | ConvertTo-Json -Compress; break }
                $owner.Verify([string]$inputData.executable, [string]$inputData.started, [string]$inputData.sid, [int]$inputData.session)
                $identity = Read-PackageIdentity $owner.executable
                $expectedName = if ($inputData.edition -eq 'community') { 'sidekick-ai' } elseif ($inputData.edition -eq 'concept') { 'sidekickai-opensource' } else { throw 'Unknown application edition' }
                if ($identity.name -cne $expectedName -or $identity.version -cne $inputData.version) { throw 'Application package identity changed' }
                if ($action -eq 'terminate') {
                    $records = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $_.SessionId -eq $owner.session })
                    $children = Read-OwnedChildren $owner $records
                    try {
                        $owner.Terminate()
                        foreach ($child in $children) { $child.Terminate() }
                        $wait = [Diagnostics.Stopwatch]::StartNew()
                        while (-not $owner.Exited -or @($children | Where-Object { -not $_.Exited }).Count -gt 0) {
                            if ($wait.ElapsedMilliseconds -ge 5000) { throw 'Application processes did not exit' }
                            Start-Sleep -Milliseconds 50
                        }
                    } finally { foreach ($child in $children) { $child.Dispose() } }
                    @{ stopped = $true } | ConvertTo-Json -Compress
                } else {
                    $target = Get-Process -Id $owner.pid -ErrorAction Stop
                    $activated = $target.Responding -and $target.MainWindowHandle -ne 0
                    if ($action -eq 'close') { $null = $target.CloseMainWindow() }
                    elseif ($activated) { $null = [SidekickApplicationProcess]::ShowWindowAsync($target.MainWindowHandle, 9); $null = [SidekickApplicationProcess]::SetForegroundWindow($target.MainWindowHandle) }
                    @{ activated = $activated } | ConvertTo-Json -Compress
                }
            } finally { $owner.Dispose() }
        }
        default { throw 'Unknown application process operation' }
    } }
    if ($null -ne $scope) {
        $response = @{ protocol = 1; nonce = $scope.nonce; result = [string]$operationOutput; error = $null }
        [ApplicationControlPaths]::WriteResponse($scopeDirectory, ($response | ConvertTo-Json -Depth 6 -Compress))
    } else { $operationOutput }
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $code = if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 5) { 'access-denied' } elseif ($failure -is [TimeoutException]) { 'timeout' } elseif ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1223) { 'authorization-cancelled' } elseif ($failure -is [IO.IOException]) { 'unavailable' } else { 'identity-mismatch' }
    if ($verifiedScope) {
        try { [ApplicationControlPaths]::WriteResponse($scopeDirectory, (@{ protocol = 1; nonce = $scope.nonce; result = $null; error = $failure.Message } | ConvertTo-Json -Compress)) }
        catch { [Console]::Error.WriteLine('Application control response was refused') }
    } else { @{ error = $code; message = $failure.Message } | ConvertTo-Json -Compress }
    exit 1
} finally { if ($null -ne $protectedPaths) { $protectedPaths.Dispose() } }
