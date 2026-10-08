'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { build } = require('esbuild')
const yazl = require('yazl')
const root = path.resolve(__dirname, '..')
const contract = require('../packages/backup-core/runtime-manifest.json')
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function bundledNotices(metafiles) {
  const directories = new Set()
  for (const metadata of metafiles) for (const input of Object.keys(metadata.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
    let directory = path.dirname(path.resolve(root, input))
    while (directory !== root && !fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory)
    if (directory !== root) directories.add(directory)
  }
  return [...directories].sort().map(directory => {
    const info = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const licenses = fs.readdirSync(directory).filter(name => /^(license|copying)(\.|$)/i.test(name))
    if (!licenses.length) throw new Error(`Missing redistribution license: ${info.name}`)
    return `${info.name} ${info.version} (${info.license || 'See license'})\n\n${licenses.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n')}\n`
  }).join('\n----------------------------------------\n\n')
}

async function prepare(arch) {
  if (!Object.hasOwn(contract.architectures, arch)) throw new Error('Unsupported backup runtime architecture')
  const directory = path.join(root, 'build/backup-runtime', arch)
  fs.mkdirSync(directory, { recursive: true })
  const executable = path.join(directory, 'node.exe')
  if (!fs.existsSync(executable) || digest(executable) !== contract.architectures[arch]) {
    const response = await fetch(`https://nodejs.org/dist/v${contract.nodeVersion}/win-${arch}/node.exe`)
    if (!response.ok || !response.body) throw new Error(`Cannot download the pinned recovery runtime: ${response.status}`)
    const scratch = `${executable}.download`
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(scratch))
    if (digest(scratch) !== contract.architectures[arch]) throw new Error('Recovery runtime digest mismatch')
    fs.renameSync(scratch, executable)
  }
  const license = path.join(directory, 'LICENSE.txt')
  if (!fs.existsSync(license)) {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${contract.nodeVersion}/LICENSE`)
    if (!response.ok) throw new Error('Cannot obtain the Node.js redistribution license')
    fs.writeFileSync(license, await response.text())
  }
  const output = await build({ stdin: { contents: `
    import fs from 'node:fs';
    import { exportOfflineBackup } from './packages/backup-core/offline.ts';
    const parts = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Export request too large'); parts.push(chunk); }
    const raw = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const request = { ...raw, tempRoot: raw.tempRoot || undefined, password: raw.password || undefined };
    const result = await exportOfflineBackup(request);
    fs.writeFileSync(request.resultPath, JSON.stringify({ ...result, ok: result.success }));
    process.exitCode = result.success ? 0 : 1;
  `, resolveDir: root }, bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true })
  const dependencies = output.metafile.outputs[Object.keys(output.metafile.outputs)[0]].imports
  if (dependencies.some(entry => entry.path === 'electron' || entry.path === 'better-sqlite3')) throw new Error('Independent recovery runtime depends on the installed application')
  const source = output.outputFiles[0].text
  // Bundled CommonJS dependencies use the standard Node require bridge.
  const esm = path.join(directory, 'export.mjs')
  fs.writeFileSync(esm, `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${source}`)
  const recovery = await build({ stdin: { contents: `
    import { runBackupCli } from './packages/backup-core/cli.ts';
    runBackupCli(process.argv.slice(2)).then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result?.success === false) process.exitCode = 1;
    }).catch(error => { console.error(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1; });
  `, resolveDir: root }, bundle: true, platform: 'node', target: 'node24', format: 'cjs', write: false, metafile: true })
  fs.writeFileSync(path.join(directory, 'sidekick-backup.cjs'), recovery.outputFiles[0].contents)
  fs.writeFileSync(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), bundledNotices([output.metafile, recovery.metafile]))
  for (const name of ['FORMAT.md', 'sabk-v1-vector.json']) fs.copyFileSync(path.join(root, 'packages/backup-core', name), path.join(directory, name))
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'SidekickAI-LICENSE.txt'))
  const names = ['node.exe', 'export.mjs', 'sidekick-backup.cjs', 'FORMAT.md', 'sabk-v1-vector.json', 'LICENSE.txt', 'SidekickAI-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']
  const manifest = { nodeVersion: contract.nodeVersion, arch, executableSha256: digest(executable), scriptSha256: digest(esm),
    files: Object.fromEntries(names.map(name => [name, digest(path.join(directory, name))])) }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const archive = path.join(root, 'build/backup-runtime', `win-${arch}.zip`)
  const zip = new yazl.ZipFile()
  const completion = pipeline(zip.outputStream, fs.createWriteStream(`${archive}.tmp`))
  for (const name of [...names, 'manifest.json']) zip.addFile(path.join(directory, name), name, { mtime: new Date('2026-01-01T00:00:00Z') })
  zip.end(); await completion
  fs.renameSync(`${archive}.tmp`, archive)
  return archive
}

if (require.main === module) Promise.all((process.argv.slice(2).length ? process.argv.slice(2) : ['x64', 'arm64']).map(prepare))
  .then(files => files.forEach(file => console.log(file))).catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { prepare }
