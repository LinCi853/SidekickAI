const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const triples = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }

function parseEnvironment(text) {
  const marker = '__SIDEKICK_TOOLCHAIN_ENV__'
  const offset = text.lastIndexOf(marker)
  if (offset < 0) throw new Error('Visual Studio did not emit its compiler environment')
  const environment = {}
  for (const line of text.slice(offset + marker.length).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return environment
}

function findVisualStudios() {
  const base = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
  const finder = path.join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!fs.existsSync(finder)) throw new Error('Visual Studio Installer was not found. Install the Desktop development with C++ workload and MSVC ARM64/ARM64EC tools.')
  const result = spawnSync(finder, ['-all', '-prerelease', '-products', '*', '-format', 'json'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.error?.message || 'Unable to locate Visual Studio installations')
  return JSON.parse(result.stdout).map(instance => instance.installationPath).filter(Boolean)
}

function missingComponent(arch, installation, detail) {
  const component = arch === 'arm64' ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  return new Error(`Windows ${arch} compiler environment is unavailable at ${installation}. ${detail}. Use Visual Studio Installer > Modify > Individual components > ${arch === 'arm64' ? 'MSVC Build Tools for ARM64/ARM64EC' : 'MSVC x64/x86 build tools'}. Component ID: ${component}. This is not an Electron cache problem.`)
}

function loadMsvcEnvironment(arch, options = {}) {
  if (!triples[arch]) throw new Error(`Unsupported Windows architecture: ${arch}`)
  const installations = options.installations || findVisualStudios()
  if (!installations.length) throw new Error('No Visual Studio installation was found, including preview installations')
  const errors = []
  for (const installation of installations) {
    try {
      if (/["\r\n%]/.test(installation)) throw new Error('Unsupported Visual Studio installation path')
      const commandFile = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')
      if (!fs.existsSync(commandFile)) throw missingComponent(arch, installation, 'VsDevCmd.bat is missing')
      const command = `call "${commandFile}" -no_logo -host_arch=x64 -arch=${arch} >nul && echo __SIDEKICK_TOOLCHAIN_ENV__ && set`
      const configured = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 60000 })
      if (configured.status !== 0) throw missingComponent(arch, installation, 'VsDevCmd could not configure the target')
      const environment = parseEnvironment(configured.stdout)
      const toolDirectory = environment.VCToolsInstallDir
      const linker = toolDirectory && path.join(toolDirectory, 'bin', 'Hostx64', arch, 'link.exe')
      const compiler = toolDirectory && path.join(toolDirectory, 'bin', 'Hostx64', arch, 'cl.exe')
      const runtime = toolDirectory && path.join(toolDirectory, 'lib', arch, 'msvcrt.lib')
      for (const file of [linker, compiler, runtime]) {
        if (!file || !fs.existsSync(file)) throw missingComponent(arch, installation, `Missing ${file || 'VCToolsInstallDir'}`)
      }
      const libraries = (environment.LIB || '').split(';').filter(Boolean)
      for (const required of ['kernel32.lib', 'ucrt.lib']) {
        if (!libraries.some(directory => fs.existsSync(path.join(directory, required)))) throw missingComponent(arch, installation, `Windows SDK ${required} is unavailable`)
      }
      environment[`CARGO_TARGET_${triples[arch].toUpperCase().replaceAll('-', '_')}_LINKER`] = linker
      environment[`CC_${triples[arch].replaceAll('-', '_')}`] = compiler
      environment[`CXX_${triples[arch].replaceAll('-', '_')}`] = compiler
      return { installation, arch, linker, environment }
    } catch (error) { errors.push(error.message) }
  }
  throw new Error(errors.join('\n'))
}

module.exports = { triples, findVisualStudios, loadMsvcEnvironment, parseEnvironment }
