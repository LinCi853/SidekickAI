// electron/modules/wiring/oxy.ts — Oxy Design System 模块接线
//
// 将 Oxy 界面系统接入统一模块管线：注册/注销模块状态，同步 UI 版本。
// 实际的 CSS 变量注入、布局计算等副作用由渲染层 oxy-design-system.ts 控制器处理，
// 本 wiring 负责主进程侧的模块生命周期管理与跨窗口状态同步。
//
// teardown 零残留：广播所有窗口恢复经典版。
// APP_UI_VERSION_CHANGED 的 IPC 广播已由 app-settings-store.ts 注册，此处不重复。

import { EffectScope } from '../effect-scope.js'
import { broadcastUiVersionChanged } from '../../store/app-settings-store.js'

const scope = new EffectScope('oxy', 'oxy-ui-framework')

export function initOxyModule(): void {
  // 幂等：先清理旧注册再注册
  void scope.dispose().then(() => {
    // APP_UI_VERSION_CHANGED 已由 app-settings-store.ts 的 registerAppSettingsIPC() 注册，
    // 此处不重复注册 handler，仅管理模块生命周期。
    console.log('[wiring:oxy] Oxy 模块已启用')
  })
}

export function teardownOxyModule(): void {
  // 1. 撤销所有副作用
  void scope.dispose()

  // 2. 广播所有窗口恢复经典版（使用现有广播函数，与 app-settings-store 保持一致）
  broadcastUiVersionChanged({ uiVersion: 'classic', theme: 'light' })
  console.log('[wiring:oxy] Oxy 模块已禁用，已广播恢复经典版')
}

export function clearOxyData(): void {
  teardownOxyModule()
  // Oxy 无持久化用户数据需清除，localStorage 由渲染层管理
  console.log('[wiring:oxy] 数据已清除（Oxy 无持久化用户数据）')
}
