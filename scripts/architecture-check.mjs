import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoots = ['electron', 'src', 'packages', 'scripts']
const normalize = file => file.replaceAll('\\', '/')
const productionFile = file => /\.(?:[cm]?js|jsx|tsx?)$/.test(file) && !/\.(?:test|spec|d)\./.test(file)

export function readWorkspace(workspace = root) {
  const files = new Map()
  const visit = directory => {
    for (const entry of fs.readdirSync(path.join(workspace, directory), { withFileTypes: true })) {
      if (['node_modules', 'build', 'release', 'local', '.git', 'dist'].includes(entry.name)) continue
      const file = normalize(path.join(directory, entry.name))
      if (entry.isDirectory()) visit(file)
      else if (productionFile(file)) files.set(file, fs.readFileSync(path.join(workspace, file), 'utf8'))
    }
  }
  for (const directory of sourceRoots) if (fs.existsSync(path.join(workspace, directory))) visit(directory)
  return files
}

export function dependencyGraph(files) {
  files = new Map([...files].filter(([file]) => productionFile(file)))
  const directories = new Set()
  for (const file of files.keys()) {
    let directory = path.dirname(file)
    while (directory !== '.') { directories.add(normalize(directory)); directory = path.dirname(directory) }
  }
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, moduleResolution: ts.ModuleResolutionKind.Bundler }
  const host = {
    fileExists: file => files.has(normalize(path.relative(root, file))),
    readFile: file => files.get(normalize(path.relative(root, file))),
    directoryExists: directory => directories.has(normalize(path.relative(root, directory))),
    getCurrentDirectory: () => root,
    realpath: file => file,
  }
  const edges = []
  const resolve = (from, specifier) => {
    const aliases = { '@/': 'src/', '@shared/': 'electron/shared/', '@main/': 'electron/', '@lib/': 'src/lib/', '@hooks/': 'src/hooks/', '@store/': 'src/store/', '@components/': 'src/components/' }
    for (const [alias, directory] of Object.entries(aliases)) {
      if (specifier.startsWith(alias)) specifier = path.join(root, directory, specifier.slice(alias.length))
    }
    const target = ts.resolveModuleName(specifier, path.join(root, from), options, host).resolvedModule?.resolvedFileName
    const relative = target ? normalize(path.relative(root, target)) : null
    return relative && files.has(relative) ? relative : null
  }
  const scan = (file, source, original) => {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const add = (specifier, kind) => {
      const to = resolve(file, specifier)
      if (to) edges.push({ from: file, to, kind })
    }
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (original) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : node
          if (clause?.isTypeOnly || (ts.isImportDeclaration(node) && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            && !clause.name && clause.namedBindings.elements.every(item => item.isTypeOnly))
            || (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
              && node.exportClause.elements.every(item => item.isTypeOnly))) add(node.moduleSpecifier.text, 'type')
          else add(node.moduleSpecifier.text, 'source')
        } else add(node.moduleSpecifier.text, 'value')
      }
      if (!original && ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0].text, 'dynamic')
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0].text, 'value')
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const [file, source] of files) {
    scan(file, source, true)
    const emitted = ts.transpileModule(source, { compilerOptions: options, fileName: file }).outputText
    scan(file, emitted, false)
  }
  const runtime = new Set(edges.filter(edge => ['value', 'dynamic'].includes(edge.kind)).map(edge => `${edge.from}|${edge.to}`))
  const classified = edges.filter(edge => edge.kind !== 'source').concat(edges.filter(edge => edge.kind === 'source'
    && !runtime.has(`${edge.from}|${edge.to}`)).map(edge => ({ ...edge, kind: 'type' })))
  return [...new Map(classified.map(edge => [JSON.stringify(edge), edge])).values()]
}

export function cycleEdges(edges, kinds) {
  const graph = new Map()
  for (const edge of edges.filter(edge => kinds.includes(edge.kind))) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set())
    graph.get(edge.from).add(edge.to)
    if (!graph.has(edge.to)) graph.set(edge.to, new Set())
  }
  let cursor = 0
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), components = []
  const visit = node => {
    indices.set(node, cursor); low.set(node, cursor++)
    stack.push(node); active.add(node)
    for (const next of graph.get(node)) {
      if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))) }
      else if (active.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)))
    }
    if (indices.get(node) === low.get(node)) {
      const component = []
      let next
      do { next = stack.pop(); active.delete(next); component.push(next) } while (next !== node)
      if (component.length > 1 || graph.get(node).has(node)) components.push(component.sort())
    }
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return {
    components: components.sort((a, b) => a[0].localeCompare(b[0])),
    edges: edges.filter(edge => kinds.includes(edge.kind) && components.some(component => component.includes(edge.from) && component.includes(edge.to))),
  }
}

export function checkArchitecture(files, baseline) {
  const edges = dependencyGraph(files)
  const eager = cycleEdges(edges, ['value'])
  const loaded = cycleEdges(edges, ['value', 'dynamic'])
  const allowedCycles = new Set(baseline.cycleEdges.map(edge => `${edge.from}|${edge.to}|${edge.kind}`))
  const allowedCrossings = new Set(baseline.processCrossings.map(edge => `${edge.from}|${edge.to}`))
  const violations = []
  for (const edge of loaded.edges) {
    if (!allowedCycles.has(`${edge.from}|${edge.to}|${edge.kind}`)) violations.push(`New dependency cycle: ${edge.from} -> ${edge.to}`)
  }
  for (const edge of edges.filter(edge => edge.kind !== 'type')) {
    if ((edge.from.startsWith('src/') && edge.to.startsWith('electron/') && !edge.to.startsWith('electron/shared/'))
      || (edge.from.startsWith('electron/') && edge.to.startsWith('src/'))) {
      if (!allowedCrossings.has(`${edge.from}|${edge.to}`)) violations.push(`New process crossing: ${edge.from} -> ${edge.to}`)
    }
    if (['electron/modules/runtime-state.ts', 'electron/store/app-settings-defaults.ts'].includes(edge.from)) violations.push(`State/defaults import runtime behavior: ${edge.from} -> ${edge.to}`)
    if (edge.from === 'electron/store/app-settings-repository.ts' && /\/(?:hotkey|window|window-factory|ipc)\//.test(edge.to)) violations.push(`Settings persistence depends on desktop behavior: ${edge.to}`)
  }
  for (const [file, source] of files) {
    if (['electron/modules/registry.ts', 'electron/modules/runtime-state.ts'].includes(file)) continue
    const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: file }).outputText
    const tree = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true)
    const visit = node => {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'setModuleRuntime') violations.push(`Module state has an additional writer: ${file}`)
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 'setModuleRuntime'
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setModuleRuntime')) violations.push(`Module state has an additional writer: ${file}`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return { files: files.size, edgeCounts: Object.fromEntries(['value', 'dynamic', 'type'].map(kind => [kind, edges.filter(edge => edge.kind === kind).length])), eagerCycles: eager.components, loadedCycles: loaded.components, violations: [...new Set(violations)] }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts/architecture-baseline.json'), 'utf8'))
  const result = checkArchitecture(readWorkspace(), baseline)
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`Architecture: ${result.files} files; ${result.eagerCycles.length} eager cycles; ${result.loadedCycles.length} cycles including dynamic loading`)
    for (const violation of result.violations) console.error(violation)
  }
  if (result.violations.length) process.exitCode = 1
}
