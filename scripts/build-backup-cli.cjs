const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')
const workspace = path.resolve(__dirname, '..')
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(workspace, 'build/backup-tools/sidekick-backup.cjs')
fs.mkdirSync(path.dirname(output), { recursive: true })
esbuild.build({
  stdin: { contents: `import { runBackupCli } from './packages/backup-core/cli'; runBackupCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result && result.success === false) process.exitCode = 1; }).catch(error => { console.error(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1; });`, resolveDir: workspace },
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: output, external: ['electron', 'better-sqlite3'], logLevel: 'warning',
}).then(() => console.log(output)).catch(error => { console.error(error); process.exitCode = 1 })
