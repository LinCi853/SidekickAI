'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { build, verifyResources } = require('./build-startup-helper.cjs')
const windows = process.platform === 'win32'
const root = path.resolve(__dirname, '..')
const output = windows ? build() : null
const executable = output && path.join(output.directory, output.executable)
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const inputArguments = input => [Buffer.from(JSON.stringify(input)).toString('base64')]

function invoke(input) {
  const started = performance.now()
  const result = spawnSync(executable, inputArguments(input), { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert(!result.error, String(result.error))
  return { code: result.status, value: JSON.parse(result.stdout), elapsedMs: performance.now() - started }
}

function original(action, input) {
  const started = performance.now()
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(output.directory, 'application-process.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, LIB: '', LIBPATH: '', SIDEKICK_PROCESS_ACTION: action,
      SIDEKICK_PROCESS_INPUT: JSON.stringify(input), SIDEKICK_PROCESS_CALLER_PID: String(process.pid) } })
  assert(!result.error, String(result.error))
  assert.equal(result.status, 0, result.stderr)
  return { value: JSON.parse(result.stdout), elapsedMs: performance.now() - started }
}

function privateDirectory(prefix) {
  return fs.mkdtempSync(path.join(root, 'build', prefix))
}

test('compiled identity and session match standalone checks under the same process', { skip: !windows }, () => {
  const measurements = []
  for (let round = 0; round < 3; round++) {
    const baseline = round % 2 === 0 ? original('inspect', { pid: process.pid }) : null
    const native = invoke({ operation: 'inspect', pid: process.pid })
    const comparison = baseline || original('inspect', { pid: process.pid })
    assert.equal(native.code, 0)
    assert.deepEqual(native.value, comparison.value)
    assert.equal(invoke({ operation: 'session', pid: process.pid }).value, native.value.session)
    const image = invoke({ operation: 'inspect-image', pid: process.pid })
    assert.deepEqual(image.value, original('inspect-image', { pid: process.pid }).value)
    measurements.push({ round, nativeMs: native.elapsedMs, powershellMs: comparison.elapsedMs })
  }
  fs.writeFileSync(path.join(output.directory, 'comparison.json'), JSON.stringify({ process: process.pid, helperSha256: output.sha256,
    sourceSha256: output.sourceSha256, scriptSha256: output.scripts['application-process.ps1'], measurements }, null, 2) + '\n')
})

test('identity and inventory preserve the exact private executable and Unicode path', { skip: !windows, timeout: 20000 }, async () => {
  const directory = privateDirectory('startup-identity-')
  const location = path.join(directory, '\u8eab\u4efd\u9a8c\u8bc1')
  fs.mkdirSync(location)
  const node = path.join(location, 'SidekickAI.exe')
  fs.copyFileSync(process.execPath, node)
  let child
  try {
    child = spawn(node, ['-e', "process.stdout.write('ready');process.stdin.resume();process.stdin.once('data',()=>process.exit(0));"],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise(resolve => child.once('exit', resolve))
    const closed = new Promise(resolve => child.once('close', resolve))
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    const native = invoke({ operation: 'inspect', pid: child.pid })
    assert.equal(native.code, 0, native.value.message)
    assert.equal(native.value.executable.toLowerCase(), node.toLowerCase())
    assert(native.value.commandLine.includes(location))
    assert.deepEqual(native.value, original('inspect', { pid: child.pid }).value)
    const inventory = invoke({ operation: 'inventory' })
    assert.equal(inventory.code, 0, inventory.value.message)
    assert(Array.isArray(inventory.value), 'Native inventory must return an array')
    const row = inventory.value.find(entry => entry.ProcessId === child.pid)
    assert(row, 'Private process is absent from native inventory')
    const baseline = original('inventory', {}).value.find(entry => entry.ProcessId === child.pid)
    assert.deepEqual(row, baseline)
    assert.equal(row.ParentProcessId, process.pid)
    child.stdin.write('quit')
    await exited
    await closed
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve))
      child.kill()
      await closed
    }
    fs.rmSync(directory, { recursive: true })
  }
})

test('compiled entry refuses mutation commands and invalid process identities', { skip: !windows }, () => {
  for (const input of [{ operation: 'terminate', pid: process.pid }, { operation: 'elevate' }, { operation: 'task' },
    { operation: 'run' }, { operation: 'inspect', pid: 0 }, { operation: 'inspect', pid: String(process.pid) },
    { operation: 'prepare-session', endpoint: 'foreign', server: process.pid }]) {
    const result = invoke(input)
    assert.equal(result.code, 1)
    assert.equal(result.value.error, 'identity-mismatch')
  }
})

const descriptorReader = `param([string]$Endpoint)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
public static class PipeDescriptor {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,uint type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint information,out IntPtr value,out uint length);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string Read(string endpoint) {
  IntPtr pipe=CreateFile(endpoint,0x20000,0,IntPtr.Zero,3,0,IntPtr.Zero);
  if(pipe==new IntPtr(-1)) throw new InvalidOperationException("Cannot inspect private pipe");
  IntPtr owner,group,dacl,sacl,descriptor=IntPtr.Zero,encoded=IntPtr.Zero;uint length;
  try {
   if(GetSecurityInfo(pipe,6,7,out owner,out group,out dacl,out sacl,out descriptor)!=0) throw new InvalidOperationException("Cannot inspect private pipe security");
   if(!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,7,out encoded,out length)) throw new InvalidOperationException("Cannot decode private pipe security");
   return Marshal.PtrToStringUni(encoded);
  } finally {if(encoded!=IntPtr.Zero)LocalFree(encoded);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);CloseHandle(pipe);}
 }
}
'@
$security=[Security.AccessControl.RawSecurityDescriptor]::new([PipeDescriptor]::Read($Endpoint))
$aces=@($security.DiscretionaryAcl | ForEach-Object {
 if($_ -isnot [Security.AccessControl.CommonAce]) {throw 'Unsupported private pipe ACE'}
 @{sid=$_.SecurityIdentifier.Value;access=$_.AccessMask;qualifier=[string]$_.AceQualifier;flags=[string]$_.AceFlags}
})
@{owner=$security.Owner.Value;group=$security.Group.Value;aces=$aces}|ConvertTo-Json -Depth 4 -Compress
`

