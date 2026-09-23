import Database from 'better-sqlite3'

export async function snapshotSqliteDatabase(source: string, target: string): Promise<void> {
  const reader = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await reader.backup(target)
  } finally {
    reader.close()
  }
}
