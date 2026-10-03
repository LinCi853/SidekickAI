'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const EXECUTABLE = 'SidekickStartup.exe'
const SCRIPT = 'application-process.ps1'
const CONFIGURATION = Buffer.from('<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><loadFromRemoteSources enabled="false"/></runtime></configuration>\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const digestFile = file => digest(fs.readFileSync(file))
const SOURCE_FILES = ['resources/windows/' + SCRIPT, 'tools/startup-helper/StartupHelper.cs',
  'tools/startup-helper/NativeInventory.cs', 'scripts/build-startup-helper.cjs']
const sourceInputs = root => SOURCE_FILES.map(relative => ({ path: relative, sha256: digestFile(path.join(root, relative)) }))
const quote = value => "'" + value.replaceAll("'", "''") + "'"

function compilerPath() {
  const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  if (!fs.existsSync(compiler)) throw new Error('The Windows .NET Framework compiler is required for the startup helper')
  return compiler
}

function verifyManagedArchitecture(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid managed startup executable')
  const pe = bytes.readUInt32LE(60)
  if (pe > bytes.length - 248 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x14c) throw new Error('Startup helper must use portable CLR PE format')
  const optional = pe + 24, size = bytes.readUInt16LE(pe + 20)
  if (bytes.readUInt16LE(optional) !== 0x10b || size < 224) throw new Error('Invalid startup CLR directory')
  const clrRva = bytes.readUInt32LE(optional + 96 + 14 * 8)
  const count = bytes.readUInt16LE(pe + 6)
  let clr = -1
  for (let index = 0; index < count; index++) {
    const section = optional + size + index * 40
    if (section + 40 > bytes.length) throw new Error('Invalid startup section table')
    const rva = bytes.readUInt32LE(section + 12), rawSize = bytes.readUInt32LE(section + 16), raw = bytes.readUInt32LE(section + 20)
    if (clrRva >= rva && clrRva - rva + 20 <= rawSize) clr = raw + clrRva - rva
  }
  if (clr < 0 || clr + 20 > bytes.length) throw new Error('Startup executable has no CLR header')
  const flags = bytes.readUInt32LE(clr + 16)
  if (!(flags & 1) || (flags & 2) || (flags & 0x20000)) throw new Error('Startup executable must be IL-only AnyCPU without 32-bit preference')
  return { format: 'managed-il', architecture: 'anycpu', clrFlags: flags }
}

function verifyResources(directory, options = {}) {
  for (const name of [EXECUTABLE, EXECUTABLE + '.config', 'startup-helper.json', SCRIPT]) {
    const stat = fs.lstatSync(path.join(directory, name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 1024 * 1024) throw new Error('Invalid startup helper resource')
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'startup-helper.json'), 'utf8'))
  if (manifest.protocol !== 1 || manifest.runtime !== 'net-framework-4' || manifest.architecture !== 'anycpu'
    || manifest.executable !== EXECUTABLE || manifest.configSha256 !== digest(CONFIGURATION)
    || !['sha256', 'compilerSha256', 'sourceSha256'].every(key => /^[a-f0-9]{64}$/.test(manifest[key]))
    || manifest.sha256 !== digestFile(path.join(directory, EXECUTABLE))
    || !fs.readFileSync(path.join(directory, EXECUTABLE + '.config')).equals(CONFIGURATION)
    || manifest.scripts?.[SCRIPT] !== digestFile(path.join(directory, SCRIPT))) throw new Error('Startup helper digest or identity mismatch')
  if (options.root) {
    const expected = sourceInputs(options.root)
    if (manifest.sourceSha256 !== digest(JSON.stringify(expected)) || JSON.stringify(manifest.sources) !== JSON.stringify(expected)) throw new Error('Startup helper does not match reviewed source')
  }
  return { ...manifest, ...verifyManagedArchitecture(fs.readFileSync(path.join(directory, EXECUTABLE))) }
}

