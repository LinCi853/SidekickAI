import type { AssetNavigation, AssetNavigationEvent } from '../shared/ai-assets.types.js'

let current: AssetNavigationEvent = { revision: 0 }
export function setAssetNavigation(request: AssetNavigation): AssetNavigationEvent {
  current = {
    revision: current.revision + 1,
    category: ['conversations', 'prompts', 'files'].includes(request?.category ?? '') ? request.category : undefined,
    focusSearch: request?.focusSearch === true,
    openSettings: request?.openSettings === true,
  }
  return current
}
export function getAssetNavigation(): AssetNavigationEvent { return current }
