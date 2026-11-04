import test from 'node:test'
import assert from 'node:assert/strict'
import {
  flattenIssues,
  diffAgainstBaseline,
  findStaleBaseline,
  countItems,
  emptyBaseline,
} from './deadcode-check.mjs'

test('flattenIssues normalizes knip issue objects and ignores positions', () => {
  const flat = flattenIssues([
    {
      file: 'a.ts',
      files: [],
      dependencies: [],
      devDependencies: [{ name: 'left-pad' }],
      unlisted: [{ name: 'zlib', line: 3 }],
      unresolved: [],
      exports: [{ name: 'unusedFn', line: 9, col: 1, pos: 10 }],
      types: [{ name: 'UnusedType', line: 12, col: 1, pos: 20 }],
      duplicates: [
        [
          { name: 'Widget', line: 1 },
          { name: 'default', line: 2 },
        ],
      ],
    },
    { file: 'b.ts', files: [{ name: 'b.ts' }] },
  ])
  assert.deepEqual(flat.devDependencies, [{ file: 'a.ts', name: 'left-pad' }])
  assert.deepEqual(flat.unlisted, [{ file: 'a.ts', name: 'zlib' }])
  assert.deepEqual(flat.exports, [{ file: 'a.ts', name: 'unusedFn' }])
  assert.deepEqual(flat.types, [{ file: 'a.ts', name: 'UnusedType' }])
  assert.deepEqual(flat.files, [{ file: 'b.ts' }])
  assert.deepEqual(flat.duplicates, [{ file: 'a.ts', name: 'Widget|default' }])
  assert.equal(countItems(flat), 6)
})

test('diffAgainstBaseline reports only entries missing from the baseline', () => {
  const current = emptyBaseline()
  current.exports.push({ file: 'a.ts', name: 'kept' }, { file: 'a.ts', name: 'new' })
  const baseline = emptyBaseline()
  baseline.exports.push({ file: 'a.ts', name: 'kept' })
  const diff = diffAgainstBaseline(current, baseline)
  assert.deepEqual(diff.exports, [{ file: 'a.ts', name: 'new' }])
})

test('findStaleBaseline lists baseline entries no longer present', () => {
  const current = emptyBaseline()
  current.exports.push({ file: 'a.ts', name: 'kept' })
  const baseline = emptyBaseline()
  baseline.exports.push({ file: 'a.ts', name: 'kept' }, { file: 'a.ts', name: 'removed' })
  const stale = findStaleBaseline(current, baseline)
  assert.deepEqual(stale.exports, [{ file: 'a.ts', name: 'removed' }])
})

test('empty baseline accepts anything', () => {
  const current = emptyBaseline()
  current.files.push({ file: 'whatever.ts' })
  assert.deepEqual(diffAgainstBaseline(current, emptyBaseline()).files, [{ file: 'whatever.ts' }])
})
