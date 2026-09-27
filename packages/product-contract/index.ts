import manifest from './manifest.json'
import selection from '../../product-edition.json'
import packageMetadata from '../../package.json'

export type ProductEdition = keyof typeof manifest.editions
export const editionId = selection.edition as ProductEdition
if (!Object.prototype.hasOwnProperty.call(manifest.editions, editionId)) throw new Error('Unknown product edition')
export const product = { ...manifest, version: packageMetadata.version }
export const edition = manifest.editions[editionId]
