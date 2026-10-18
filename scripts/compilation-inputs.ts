import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export function compilationInputs(root: string, target: 'main' | 'preload' | 'renderer'): Plugin {
  const canonicalRoot = realpathSync.native(root)
  const relativeSource = (id: string): string | null => {
    const file = id.split('?')[0]
    if (!path.isAbsolute(file)) return null
    const relative = path.relative(canonicalRoot, existsSync(file) ? realpathSync.native(file) : file)
    return relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? null : relative.replaceAll('\\', '/')
  }
  let modules: string[] = []
  let outputs: Array<{ file: string; sources: string[] }> = []
  return {
    name: 'compilation-inputs',
    enforce: 'post',
    generateBundle(_options, bundle) {
      modules = [...this.getModuleIds()].map(relativeSource).filter((id): id is string => id !== null).sort()
      outputs = Object.values(bundle).filter(item => item.type === 'chunk').map(item => ({
        file: item.fileName,
        sources: Object.keys(item.modules).map(relativeSource).filter((id): id is string => id !== null).sort(),
      }))
    },
    writeBundle(options) {
      const directory = options.dir ?? path.dirname(options.file!)
      writeFileSync(path.join(directory, 'compilation-inputs.json'), JSON.stringify({ schemaVersion: 1, target, modules, outputs }, null, 2) + '\n')
    },
  }
}
