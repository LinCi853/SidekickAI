// electron/modules/wiring/block-rules.ts — 广告屏蔽规则模块接线
//
// 将屏蔽规则接入统一模块管线。
// 模块启用时：注册 IPC handler，填充默认规则。
// 模块禁用时：注销 IPC handler，广播渲染层停止注入。
//
// 持久化用户数据（block-rules.json）由 block-rules-store 管理，
// teardown 不删除用户规则，仅停止注入行为。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { broadcastToAllWindows } from '../../shared/broadcast.js'

const scope = new EffectScope('block-rules', 'block-rules')

export function initBlockRulesModule(): void {
  void scope.dispose().then(() => {
    // IPC handler 已由 registerBlockRulesIPC() 在 main.ts 中注册（block-rules-store.ts），
    // 此处不重复注册，仅管理生命周期广播。
    broadcastToAllWindows('block-rules:changed', { enabled: true }, 'block-rules-module')
    console.log('[wiring:block-rules] 屏蔽规则模块已启用')
  })
}

export function teardownBlockRulesModule(): void {
  void scope.dispose()

  // 广播渲染层：屏蔽规则已禁用，停止注入
  broadcastToAllWindows('block-rules:changed', { enabled: false }, 'block-rules-module-teardown')
  console.log('[wiring:block-rules] 屏蔽规则模块已禁用')
}

export function clearBlockRulesData(): void {
  teardownBlockRulesModule()
  // 清除用户自定义规则（保留内置规则）
  try {
    const { blockRulesStore } = require('../../store/block-rules-store.js')
    blockRulesStore.clearUserData?.()
  } catch { /* store 可能未初始化 */ }
  console.log('[wiring:block-rules] 用户自定义屏蔽规则已清除')
}
