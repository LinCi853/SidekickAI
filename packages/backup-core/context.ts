let sourceRoot: string | undefined

/** An isolated export process selects its source before importing application stores. */
export function setBackupSourceRoot(root: string): void { sourceRoot = root }
export function backupSourceRoot(): string | undefined { return sourceRoot }
