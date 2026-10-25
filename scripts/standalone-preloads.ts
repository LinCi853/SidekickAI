import { build } from 'esbuild'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

// Sandboxed preload require() can load Electron, but cannot resolve sibling
// chunks. Bundle every entry separately, including shared source in each one.
export async function compileStandalonePreloads(
  root: string,
  entries: Record<string, string>,
  directory: string,
) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    outdir: directory,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    splitting: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    external: ['electron'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  const sourcePath = (file: string) => {
    const relative = path.relative(root, path.resolve(root, file)).replaceAll('\\', '/')
    if (relative.startsWith('../') || path.isAbsolute(relative))
      throw new Error('Preload input leaves workspace: ' + file)
    return relative
  }
  const outputs = Object.entries(result.metafile.outputs).map(([file, output]) => {
    const unsupported = output.imports.filter(
      (dependency) => dependency.path !== 'electron' || !dependency.external,
    )
    if (unsupported.length)
      throw new Error(
        'Sandbox preload has unsupported imports: ' +
          unsupported.map((dependency) => dependency.path).join(', '),
      )
    return {
      file: path.relative(directory, path.resolve(root, file)).replaceAll('\\', '/'),
      sources: Object.keys(output.inputs).map(sourcePath).sort(),
    }
  })
  const modules = Object.keys(result.metafile.inputs).map(sourcePath).sort()
  return {
    files: result.outputFiles.map((file) => ({
      file: path.relative(directory, file.path).replaceAll('\\', '/'),
      source: file.contents,
    })),
    proof: { schemaVersion: 1, target: 'preload', modules, outputs },
    watchFiles: modules.map((file) => path.resolve(root, file)),
  }
}

export function standalonePreloads(root: string): Plugin {
  const virtualEntry = '\0sidekick:standalone-preloads'
  let config: ResolvedConfig
  let entries: Record<string, string>
  return {
    name: 'sidekick:standalone-preloads',
    configResolved(value) {
      config = value
    },
    options(options) {
      if (!options.input || typeof options.input !== 'object' || Array.isArray(options.input))
        throw new Error('Preload entries must be a named input map')
      entries = options.input
      return { ...options, input: virtualEntry }
    },
    resolveId(id) {
      if (id === virtualEntry) return id
    },
    load(id) {
      if (id === virtualEntry) return 'export {}'
    },
    async buildStart() {
      const directory = path.resolve(config.root, config.build.outDir)
      const result = await compileStandalonePreloads(root, entries, directory)
      for (const file of result.watchFiles) this.addWatchFile(file)
      for (const file of result.files)
        this.emitFile({ type: 'asset', fileName: file.file, source: file.source })
      this.emitFile({
        type: 'asset',
        fileName: 'compilation-inputs.json',
        source: JSON.stringify(result.proof, null, 2) + '\n',
      })
    },
    generateBundle(_options, bundle) {
      for (const [file, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.facadeModuleId === virtualEntry) delete bundle[file]
      }
    },
  }
}
