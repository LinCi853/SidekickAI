let pending = 0
export function hasActiveAssetImports(): boolean { return pending > 0 }
export async function runAssetImport<T>(operation: () => Promise<T>): Promise<T> {
  pending++
  try { return await operation() } finally { pending-- }
}
