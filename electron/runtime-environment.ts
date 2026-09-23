import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const applicationName = 'sidekickai-opensource'
app.setName(applicationName)
if (process.platform === 'win32') app.setAppUserModelId('com.sidekickai.opensource')

const override = process.env.SIDEKICK_DATA_DIR
if (override && !path.isAbsolute(override)) throw new Error('SIDEKICK_DATA_DIR must be an absolute path')
const executableDirectory = path.dirname(app.getPath('exe'))
const directory = override || (
  process.env.ELECTRON_RENDERER_URL
    ? path.resolve(__dirname, '../..', '.app-data')
    : existsSync(path.join(executableDirectory, 'portable.txt'))
      ? path.join(executableDirectory, 'data')
      : path.join(app.getPath('appData'), applicationName)
)
mkdirSync(directory, { recursive: true })
app.setPath('userData', directory)
app.setPath('sessionData', directory)

const exportArgument = process.argv.indexOf('--export-user-data')
const exportPath = exportArgument < 0 ? undefined : process.argv[exportArgument + 1]
export const exportCliRequestPath = exportPath && !exportPath.startsWith('--') ? exportPath : null

if (!exportCliRequestPath && !app.requestSingleInstanceLock()) app.exit(0)
