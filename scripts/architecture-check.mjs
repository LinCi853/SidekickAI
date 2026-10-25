import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoots = ['electron', 'src', 'packages', 'scripts']
const normalize = (file) => file.replaceAll('\\', '/')
const productionFile = (file) =>
  /\.(?:[cm]?js|jsx|tsx?)$/.test(file) && !/\.(?:test|spec|d)\./.test(file)

/** Layer map used by the architecture gate; see contracts/architecture-layers.json. */
export const emptyLayers = { prefixes: [], exemptions: [] }

export function loadLayerMap(workspace = root) {
  const file = path.join(workspace, 'contracts/architecture-layers.json')
  if (!fs.existsSync(file)) return emptyLayers
  const map = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    prefixes: (map.prefixes ?? []).map((entry) => ({
      path: normalize(entry.path),
      level: entry.level,
      domain: entry.domain ?? null,
      allowedDomains: entry.allowedDomains ?? [],
    })),
    exemptions: (map.exemptions ?? []).map(normalize),
  }
}

/** Resolves a file to its layer entry, or null when the path has no constraint. */
export function layerResolver(layers = emptyLayers) {
  const prefixes = [...layers.prefixes].sort((a, b) => b.path.length - a.path.length)
  const exemptions = layers.exemptions ?? []
  const matches = (file, entry) =>
    file === entry || file.startsWith(entry.endsWith('/') ? entry : `${entry}/`)
  return (file) => {
    if (exemptions.some((entry) => matches(file, entry)))
      return { level: 0, domain: null, allowedDomains: [] }
    return prefixes.find((entry) => matches(file, entry.path)) ?? null
  }
}

export function readWorkspace(workspace = root) {
  const files = new Map()
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(workspace, directory), { withFileTypes: true })) {
      if (['node_modules', 'build', 'release', 'local', '.git', 'dist'].includes(entry.name))
        continue
      const file = normalize(path.join(directory, entry.name))
      if (entry.isDirectory()) visit(file)
      else if (productionFile(file))
        files.set(file, fs.readFileSync(path.join(workspace, file), 'utf8'))
    }
  }
  for (const directory of sourceRoots)
    if (fs.existsSync(path.join(workspace, directory))) visit(directory)
  return files
}

export function dependencyGraph(files) {
  files = new Map([...files].filter(([file]) => productionFile(file)))
  const directories = new Set()
  for (const file of files.keys()) {
    let directory = path.dirname(file)
    while (directory !== '.') {
      directories.add(normalize(directory))
      directory = path.dirname(directory)
    }
  }
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const host = {
    fileExists: (file) => files.has(normalize(path.relative(root, file))),
    readFile: (file) => files.get(normalize(path.relative(root, file))),
    directoryExists: (directory) => directories.has(normalize(path.relative(root, directory))),
    getCurrentDirectory: () => root,
    realpath: (file) => file,
  }
  const edges = []
  const resolve = (from, specifier) => {
    const aliases = {
      '@/': 'src/',
      '@shared/': 'electron/shared/',
      '@main/': 'electron/',
      '@lib/': 'src/lib/',
      '@hooks/': 'src/hooks/',
      '@store/': 'src/store/',
      '@components/': 'src/components/',
      '@styles/': 'src/styles/',
    }
    for (const [alias, directory] of Object.entries(aliases)) {
      if (specifier.startsWith(alias))
        specifier = path.join(root, directory, specifier.slice(alias.length))
    }
    const target = ts.resolveModuleName(specifier, path.join(root, from), options, host)
      .resolvedModule?.resolvedFileName
    const relative = target ? normalize(path.relative(root, target)) : null
    return relative && files.has(relative) ? relative : null
  }
  const scan = (file, source, original) => {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const add = (specifier, kind) => {
      const to = resolve(file, specifier)
      if (to) edges.push({ from: file, to, kind })
    }
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (original) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : node
          if (
            clause?.isTypeOnly ||
            (ts.isImportDeclaration(node) &&
              clause?.namedBindings &&
              ts.isNamedImports(clause.namedBindings) &&
              !clause.name &&
              clause.namedBindings.elements.every((item) => item.isTypeOnly)) ||
            (ts.isExportDeclaration(node) &&
              node.exportClause &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.every((item) => item.isTypeOnly))
          )
            add(node.moduleSpecifier.text, 'type')
          else add(node.moduleSpecifier.text, 'source')
        } else add(node.moduleSpecifier.text, 'value')
      }
      if (
        !original &&
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          add(node.arguments[0].text, 'dynamic')
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
          add(node.arguments[0].text, 'value')
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const [file, source] of files) {
    scan(file, source, true)
    const emitted = ts.transpileModule(source, {
      compilerOptions: options,
      fileName: file,
    }).outputText
    scan(file, emitted, false)
  }
  const runtime = new Set(
    edges
      .filter((edge) => ['value', 'dynamic'].includes(edge.kind))
      .map((edge) => `${edge.from}|${edge.to}`),
  )
  const classified = edges
    .filter((edge) => edge.kind !== 'source')
    .concat(
      edges
        .filter((edge) => edge.kind === 'source' && !runtime.has(`${edge.from}|${edge.to}`))
        .map((edge) => ({ ...edge, kind: 'type' })),
    )
  return [...new Map(classified.map((edge) => [JSON.stringify(edge), edge])).values()]
}

