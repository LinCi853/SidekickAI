import { app } from 'electron'
import { broadcastToAllWindows } from '../../shared/broadcast.js'
import { getModuleStateDb } from '../../store/module-state-store.js'
import { getChatStore } from '../../store/chat-store.js'
import { isModuleEnabled } from '../registry.js'
import { hasActiveAssetStreams } from '../../ai/handler.js'
import { hasLinkedOriginalTransfers } from '../../assets/api-originals.js'
import { hasWebOriginalTransfers } from '../../assets/asset-ipc.js'
import { hasActiveAssetImports } from '../../assets/import-activity.js'
import { hasActiveBackupExports } from '../../store/backup-activity.js'
import { isImportingData } from '../../store/import-guard.js'
import { assertAssetClearAllowed, clearAssetDirectories } from '../../assets/clear-data.js'
import { IPC_CHANNELS } from '../../shared/ipc-channels.js'
import { EffectScope } from '../effect-scope.js'
import { registerPromptIPC, promptStore, ensureDefaultPrompts } from '../../store/prompt-store.js'
import { registerPromptIpc } from '../../ipc/prompt-ipc.js'
import { registerInjectionIpc } from '../../ai/handler.js'
import { injectionHistoryStore } from '../../store/injection-history-store.js'
import { showPromptWindow } from '../../window-factory.js'
import { windowState } from '../../window-state.js'

/** Module-owned effects. */
const scope = new EffectScope('prompt-library', 'prompt-library')


export async function initPromptLibraryModule(): Promise<void> {
  // Registration is idempotent.
  await scope.dispose()
  // Initialize templates for a new profile.
  ensureDefaultPrompts()
  // Register module-owned handlers.
  registerPromptIPC(scope)
  registerInjectionIpc(scope)

  registerPromptIpc({
    showPromptWindow,
    getMainWindow: () => windowState.mainWindow,
    getPromptWindow: () => windowState.promptWindow,
  }, scope)
}

export async function teardownPromptLibraryModule(): Promise<void> {
  // Close the asset window before removing its handlers.
  const win = windowState.promptWindow
  if (win && !win.isDestroyed()) {
    win.close()
  }
  await scope.dispose()
}

export function clearPromptLibraryData(): void {
  assertAssetClearAllowed(isModuleEnabled('prompt-library'), hasActiveAssetStreams() || hasLinkedOriginalTransfers() || hasWebOriginalTransfers() || hasActiveAssetImports() || hasActiveBackupExports() || isImportingData)
  promptStore.list()
  injectionHistoryStore.listRecent()
  let cleared = false
  try {
    clearAssetDirectories(app.getPath('userData'), () => {
      getChatStore().assets.clearData(getModuleStateDb().name)
      cleared = true
      promptStore.invalidate()
      injectionHistoryStore.invalidate()
    })
  } finally {
    if (cleared) broadcastToAllWindows(IPC_CHANNELS.ASSET_CLEARED, undefined, 'assets')
  }
}
