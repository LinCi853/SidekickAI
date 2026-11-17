import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { edition, product } from '../packages/product-contract'

export interface RuntimePaths {
  mode: 'development' | 'installed' | 'portable'
  dataDirectory: string
  portableRoot?: string
}

// 绿色包标记：包根 portable.txt 的内容固定为 portable。
const PORTABLE_MARKER = 'portable'
// 旧绿色包使用的标记标题仍被接受，保证已发布的绿色包继续按便携模式运行。
const LEGACY_MARKERS = new Set([
  'AI Window Portable Mode Marker',
  'SidekickAI Dual Architecture Portable Marker',
])

function markerTitle(file: string): string {
  if (!lstatSync(file).isFile()) throw new Error('Invalid portable runtime marker')
  return readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/, 1)[0]
    .trim()
}

function assertMarker(title: string, layoutPresent: boolean): void {
  if (title === 'SidekickAI Dual Architecture Portable Marker') {
    if (!layoutPresent) throw new Error('Portable layout is missing')
    return
  }
  if (title !== PORTABLE_MARKER && !LEGACY_MARKERS.has(title))
    throw new Error('Invalid portable runtime marker')
}

function assertLayout(layoutPath: string): void {
  if (!lstatSync(layoutPath).isFile()) throw new Error('Invalid portable layout file')
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8'))
  const expected = product.portable
  if (
    layout.schemaVersion !== expected.schemaVersion ||
    layout.edition !== expected.edition ||
    layout.layout !== expected.layout ||
    layout.dataDirectory !== expected.dataDirectory ||
    layout.launcher !== expected.launcher ||
    layout.runtimes?.x64 !== expected.runtimes.x64 ||
    layout.runtimes?.arm64 !== expected.runtimes.arm64
  ) {
    throw new Error('Portable layout does not match this application')
  }
}

export function portableRoot(executable: string): string | undefined {
  const directory = path.dirname(executable)
  const parent = path.dirname(directory)
  const knownRuntime = Object.values(product.portable.runtimes).includes(path.basename(directory))
  const layoutPath = path.join(parent, 'portable-layout.json')
  const hasLayout = knownRuntime && existsSync(layoutPath)
  const marker = path.join(directory, 'portable.txt')
  const packagedMarker = path.join(parent, 'portable.txt')

  if (existsSync(marker)) {
    const title = markerTitle(marker)
    assertMarker(title, hasLayout)
    if (!hasLayout) return directory
    assertLayout(layoutPath)
    return parent
  }

  // 双架构绿色包把标记放在包根。只有已知运行目录才回退到包根查找，
  // 避免安装版把用户目录里的同名文件当成便携标记。
  if (knownRuntime && existsSync(packagedMarker)) {
    const title = markerTitle(packagedMarker)
    assertMarker(title, hasLayout)
    if (hasLayout) assertLayout(layoutPath)
    return parent
  }

  if (hasLayout) throw new Error('Portable runtime marker is missing')
  return undefined
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
    dataDirectory:
      options.dataOverride ||
      (mode === 'development'
        ? options.developmentDirectory
        : root
          ? path.join(root, product.portable.dataDirectory)
          : path.join(options.appData, edition.packageName)),
  }
}
