import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkArchitecture, dependencyGraph, cycleEdges } from './architecture-check.mjs'

const empty = { cycleEdges: [], processCrossings: [] }

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
