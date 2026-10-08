import type { AssetRetentionStatus, AssetSettings } from '../shared/ai-assets.types.js'
import type { AiAssetsStore } from '../store/ai-assets-store.js'
import { cleanSelectedAttachments, recoverSelectedCleanup } from './selected-cleanup.js'

export function createAttachmentRetention(options: {
  userData: string
  settings: () => AssetSettings
  assets: () => AiAssetsStore
  prepare?: () => Promise<void>
  busy: () => boolean
  changed: () => void
  publish: (status: AssetRetentionStatus) => void
  now?: () => number
}) {
  let status: AssetRetentionStatus = { state: 'disabled', deleted: 0, cleanupPending: false }
  let stopped = false, running = false
  const publish = (changes: Partial<AssetRetentionStatus>) => { status = { ...status, ...changes }; options.publish({ ...status }) }
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      if (!options.settings().fileRetentionDays) { publish({ state: 'disabled', error: undefined }); return }
      await options.prepare?.()
      if (stopped) return
      const days = options.settings().fileRetentionDays
      if (!days) { publish({ state: 'disabled', error: undefined }); return }
      if (options.busy()) { publish({ state: 'waiting' }); return }
      const now = (options.now ?? Date.now)(), assets = options.assets()
      const ids = assets.expiredAttachmentIds(now - days * 86400000)
      let result = { deleted: 0, cleanupPending: false }
      if (ids.length) result = cleanSelectedAttachments(options.userData, assets, ids)
      else recoverSelectedCleanup(options.userData, assets)
      if (result.deleted) options.changed()
      publish({ state: 'idle', deleted: status.deleted + result.deleted, lastRun: now, cleanupPending: result.cleanupPending, error: undefined })
    } catch (error) {
      if (!stopped) publish({ state: 'error', error: String(error) })
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 60000)
  timer.unref?.()
  return { tick, status: () => ({ ...status }), stop: () => { stopped = true; clearInterval(timer) } }
}
