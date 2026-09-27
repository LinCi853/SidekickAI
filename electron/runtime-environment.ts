import { product, edition } from '../packages/product-contract'
import { app, dialog } from 'electron'
import { duplicateVersionNotice } from '../packages/desktop-common/running-application'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveRuntimePaths } from './runtime-paths'

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
const directory = runtimePaths.dataDirectory
mkdirSync(directory, { recursive: true })
app.setPath('userData', directory)
app.setPath('sessionData', directory)

const exportArgument = process.argv.indexOf('--export-user-data')
const exportPath = exportArgument < 0 ? undefined : process.argv[exportArgument + 1]
export const exportCliRequestPath = exportPath && !exportPath.startsWith('--') ? exportPath : null
if (exportCliRequestPath) app.setPath('sessionData', mkdtempSync(path.join(app.getPath('temp'), 'sidekick-export-session-')))

if (!app.requestSingleInstanceLock()) {
  if (app.isPackaged) {
    try {
      const notice = duplicateVersionNotice()
      if (notice) dialog.showErrorBox('已有版本正在运行', notice)
    } catch { dialog.showErrorBox('无法核对正在运行的版本', '请先保存并退出已有工百窗实例，再重新启动。') }
  }
  app.exit(0)
}
const identityPath = path.join(directory, 'edition-identity.json')
if (existsSync(identityPath)) {
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
  if (identity.edition !== applicationName || identity.schema !== 1) throw new Error('User data belongs to another edition')
} else if (!exportCliRequestPath) {
  writeFileSync(identityPath, JSON.stringify({ edition: applicationName, schema: 1 }), { flag: 'wx' })
}
