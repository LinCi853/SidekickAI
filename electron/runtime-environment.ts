import { product, edition } from '../packages/product-contract'
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveRuntimePaths } from './runtime-paths'
import { applyPendingRestore, type RestoreOutcome } from '../packages/backup-core/transaction.js'
import { prepareLimitedRestore, prepareFullRestore } from './store/backup/transfer-adapter.js'
import { cookieHelperRequestPath, initializeCookieHelper } from '../packages/backup-core/sessions.js'

const applicationName = edition.packageName
app.setName(product.name)
if (process.platform === 'win32') app.setAppUserModelId(edition.appId)

if (app.isPackaged) delete process.env.ELECTRON_RENDERER_URL
export const runtimePaths = resolveRuntimePaths({
  isPackaged: app.isPackaged,
  executable: app.getPath('exe'),
  appData: app.getPath('appData'),
  developmentDirectory: path.resolve(__dirname, '../..', '.app-data'),
  dataOverride: process.env.SIDEKICK_DATA_DIR,
})
const exportArgument = process.argv.indexOf('--export-user-data')
const exportPath = exportArgument < 0 ? undefined : process.argv[exportArgument + 1]
export const exportCliRequestPath = exportPath && !exportPath.startsWith('--') ? exportPath : null
export const startupRestore: RestoreOutcome = (() => {
  try {
    if (cookieHelperRequestPath) { initializeCookieHelper(); return { restored: false } }
    return initializeDataRoot()
  } catch (error) {
    dialog.showErrorBox('应用数据操作失败', `启动已中止，请先处理文件占用或目录权限后重新启动。\n${(error as Error).message}`)
    app.exit(1)
    throw error
  }
})()

function initializeDataRoot(): RestoreOutcome {
  const directory = runtimePaths.dataDirectory
  if (!exportCliRequestPath) {
    const instanceRoot = `${directory}.instance`
    mkdirSync(instanceRoot, { recursive: true })
    app.setPath('userData', instanceRoot)
    if (!app.requestSingleInstanceLock()) {
      app.exit(0)
    }
  }
  const restored = exportCliRequestPath ? { restored: false } : applyPendingRestore(directory, prepareLimitedRestore, prepareFullRestore)
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
  app.setPath('sessionData', exportCliRequestPath ? mkdtempSync(path.join(app.getPath('temp'), 'sidekick-export-session-')) : directory)
  const identityPath = path.join(directory, 'edition-identity.json')
  if (existsSync(identityPath)) {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
    if (identity.edition !== applicationName || identity.schema !== 1) throw new Error('User data belongs to another edition')
  } else if (!exportCliRequestPath) {
    writeFileSync(identityPath, JSON.stringify({ edition: applicationName, schema: 1 }), { flag: 'wx' })
  }
  return restored
}
