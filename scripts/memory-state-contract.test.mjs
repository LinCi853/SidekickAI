import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessState, selectProcessTree, MiB } from './memory-state-contract.mjs'

const row = (pid, parent, bytes = 100) => ({ ProcessId: pid, ParentProcessId: parent, WorkingSetSize: bytes, Name: 'test.exe' })
const sample = (bytes, inventory) => ({ totalBytes: bytes, inventory, processes: [{ pid: 1, bytes }] })
const minimum = { windows: 0, browserWindows: 0, guests: 0, renderers: 0 }
const browsers = { windows: 11, browserWindows: 10, guests: 11, browserGuests: 10, readyBrowserWindows: 10 }

test('includes every descendant, excludes unrelated Electron instances and ancestors', () => {
  assert.deepEqual(selectProcessTree([row(3, 2), row(1, 99), row(2, 1), row(4, 99), row(5, 4)], 1).map(p => p.pid).sort(), [1, 2, 3])
})
test('missing root or metric fails instead of reporting a false zero', () => {
  assert.throws(() => selectProcessTree([row(2, 1)], 1), /missing/)
  assert.throws(() => selectProcessTree([row(1, 0, null)], 1), /Missing working set/)
})
test('minimum uses strict less-than 70 MiB and checks full renderer release', () => {
  assert.equal(assessState('minimum', [sample(69 * MiB, minimum)]).status, 'PASS')
  assert.equal(assessState('minimum', [sample(70 * MiB, minimum)]).status, 'FAIL')
  assert.equal(assessState('minimum', [sample(30 * MiB, { ...minimum, renderers: 1 })]).status, 'FAIL')
})
test('retirement or unloaded browser pages cannot produce a passing ten-window result', () => {
  assert.equal(assessState('browsers', [sample(100 * MiB, { ...browsers, windows: 9 })]).status, 'FAIL')
  assert.equal(assessState('browsers', [sample(100 * MiB, { ...browsers, browserGuests: 9 })]).status, 'FAIL')
  assert.equal(assessState('browsers', [sample(100 * MiB, { ...browsers, readyBrowserWindows: 9 })]).status, 'FAIL')
})
test('browser budget includes peak samples, including a transient overshoot', () => {
  assert.equal(assessState('browsers', [sample(5120 * MiB, browsers)]).status, 'PASS')
  assert.equal(assessState('browsers', [sample(100 * MiB, browsers), sample(5120 * MiB + 1, browsers)]).status, 'FAIL')
})
test('shell scenario cannot substitute webpages or a different number of windows', () => {
  const shells = { windows: 10, browserWindows: 0, guests: 0 }
  assert.equal(assessState('shells', [sample(1024 * MiB, shells)]).status, 'PASS')
  assert.equal(assessState('shells', [sample(100 * MiB, { ...shells, guests: 10 })]).status, 'FAIL')
})
test('standard startup enforces the whole-tree budget and preserves functional failures', () => {
  const inventory = { windows: 1, browserWindows: 0 }
  assert.equal(assessState('standard', [sample(299 * MiB, inventory)]).status, 'PASS')
  assert.equal(assessState('standard', [sample(300 * MiB, inventory)]).status, 'FAIL')
  assert.equal(assessState('standard', [sample(301 * MiB, inventory)]).status, 'FAIL')
  assert.equal(assessState('standard', [sample(299 * MiB, inventory)], ['Main renderer reloaded during toggle']).status, 'FAIL')
})
test('excludes an older process whose exited parent PID was reused', () => {
  const parent = { ...row(1, 0), CreatedAt: '2026-10-16T01:00:00Z' }
  const unrelated = { ...row(2, 1), CreatedAt: '2026-10-15T01:00:00Z' }
  const child = { ...row(3, 1), CreatedAt: '2026-10-16T01:00:01Z' }
  assert.deepEqual(selectProcessTree([parent, unrelated, child, row(4, 2)], 1).map(p => p.pid), [1, 3])
})
