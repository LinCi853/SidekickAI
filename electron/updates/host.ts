import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { copyFile } from 'node:fs/promises'
import { constants, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { __dirname as mainDirectory } from '../window-factory/paths.js'
import { isPortableMode } from '../store/store-paths.js'
import { windowState } from '../window-state.js'
import { compareVersions, releaseChannels } from './contract.js'
import { distributionOrigin, fetchReleases } from './catalog.js'
import { createSequences, downloadAsset, updateFile, verifyAsset } from './download.js'
import { UPDATE_IPC, type DistributionKey, type NativeArchitecture, type UpdateAsset, type UpdateRelease, type UpdateState } from './types.js'
import { awaitInstallerAdmission } from './launch.js'

function publicConfiguration(name: string): unknown {
  const file = path.join(process.resourcesPath ?? app.getAppPath(), name)
  if (!existsSync(file)) return null
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 64 * 1024) throw new Error('公开发行配置无效。')
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
function origin(): string {
  const config = publicConfiguration('oxy-service.json') as { origin?: unknown } | null
  if (typeof config?.origin !== 'string') throw new Error('软件更新服务尚未配置。')
  return distributionOrigin(config.origin).origin
}
function trustKeys(): DistributionKey[] {
  const keys = publicConfiguration('application-trust.json')
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => !key || !/^[A-Za-z0-9_-]{1,80}$/.test(key.id)
    || key.publicKey?.kty !== 'OKP' || key.publicKey?.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey?.x ?? '')
    || key.publicKey?.d !== undefined || key.privateKey !== undefined) || new Set(keys.map(key => key.id)).size !== keys.length) throw new Error('软件发行公钥无效。')
  return keys as DistributionKey[]
}
function nativeArchitecture(): NativeArchitecture {
  const machine = os.machine().toLowerCase()
  if (['x86_64', 'amd64'].includes(machine)) return 'x64'
  if (['arm64', 'aarch64'].includes(machine)) return 'arm64'
  throw new Error('当前原生系统架构不受支持。')
}
function trusted(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || ![windowState.mainWindow, windowState.settingsWindow].includes(window)
    || event.senderFrame !== event.sender.mainFrame) throw new Error('Update confirmation requires an application window.')
  const url = new URL(event.sender.getURL())
  const expected = new URL(!app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(path.join(mainDirectory, '../renderer/index.html')).href)
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname) {
    throw new Error('Update confirmation requires a trusted application page.')
  }
}
export function registerApplicationUpdates(): void {
  const root = path.join(app.getPath('userData'), 'updates')
  const sequences = createSequences(root)
  let state: UpdateState = { phase: 'idle', offer: null, downloadedBytes: 0, error: null }
  let selection: { release: UpdateRelease; manifestSha256: string; releaseProof: string; asset: UpdateAsset; origin: string } | null = null
  let pending: Promise<UpdateState> | null = null
  let controller: AbortController | null = null
  const snapshot = () => structuredClone(state)
  const publish = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; return snapshot() }
  ipcMain.handle(UPDATE_IPC.state, event => { trusted(event); return snapshot() })
  ipcMain.handle(UPDATE_IPC.check, event => {
    trusted(event)
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      publish({ phase: 'checking', offer: null, error: null })
      selection = null
      try {
        if (process.platform !== 'win32') throw new Error('软件发行仅支持 Windows。')
        const source = origin()
        const releases = await fetchReleases({ origin: source, keys: trustKeys(), channels: releaseChannels(app.getVersion()), sequences })
        const latest = releases.sort((a, b) => compareVersions(b.release.productVersion, a.release.productVersion))[0]
        if (!latest || compareVersions(latest.release.productVersion, app.getVersion()) <= 0) return publish({ phase: 'current' })
        const portable = isPortableMode()
        const architecture = nativeArchitecture()
        const asset = latest.release.assets.find(item => portable ? item.role === 'portable' : item.role === 'offline-installer' && item.executableArchitecture === architecture)
        if (!asset || !asset.supportedNativeArchitectures.includes(architecture)) throw new Error('未登记当前架构的完整发行包。')
        selection = { ...latest, asset, origin: source }
        return publish({ phase: 'available', downloadedBytes: 0, offer: { id: `${latest.release.releaseId}:${latest.manifestSha256}:${asset.assetId}`,
          version: latest.release.productVersion, notes: latest.release.notes, sizeBytes: asset.sizeBytes, kind: portable ? 'portable' : 'installed' } })
      } catch (error) { return publish({ phase: 'failed', error: error instanceof Error ? error.message : String(error) }) }
      finally { pending = null }
    })
    return pending
  })
  ipcMain.handle(UPDATE_IPC.accept, (event, offerId: unknown) => {
    trusted(event)
    if (pending) return pending
    if (!app.isPackaged) throw new Error('开发运行不能执行发行更新。')
    if (state.phase !== 'available' || !selection || !state.offer || state.offer.id !== offerId) throw new Error('更新提示已变化，请重新检查。')
    const accepted = structuredClone(selection)
    const portable = state.offer.kind === 'portable'
    controller = new AbortController()
    const signal = controller.signal
    pending = Promise.resolve().then(async () => {
      try {
        let destination: string | undefined
        if (portable) {
          const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '保存绿色版', defaultPath: accepted.asset.filename, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
          if (result.canceled || !result.filePath) return snapshot()
          destination = result.filePath
        }
        publish({ phase: 'downloading', downloadedBytes: 0, error: null })
        const file = await downloadAsset({ root, origin: accepted.origin, asset: accepted.asset, manifestSha256: accepted.manifestSha256, signal,
          progress: downloadedBytes => publish({ downloadedBytes }) })
        signal.throwIfAborted()
        if (destination) {
          await copyFile(file, destination, constants.COPYFILE_EXCL)
          try { await verifyAsset(destination, accepted.asset) } catch (error) { throw new Error(`保存文件未通过校验：${error instanceof Error ? error.message : String(error)}`) }
          shell.showItemInFolder(destination)
        } else {
          await verifyAsset(file, accepted.asset)
          const proofFile = updateFile(root, `release-${accepted.manifestSha256}.json`)
          writeFileSync(proofFile, accepted.releaseProof, 'utf8')
          await awaitInstallerAdmission(spawn(file, ['--release-id', accepted.release.releaseId, '--release-sha256', accepted.manifestSha256, '--release-proof', proofFile],
            { detached: true, stdio: 'ignore', windowsHide: true }))
        }
        return publish({ phase: 'ready' })
      } catch (error) {
        if (signal.aborted) return publish({ phase: 'available', error: null })
        return publish({ phase: 'available', error: error instanceof Error ? error.message : String(error) })
      } finally { pending = null; controller = null }
    })
    return pending
  })
  ipcMain.handle(UPDATE_IPC.cancel, event => { trusted(event); controller?.abort() })
  ipcMain.handle(UPDATE_IPC.releases, event => {
    trusted(event)
    let url = 'https://github.com/LinCi853/SidekickAI/releases'
    try { url = new URL('/downloads?edition=concept', origin()).toString() } catch { /* The historical release index remains available. */ }
    return shell.openExternal(url)
  })
}
