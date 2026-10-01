import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';


/**
 * Test-only observation seams used to simulate concurrent source changes and
 * filesystem failures. Production callers never set these and the hooks are
 * inert when unset.
 */
export const strictExportTestSeams: {
  afterInventory?: (dataDir: string, archivePaths: string[]) => void | Promise<void>;
  afterExport?: (dataDir: string) => void | Promise<void>;
  /** Runs inside the writer after compression/encryption, before the source re-verification and the exclusive publish. */
  beforePublish?: (targetPath: string) => void | Promise<void>;
  /** Replaces the filesystem probe so tests can inject access errors (EACCES and friends). */
  lstat?: (candidate: string) => fs.Stats;
} = {};


export function getDataDir(): string {
  return app.getPath('userData');
}

export function pathMatchesDataRoot(candidate: string | undefined): boolean {
  if (!candidate || !candidate.trim()) return false
  const actual = path.resolve(getDataDir())
  const expected = path.resolve(candidate)
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
}

export function strictRootError(candidate: string | undefined): string {
  if (!candidate || !candidate.trim()) return 'Strict export requires expectedDataRoot.'
  return `Expected data root does not match the application data root (expected ${path.resolve(candidate)}, actual ${path.resolve(getDataDir())}).`
}

/** Normalize a data-root-relative declaration and reject every escape attempt. */
export function resolveDataRootEntry(dataDir: string, declared: string): { sourcePath: string; archivePath: string } {
  const raw = declared.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = raw.split('/')
  const root = path.resolve(dataDir)
  if (
    !raw
    || raw.startsWith('/')
    || /^[a-zA-Z]:/.test(raw)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Backup declaration is outside the data root: ${declared}`)
  }
  for (const segment of segments) {
    // Alternate data streams and control characters must never enter an archive
    // path, and Windows silently strips trailing dots and spaces from names.
    if (segment.includes(':') || /[\u0000-\u001f]/.test(segment)) {
      throw new Error(`Backup declaration contains an unsafe name: ${declared}`)
    }
    if (process.platform === 'win32' && (segment.endsWith('.') || segment.endsWith(' '))) {
      throw new Error(`Backup declaration ends with a Windows-ambiguous character: ${declared}`)
    }
  }
  const sourcePath = path.resolve(root, ...segments)
  const relative = path.relative(root, sourcePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Backup declaration is outside the data root: ${declared}`)
  }
  return { sourcePath, archivePath: segments.join('/') }
}

export function sameResolvedPath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Probe one selected path without following links. Only ENOENT means "absent";
 * any other failure (EACCES, EPERM, ENOTDIR, ...) is re-thrown in strict mode so
 * an unreadable source can never be mistaken for an empty category.
 */
export function lstatSelected(candidate: string, archivePath: string, strict: boolean): fs.Stats | null {
  try {
    return strictExportTestSeams.lstat ? strictExportTestSeams.lstat(candidate) : fs.lstatSync(candidate)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (strict) {
      throw new Error(`Selected backup entry cannot be inspected: ${archivePath} (${code ?? String(err)})`)
    }
    return null
  }
}

/**
 * Inspect a selected path and every ancestor below the data root without
 * following links. Returns null when the path is simply absent; a symlinked or
 * non-directory ancestor is an error in strict mode.
 */
export function inspectSelectedPath(
  dataDir: string,
  sourcePath: string,
  archivePath: string,
  kind: 'file' | 'directory',
  strict: boolean,
): fs.Stats | null {
  const relative = path.relative(dataDir, sourcePath)
  const segments = relative.split(path.sep).filter(Boolean)
  for (let index = 0; index < segments.length - 1; index++) {
    const ancestorArchive = segments.slice(0, index + 1).join('/')
    const stat = lstatSelected(path.join(dataDir, ...segments.slice(0, index + 1)), ancestorArchive, strict)
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      if (strict) throw new Error(`Selected backup path is not a real directory: ${ancestorArchive}`)
      return null
    }
  }
  const stat = lstatSelected(sourcePath, archivePath, strict)
  if (!stat) return null
  if (stat.isSymbolicLink()) {
    if (strict) throw new Error(`Backup selection contains a symbolic link or junction: ${archivePath}`)
    return null
  }
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    if (strict) throw new Error(`Selected backup entry is not a regular ${kind}: ${archivePath}`)
    return null
  }
  return stat
}

/** The data root itself must be a real directory, not a link to another tree. */
export function assertRealDataRoot(dataDir: string, strict: boolean): void {
  if (!strict) return
  const stat = lstatSelected(dataDir, dataDir, true)
  if (!stat) throw new Error(`Backup data root is missing: ${dataDir}`)
  if (stat.isSymbolicLink()) throw new Error(`Backup data root is a symbolic link or junction: ${dataDir}`)
  if (!stat.isDirectory()) throw new Error(`Backup data root is not a directory: ${dataDir}`)
}
