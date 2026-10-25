/* =====================================================================
   store/useShortcutDocStore.test.ts —— 快捷键注册表（注册即声明）
   覆盖：来源整体替换（实时更新）、卸载注销、id 去重（多路径实现一键一条）、
   全局优先排序、类别字段原样透出。
   ===================================================================== */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  registerShortcutDocs,
  selectShortcutDocs,
  unregisterShortcutDocs,
  useShortcutDocStore,
} from './useShortcutDocStore'
import type { ShortcutDoc } from './useShortcutDocStore'

const doc = (
  id: string,
  category: ShortcutDoc['category'],
  over: Partial<ShortcutDoc> = {},
): ShortcutDoc => ({ id, keys: id.toUpperCase(), action: id, category, ...over })

describe('useShortcutDocStore', () => {
  beforeEach(() => {
    useShortcutDocStore.setState({ sources: {} })
  })

  it('flattens sources with global entries first, keeping registration order', () => {
    registerShortcutDocs('page-a', [doc('p1', 'page'), doc('p2', 'page')])
    registerShortcutDocs('globals', [doc('g1', 'global')])
    expect(selectShortcutDocs(useShortcutDocStore.getState().sources).map((d) => d.id)).toEqual([
      'g1',
      'p1',
      'p2',
    ])
  })

  it('replaces a source wholesale on re-registration (live updates)', () => {
    registerShortcutDocs('dyn', [doc('old', 'page')])
    registerShortcutDocs('dyn', [doc('new', 'page', { disabled: true })])
    const docs = selectShortcutDocs(useShortcutDocStore.getState().sources)
    expect(docs.map((d) => d.id)).toEqual(['new'])
    expect(docs[0].disabled).toBe(true)
  })

  it('dedupes by id across sources (multi-path implementations register once)', () => {
    registerShortcutDocs('renderer', [doc('window.always-on-top', 'page', { keys: 'F12' })])
    registerShortcutDocs('window-controls', [doc('window.always-on-top', 'page', { keys: 'F12 ' })])
    expect(selectShortcutDocs(useShortcutDocStore.getState().sources)).toHaveLength(1)
  })

  it('unregisters a source on unmount', () => {
    registerShortcutDocs('gone', [doc('x', 'page')])
    unregisterShortcutDocs('gone')
    expect(selectShortcutDocs(useShortcutDocStore.getState().sources)).toHaveLength(0)
  })
})