test('account pipe preparation preserves descriptor scope and rejects a forged server', { skip: !windows, timeout: 20000 }, async () => {
  const directory = privateDirectory('startup-pipe-')
  const reader = path.join(directory, 'read-private-descriptor.ps1')
  fs.writeFileSync(reader, descriptorReader)
  const endpoint = '\\\\.\\pipe\\sidekick-editions-' + crypto.randomBytes(12).toString('hex')
  const sockets = new Set()
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(endpoint, resolve))
  const read = () => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader, '-Endpoint', endpoint],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, LIB: '', LIBPATH: '' } })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const recycleConnections = async () => {
    await new Promise(resolve => setImmediate(resolve))
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => setImmediate(resolve))
  }
  try {
    const before = read()
    await recycleConnections()
    const prepared = invoke({ operation: 'prepare-session', endpoint, server: process.pid })
    assert.equal(prepared.code, 0, prepared.value.message)
    assert.deepEqual(prepared.value, { prepared: true, pid: process.pid })
    await recycleConnections()
    const after = read()
    await recycleConnections()
    assert.equal(after.owner, before.owner)
    assert.equal(after.group, before.group)
    const sid = invoke({ operation: 'inspect', pid: process.pid }).value.sid
    const required = 0x12019f
    assert(after.aces.some(ace => ace.sid === sid && ace.qualifier === 'AccessAllowed' && (ace.access & required) === required))
    const additions = after.aces.filter(ace => !before.aces.some(previous => JSON.stringify(previous) === JSON.stringify(ace)))
    assert(additions.every(ace => ace.sid === sid && ace.access === required && ace.qualifier === 'AccessAllowed'))
    assert(before.aces.every(ace => after.aces.some(next => JSON.stringify(next) === JSON.stringify(ace))))
    assert.deepEqual(original('prepare', { endpoint, server: process.pid }).value, prepared.value)
    await recycleConnections()
    assert.deepEqual(read(), after)
    await recycleConnections()
    assert.equal(invoke({ operation: 'prepare-session', endpoint, server: 4 }).code, 1)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true })
  }
})

test('cache miss reuses fully verified packaged helper bytes', { skip: !windows }, () => {
  const directory = privateDirectory('startup-cache-')
  const fixtureRoot = path.join(directory, 'workspace')
  const names = ['SidekickStartup.exe', 'SidekickStartup.exe.config', 'startup-helper.json', 'application-process.ps1']
  try {
    for (const relative of ['resources/windows', 'tools/startup-helper', 'scripts']) fs.mkdirSync(path.join(fixtureRoot, relative), { recursive: true })
    for (const name of names) fs.copyFileSync(path.join(output.directory, name), path.join(fixtureRoot, 'resources/windows', name))
    for (const relative of ['tools/startup-helper/StartupHelper.cs', 'tools/startup-helper/NativeInventory.cs', 'scripts/build-startup-helper.cjs']) {
      fs.copyFileSync(path.join(root, relative), path.join(fixtureRoot, relative))
    }
    const result = build({ root: fixtureRoot })
    assert.equal(result.reused, true)
    for (const name of names) assert.equal(fs.readFileSync(path.join(fixtureRoot, 'resources/windows', name)).equals(fs.readFileSync(path.join(fixtureRoot, 'build/native-startup', name))), true)
    assert.equal(verifyResources(path.join(fixtureRoot, 'build/native-startup'), { root: fixtureRoot }).compilerSha256, result.compilerSha256)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('packaging rejects changed or absent helper resources and changed source bindings', { skip: !windows }, () => {
  const directory = privateDirectory('startup-resource-')
  const names = ['SidekickStartup.exe', 'SidekickStartup.exe.config', 'startup-helper.json', 'application-process.ps1']
  try {
    for (const name of names) fs.copyFileSync(path.join(output.directory, name), path.join(directory, name))
    assert.equal(verifyResources(directory, { root }).architecture, 'anycpu')
    for (const name of ['SidekickStartup.exe', 'SidekickStartup.exe.config', 'application-process.ps1']) {
      fs.appendFileSync(path.join(directory, name), 'changed')
      assert.throws(() => verifyResources(directory), /digest/)
      fs.copyFileSync(path.join(output.directory, name), path.join(directory, name))
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'startup-helper.json')))
    manifest.sources[1].sha256 = '0'.repeat(64)
    fs.writeFileSync(path.join(directory, 'startup-helper.json'), JSON.stringify(manifest))
    assert.throws(() => verifyResources(directory, { root }), /reviewed source/)
    fs.copyFileSync(path.join(output.directory, 'startup-helper.json'), path.join(directory, 'startup-helper.json'))
    fs.unlinkSync(path.join(directory, 'SidekickStartup.exe'))
    assert.throws(() => verifyResources(directory))
  } finally { fs.rmSync(directory, { recursive: true }) }
})
