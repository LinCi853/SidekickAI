let activeExports = 0
export function hasActiveBackupExports(): boolean { return activeExports > 0 }
export async function runBackupExport<T>(operation: () => Promise<T>): Promise<T> {
  activeExports++
  try { return await operation() } finally { activeExports-- }
}