function build(options = {}) {
  const root = options.root || ROOT, compiler = compilerPath()
  const compilerSha256 = digestFile(compiler), sources = sourceInputs(root)
  const sourceSha256 = digest(JSON.stringify(sources))
  const directory = path.join(root, 'build/native-startup')
  let reused = false
  try { reused = verifyResources(directory, { root }).compilerSha256 === compilerSha256 } catch {}
  if (!reused) {
    try {
      const packaged = verifyResources(path.join(root, 'resources/windows'), { root })
      if (packaged.compilerSha256 !== compilerSha256 || packaged.sourceSha256 !== sourceSha256) throw new Error('Packaged helper provenance differs')
      fs.mkdirSync(directory, { recursive: true })
      for (const name of [EXECUTABLE, EXECUTABLE + '.config', 'startup-helper.json', SCRIPT]) {
        fs.copyFileSync(path.join(root, 'resources/windows', name), path.join(directory, name))
      }
      verifyResources(directory, { root })
      reused = true
    } catch {}
  }
  if (!reused) {
    fs.mkdirSync(directory, { recursive: true })
    const script = path.join(root, 'resources/windows', SCRIPT)
    const expression = `$errors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Script parse failed'};$commands=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type'},$false));if($commands.Count -ne 1){throw 'Unexpected native definitions'};$strings=@($commands[0].CommandElements | Where-Object {$_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.StringConstantType -eq 'SingleQuotedHereString'});if($strings.Count -ne 1){throw 'Unexpected native source'};[Console]::Write($strings[0].Value)`
    const extracted = spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(expression, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    if (extracted.error || extracted.status !== 0) throw extracted.error || new Error(extracted.stderr || 'Startup source extraction failed')
    const generated = path.join(directory, SCRIPT + '.cs')
    fs.writeFileSync(generated, extracted.stdout)
    const target = path.join(directory, EXECUTABLE)
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/main:StartupHelper', '/platform:anycpu', '/optimize+',
      '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Security.dll', '/reference:System.Web.Extensions.dll',
      '/out:' + target, generated, ...SOURCE_FILES.filter(relative => relative.endsWith('.cs')).map(relative => path.join(root, relative))],
      { stdio: 'inherit', windowsHide: true, timeout: 30000, env: { ...process.env, LIB: '', LIBPATH: '' } })
    if (result.error || result.status !== 0) throw result.error || new Error('Startup helper compilation failed')
    if (JSON.stringify(sources) !== JSON.stringify(sourceInputs(root))) throw new Error('Startup source changed during compilation')
    fs.writeFileSync(target + '.config', CONFIGURATION)
    fs.copyFileSync(script, path.join(directory, SCRIPT))
    fs.writeFileSync(path.join(directory, 'startup-helper.json'), JSON.stringify({ protocol: 1, runtime: 'net-framework-4', architecture: 'anycpu', executable: EXECUTABLE,
      sha256: digestFile(target), configSha256: digest(CONFIGURATION), compilerSha256, sourceSha256, sources,
      scripts: { [SCRIPT]: digestFile(script) } }, null, 2) + '\n')
    verifyResources(directory, { root })
  }
  if (options.resources) {
    const resources = path.join(root, 'resources/windows')
    for (const name of [EXECUTABLE, EXECUTABLE + '.config', 'startup-helper.json']) {
      const source = path.join(directory, name), target = path.join(resources, name)
      if (!fs.existsSync(target) || digestFile(source) !== digestFile(target)) fs.copyFileSync(source, target)
    }
    verifyResources(resources, { root })
  }
  return { directory, reused, ...verifyResources(directory, { root }) }
}

module.exports = { build, verifyResources, verifyManagedArchitecture, compilerPath, SOURCE_FILES, EXECUTABLE, CONFIGURATION }
if (require.main === module) console.log(JSON.stringify(build({ resources: process.argv.includes('--resources') }), null, 2))