export function cycleEdges(edges, kinds) {
  const graph = new Map()
  for (const edge of edges.filter((edge) => kinds.includes(edge.kind))) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set())
    graph.get(edge.from).add(edge.to)
    if (!graph.has(edge.to)) graph.set(edge.to, new Set())
  }
  let cursor = 0
  const indices = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    components = []
  const visit = (node) => {
    indices.set(node, cursor)
    low.set(node, cursor++)
    stack.push(node)
    active.add(node)
    for (const next of graph.get(node)) {
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (active.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)))
    }
    if (indices.get(node) === low.get(node)) {
      const component = []
      let next
      do {
        next = stack.pop()
        active.delete(next)
        component.push(next)
      } while (next !== node)
      if (component.length > 1 || graph.get(node).has(node)) components.push(component.sort())
    }
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return {
    components: components.sort((a, b) => a[0].localeCompare(b[0])),
    edges: edges.filter(
      (edge) =>
        kinds.includes(edge.kind) &&
        components.some(
          (component) => component.includes(edge.from) && component.includes(edge.to),
        ),
    ),
  }
}

export function checkArchitecture(files, baseline, layers = emptyLayers) {
  const edges = dependencyGraph(files)
  const eager = cycleEdges(edges, ['value'])
  const loaded = cycleEdges(edges, ['value', 'dynamic'])
  const allowedCycles = new Set(
    baseline.cycleEdges.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`),
  )
  const allowedCrossings = new Set(
    baseline.processCrossings.map((edge) => `${edge.from}|${edge.to}`),
  )
  const allowedLayerCrossings = new Set(
    (baseline.layerCrossings ?? []).map((edge) => `${edge.from}|${edge.to}`),
  )
  const resolveLayer = layerResolver(layers)
  const layerCrossings = new Set()
  const mappedFiles = new Set()
  const violations = []
  for (const edge of loaded.edges) {
    if (!allowedCycles.has(`${edge.from}|${edge.to}|${edge.kind}`))
      violations.push(`New dependency cycle: ${edge.from} -> ${edge.to}`)
  }
  for (const edge of edges.filter((edge) => edge.kind !== 'type')) {
    if (
      (edge.from.startsWith('src/') &&
        edge.to.startsWith('electron/') &&
        !edge.to.startsWith('electron/shared/')) ||
      (edge.from.startsWith('electron/') && edge.to.startsWith('src/'))
    ) {
      if (!allowedCrossings.has(`${edge.from}|${edge.to}`))
        violations.push(`New process crossing: ${edge.from} -> ${edge.to}`)
    }
    if (
      ['electron/modules/runtime-state.ts', 'electron/store/app-settings-defaults.ts'].includes(
        edge.from,
      )
    )
      violations.push(`State/defaults import runtime behavior: ${edge.from} -> ${edge.to}`)
    if (
      edge.from === 'electron/store/app-settings-repository.ts' &&
      /\/(?:hotkey|window|window-factory|ipc)\//.test(edge.to)
    )
      violations.push(`Settings persistence depends on desktop behavior: ${edge.to}`)
  }
  for (const [file] of files) {
    const layer = resolveLayer(file)
    if (layer && layer.level > 0) mappedFiles.add(file)
  }
  for (const edge of edges.filter((edge) => edge.kind !== 'type')) {
    const from = resolveLayer(edge.from),
      to = resolveLayer(edge.to)
    if (!from || !to || from.level === 0 || to.level === 0) continue
    const layerCrossing = from.level < to.level
    const domainCrossing =
      from.level === 2 &&
      to.level === 2 &&
      from.domain !== to.domain &&
      !(from.allowedDomains ?? []).includes(to.domain)
    if (!layerCrossing && !domainCrossing) continue
    const key = `${edge.from}|${edge.to}`
    layerCrossings.add(key)
    if (allowedLayerCrossings.has(key)) continue
    violations.push(
      domainCrossing
        ? `Layer 2 domain crossing: ${edge.from} -> ${edge.to} (${from.domain} may not depend on ${to.domain})`
        : `Layer crossing: ${edge.from} -> ${edge.to} (L${from.level} imports L${to.level})`,
    )
  }
  const currentLayerCrossings = new Set(layerCrossings)
  for (const entry of baseline.layerCrossings ?? []) {
    if (!currentLayerCrossings.has(`${entry.from}|${entry.to}`))
      violations.push(`Stale layer crossing: ${entry.from} -> ${entry.to}`)
  }
  for (const [file, source] of files) {
    if (['electron/modules/registry.ts', 'electron/modules/runtime-state.ts'].includes(file))
      continue
    const emitted = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: file,
    }).outputText
    const tree = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (
        ts.isImportSpecifier(node) &&
        (node.propertyName ?? node.name).text === 'setModuleRuntime'
      )
        violations.push(`Module state has an additional writer: ${file}`)
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'setModuleRuntime') ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'setModuleRuntime'))
      )
        violations.push(`Module state has an additional writer: ${file}`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return {
    files: files.size,
    edgeCounts: Object.fromEntries(
      ['value', 'dynamic', 'type'].map((kind) => [
        kind,
        edges.filter((edge) => edge.kind === kind).length,
      ]),
    ),
    eagerCycles: eager.components,
    loadedCycles: loaded.components,
    mappedFiles: mappedFiles.size,
    layerCrossings: [...layerCrossings].sort().map((key) => {
      const [from, to] = key.split('|')
      return { from, to }
    }),
    violations: [...new Set(violations)],
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baselineFile = path.join(root, 'scripts/architecture-baseline.json')
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  const layers = loadLayerMap()
  const result = checkArchitecture(readWorkspace(), baseline, layers)
  if (process.argv.includes('--prune-layer-baseline')) {
    const previous = baseline.layerCrossings ?? []
    const next = { ...baseline, layerCrossings: result.layerCrossings }
    fs.writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`)
    console.log(
      `Layer baseline pruned: ${previous.length} -> ${next.layerCrossings.length} entries`,
    )
  } else if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(
      `Architecture: ${result.files} files; ${result.eagerCycles.length} eager cycles; ${result.loadedCycles.length} cycles including dynamic loading; ${result.mappedFiles} layered files; ${result.layerCrossings.length} layer crossings`,
    )
    for (const violation of result.violations) console.error(violation)
  }
  if (!process.argv.includes('--prune-layer-baseline') && result.violations.length)
    process.exitCode = 1
}
