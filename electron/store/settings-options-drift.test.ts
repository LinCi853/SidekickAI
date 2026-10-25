// electron/store/settings-options-drift.test.ts
//
// 默认设置模块禁止引入运行时依赖，因此 app-settings-defaults.ts 就地声明了
// 顶栏按钮组与侧边菜单入口；settings-options.ts 定义同一批字面量供设置校验使用。
// 两处一旦漂移，默认值会通不过自己的校验器，且用户会看到"默认配置被判为非法"。
// 本测试把这份隐式契约固定下来。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getDefaultAppSettings } from './app-settings-defaults.js'
import { ALL_DRAWER_MENU_ITEMS, ALL_TOP_BAR_BUTTON_GROUPS } from '../shared/api/settings-options.js'

describe('settings options drift guard', () => {
  it('默认设置里的顶栏按钮组与叶子模块保持一致', () => {
    const defaults = getDefaultAppSettings(false)
    expect(defaults.topBarVisibleButtons).toEqual(ALL_TOP_BAR_BUTTON_GROUPS)
  })

  it('默认设置里的侧边菜单入口与叶子模块保持一致', () => {
    const defaults = getDefaultAppSettings(false)
    expect(defaults.drawerMenuItems).toEqual(ALL_DRAWER_MENU_ITEMS)
  })

  it('默认设置返回的数组是副本，外部修改不会污染其他调用方', () => {
    const first = getDefaultAppSettings(false)
    first.topBarVisibleButtons.push('uaToggle')
    first.drawerMenuItems.length = 0
    const second = getDefaultAppSettings(false)
    expect(second.topBarVisibleButtons).toEqual(ALL_TOP_BAR_BUTTON_GROUPS)
    expect(second.drawerMenuItems).toEqual(ALL_DRAWER_MENU_ITEMS)
  })

  it('默认设置模块不引入任何运行时依赖（架构约束的就地断言）', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'electron/store/app-settings-defaults.ts'),
      'utf8',
    )
    const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)].map(
      (match) => match[1],
    )
    expect(valueImports).toEqual([])
  })
})
