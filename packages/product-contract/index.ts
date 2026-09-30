import manifest from './manifest.json'
import packageMetadata from '../../package.json'

export { editionId, edition, type ProductEdition } from './identity'
export const product = { ...manifest, version: packageMetadata.version }
