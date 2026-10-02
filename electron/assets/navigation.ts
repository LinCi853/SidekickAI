import type { AssetNavigation, AssetNavigationEvent } from '../shared/ai-assets.types.js'

let current: AssetNavigationEvent = { revision: 0 }
export function setAssetNavigation(request: AssetNavigation): AssetNavigationEvent {
  current = {
    revision: current.revision + 1,
    category: ['conversations', 'prompts', 'files'].includes(request?.category ?? '') ? request.category : undefined,
    focusSearch: request?.focusSearch === true,
    freezeTabId: typeof request?.freezeTabId === 'string' ? request.freezeTabId : undefined,
  }
  return current
}
export function getAssetNavigation(): AssetNavigationEvent { return current }
