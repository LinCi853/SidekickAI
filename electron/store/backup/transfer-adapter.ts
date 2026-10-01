import { createDefaultProfileParams, PRESETS } from '../default-config.js'
import { composeLimitedRestore, composeIncludedRestore, type TransferDefaults } from '../../../packages/backup-core/transfer.js'
import { validateRestoreDirectory } from '../restore-files.js'
import type { ImportAdapter } from '../../../packages/backup-core/import.js'

export function transferDefaults(): TransferDefaults { return { profile: createDefaultProfileParams(), presets: PRESETS } }
export function importAdapter(): ImportAdapter { return { edition: 'concept', defaults: transferDefaults(), validateFull: validateRestoreDirectory } }
export function prepareLimitedRestore(root: string, staged: string): void { composeLimitedRestore(root, staged, 'concept', transferDefaults()) }
export const prepareFullRestore = composeIncludedRestore
