import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { edition, product } from '../packages/product-contract'

export interface RuntimePaths {
  mode: 'development' | 'installed' | 'portable'
  dataDirectory: string
  portableRoot?: string
}

export function portableRoot(executable: string): string | undefined {
  const directory = path.dirname(executable)
  const marker = path.join(directory, 'portable.txt')
  const parent = path.dirname(directory)
  const layoutPath = path.join(parent, 'portable-layout.json')
  const hasLayout = Object.values(product.portable.runtimes).includes(path.basename(directory)) && existsSync(layoutPath)
  if (!existsSync(marker)) {
    if (hasLayout) throw new Error('Portable runtime marker is missing')
    return undefined
  }
  if (!lstatSync(marker).isFile()) throw new Error('Invalid portable runtime marker')
  const markerTitle = readFileSync(marker, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]
  const dualArchitecture = markerTitle === 'SidekickAI Dual Architecture Portable Marker'
  if (!dualArchitecture && markerTitle !== 'AI Window Portable Mode Marker') {
    throw new Error('Invalid portable runtime marker')
  }
  if (dualArchitecture && !hasLayout) throw new Error('Portable layout is missing')
  if (!hasLayout) return directory
  if (!lstatSync(layoutPath).isFile()) throw new Error('Invalid portable layout file')
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8'))
  const expected = product.portable
  if (layout.schemaVersion !== expected.schemaVersion || layout.edition !== expected.edition ||
      layout.layout !== expected.layout || layout.dataDirectory !== expected.dataDirectory ||
      layout.launcher !== expected.launcher || layout.runtimes?.x64 !== expected.runtimes.x64 ||
      layout.runtimes?.arm64 !== expected.runtimes.arm64) {
    throw new Error('Portable layout does not match this application')
  }
  return parent
}

export function resolveRuntimePaths(options: {
  isPackaged: boolean
  executable: string
  appData: string
  developmentDirectory: string
  dataOverride?: string
}): RuntimePaths {
  if (options.dataOverride && !path.isAbsolute(options.dataOverride)) {
    throw new Error('SIDEKICK_DATA_DIR must be an absolute path')
  }
  const root = options.isPackaged ? portableRoot(options.executable) : undefined
  const mode = !options.isPackaged ? 'development' : root ? 'portable' : 'installed'
  return {
    mode,
    portableRoot: root,
    dataDirectory: options.dataOverride || (mode === 'development'
      ? options.developmentDirectory
      : root ? path.join(root, product.portable.dataDirectory) : path.join(options.appData, edition.packageName)),
  }
}
