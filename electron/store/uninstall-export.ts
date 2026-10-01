import { exportAllData } from './backup-restore.js'

export async function exportForUninstall(root: string, output: string, password?: string): Promise<void> {
  const result = await exportAllData(output, { basicData: true, cookies: true, indexedDB: true, cache: true }, password ? { password } : undefined, { strict: true, expectedDataRoot: root })
  if (!result.success) throw new Error(result.error)
}
