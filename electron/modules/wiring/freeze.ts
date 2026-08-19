// electron/modules/wiring/freeze.ts — 页面冻结（防撤回）模块接线
//
// 决策（用户澄清）：「DTS 网页暂停」= 页面冻结（防撤回保险，Debugger.pause 冻结 webview）。
// 与 TTS 同为开发者选项（默认关闭，测试标签）。从浏览器模块抽出为独立模块后，
// 冻结能力随本模块启停；浏览器窗口内的冻结 UI（FreezeOverlay）依赖本模块。
//
// teardown 必须 detachAll：释放所有已挂载的 Debugger（11.5 关闭残留清单）。
//
// Phase 3 试点：使用 EffectScope 替代 IpcScope，演示统一注入管线接入。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerFreezeIpc } from '../../freeze/freeze-ipc.js'

/** 模块级 EffectScope（统一管理 IPC + 事件订阅 + Debugger 等副作用） */
const scope = new EffectScope('freeze', 'freeze')

const FREEZE_CHANNELS = [
  IPC_CHANNELS.FREEZE_REGISTER_WEBVIEW,
  IPC_CHANNELS.FREEZE_TAB,
  IPC_CHANNELS.FREEZE_TOGGLE,
  IPC_CHANNELS.FREEZE_RESUME,
  IPC_CHANNELS.FREEZE_DETACH,
  IPC_CHANNELS.FREEZE_STATUS,
  IPC_CHANNELS.FREEZE_SCROLL,
  IPC_CHANNELS.FREEZE_COPY_TEXT,
]

export function initFreezeModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 传递 scope 给 registerFreezeIpc，使其使用 EffectScope 管理 IPC handler
    registerFreezeIpc(scope)
  })
}

export function teardownFreezeModule(): void {
  // 卸载全部副作用（IPC + 事件订阅 + 定时器等）
  void scope.dispose()
  // 释放所有冻结 webview 的 Debugger（异步，不阻塞禁用流程）
  import('../../freeze/freeze-manager.js')
    .then(({ detachAll }) => {
      void detachAll()
    })
    .catch((err) => {
      console.warn('[wiring:freeze] detachAll 失败:', err)
    })
}

// 冻结快照为内存态，无持久化用户数据；清除数据=释放所有冻结状态
export function clearFreezeData(): void {
  import('../../freeze/freeze-manager.js')
    .then(({ detachAll }) => {
      void detachAll()
    })
    .catch((err) => {
      console.warn('[wiring:freeze] clearFreezeData 失败:', err)
    })
}
