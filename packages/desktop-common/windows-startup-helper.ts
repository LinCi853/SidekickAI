import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const CONFIGURATION = '<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><loadFromRemoteSources enabled="false"/></runtime></configuration>\n'
const OPERATIONS = new Set(['session', 'inspect', 'inspect-image', 'inventory', 'prepare-session'])
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export function windowsStartupHelper(resourcesPath: string, input: Record<string, unknown>): { executable: string; args: string[] } {
  if (typeof input.operation !== 'string' || !OPERATIONS.has(input.operation)) throw new Error('Unsupported Windows startup operation')
  const directory = path.join(resourcesPath, 'windows')
  const read = (name: string): Buffer => {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid Windows startup helper resource')
    return fs.readFileSync(file)
  }
  const manifest = JSON.parse(read('startup-helper.json').toString('utf8')) as {
    protocol: number; runtime: string; architecture: string; executable: string; sha256: string; configSha256: string; scripts: Record<string, string>
  }
  if (manifest.protocol !== 1 || manifest.runtime !== 'net-framework-4' || manifest.architecture !== 'anycpu'
    || manifest.executable !== 'SidekickStartup.exe' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || digest(read('SidekickStartup.exe')) !== manifest.sha256
    || read('SidekickStartup.exe.config').toString('utf8') !== CONFIGURATION || manifest.configSha256 !== digest(CONFIGURATION)
    || digest(read('application-process.ps1')) !== manifest.scripts?.['application-process.ps1']) throw new Error('Windows startup helper does not match application resources')
  const request = Buffer.from(JSON.stringify(input))
  if (request.length > 16384) throw new Error('Windows startup request is too large')
  return { executable: path.join(directory, 'SidekickStartup.exe'), args: [request.toString('base64')] }
}
