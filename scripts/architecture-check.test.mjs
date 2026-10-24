import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkArchitecture, dependencyGraph, cycleEdges } from './architecture-check.mjs'

const empty = { cycleEdges: [], processCrossings: [] }
const layersOf = (prefixes, exemptions = []) => ({ prefixes, exemptions })
const foundation = { path: 'electron/hotkey/', level: 1 }
const plugins = { path: 'electron/modules/', level: 3 }

test('type-only mutual references do not form a runtime cycle', () => {
  const files = new Map([
    ['electron/a.ts', "import type { B } from './b.js'; export interface A { value: B }"],
    ['electron/b.ts', "import type { A } from './a.js'; export interface B { value: A }"],
  ])
  const result = checkArchitecture(files, empty)
  assert.equal(result.edgeCounts.type, 2)
  assert.deepEqual(result.eagerCycles, [])
  assert.deepEqual(result.violations, [])
})

test('literal dynamic loading participates in cycles without becoming eager', () => {
  const files = new Map([
    ['electron/a.ts', "export async function a() { return import('./b.js') }"],
    ['electron/b.ts', "import { a } from './a.js'; export const b = a"],
  ])
  const result = checkArchitecture(files, empty)
  assert.deepEqual(result.eagerCycles, [])
  assert.equal(result.loadedCycles.length, 1)
  assert.equal(result.violations.length, 2)
  const baseline = { ...empty, cycleEdges: cycleEdges(dependencyGraph(files), ['value', 'dynamic']).edges }
  assert.deepEqual(checkArchitecture(files, baseline).violations, [])
})

test('a new renderer import of main-process behavior is rejected', () => {
  const files = new Map([
    ['src/a.ts', "import { run } from '../electron/a.js'; run()"],
    ['electron/a.ts', 'export function run() {}'],
  ])
  assert.match(checkArchitecture(files, empty).violations.join(), /New process crossing/)
})

test('erased type imports and per-specifier type exports remain visible without creating cycles', () => {
  const files = new Map([
    ['electron/a.ts', "import { B } from './b.js'; export interface A { value: B }"],
    ['electron/b.ts', "export { type A } from './a.js'; export interface B { value: string }"],
  ])
  const result = checkArchitecture(files, empty)
  assert.equal(result.edgeCounts.type, 2)
  assert.deepEqual(result.loadedCycles, [])
})

test('writer checks distinguish runtime use from comments and type contracts', () => {
  const safe = new Map([
    ['electron/a.ts', "import type { setModuleRuntime } from './modules/runtime-state.js'; type Setter = typeof setModuleRuntime; // setModuleRuntime"],
    ['electron/modules/runtime-state.ts', 'export function setModuleRuntime() {}'],
  ])
  assert.deepEqual(checkArchitecture(safe, empty).violations, [])
  safe.set('electron/a.ts', "import { setModuleRuntime as write } from './modules/runtime-state.js'; write()")
  assert.match(checkArchitecture(safe, empty).violations.join(), /additional writer/)
})

test('a foundation service may not import a higher layer', () => {
  const files = new Map([
    ['electron/hotkey/a.ts', "import { b } from '../modules/b.js'; export const a = b"],
    ['electron/modules/b.ts', 'export const b = 1'],
  ])
  const result = checkArchitecture(files, empty, layersOf([foundation, plugins]))
  assert.match(result.violations.join(), /Layer crossing: electron\/hotkey\/a.ts -> electron\/modules\/b.ts/)
  assert.deepEqual(result.layerCrossings, [{ from: 'electron/hotkey/a.ts', to: 'electron/modules/b.ts' }])
  assert.equal(result.mappedFiles, 2)
})

test('a higher layer may depend on a foundation service', () => {
  const files = new Map([
    ['electron/modules/a.ts', "import { b } from '../hotkey/b.js'; export const a = b"],
    ['electron/hotkey/b.ts', 'export const b = 1'],
  ])
  const result = checkArchitecture(files, empty, layersOf([foundation, plugins]))
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.layerCrossings, [])
})

test('level 2 containers may depend on the browser domain but not the reverse', () => {
  const containers = { path: 'electron/platform/window/containers/', level: 2, domain: 'containers', allowedDomains: ['browser'] }
  const browser = { path: 'electron/browser/', level: 2, domain: 'browser' }
  const files = new Map([
    ['electron/platform/window/containers/popup.ts', "import { tab } from '../../../browser/tabs.js'; export const popup = tab"],
    ['electron/browser/tabs.ts', "import { popup } from '../platform/window/containers/popup.js'; export const tab = popup"],
  ])
  const result = checkArchitecture(files, empty, layersOf([containers, browser]))
  assert.equal(result.layerCrossings.length, 1)
  assert.match(result.violations.join(), /Layer 2 domain crossing: electron\/browser\/tabs.ts -> electron\/platform\/window\/containers\/popup.ts/)
})

test('the layer baseline ratchets known crossings and reports stale entries', () => {
  const files = new Map([
    ['electron/hotkey/a.ts', "import { b } from '../modules/b.js'; export const a = b"],
    ['electron/modules/b.ts', 'export const b = 1'],
  ])
  const baseline = { ...empty, layerCrossings: [{ from: 'electron/hotkey/a.ts', to: 'electron/modules/b.ts' }] }
  assert.deepEqual(checkArchitecture(files, baseline, layersOf([foundation, plugins])).violations, [])
  const stale = { ...baseline, layerCrossings: [...baseline.layerCrossings, { from: 'electron/hotkey/gone.ts', to: 'electron/modules/gone.ts' }] }
  assert.match(checkArchitecture(files, stale, layersOf([foundation, plugins])).violations.join(), /Stale layer crossing: electron\/hotkey\/gone.ts/)
})

test('exempt assembly files and unmapped paths carry no layer constraint', () => {
  const files = new Map([
    ['electron/main.ts', "import { b } from './modules/b.js'; export const entry = b"],
    ['electron/store/x.ts', "import { b } from '../modules/b.js'; export const store = b"],
    ['electron/modules/b.ts', 'export const b = 1'],
  ])
  const result = checkArchitecture(files, empty, layersOf([foundation, plugins], ['electron/main.ts']))
  assert.deepEqual(result.violations, [])
  assert.equal(result.mappedFiles, 1)
})

test('the @styles alias resolves renderer imports', () => {
  const files = new Map([
    ['src/styles/tokens.ts', 'export const token = 1'],
    ['src/pages/a.ts', "import { token } from '@styles/tokens.js'; export const a = token"],
  ])
  const result = checkArchitecture(files, empty)
  assert.equal(result.edgeCounts.value, 1)
})
