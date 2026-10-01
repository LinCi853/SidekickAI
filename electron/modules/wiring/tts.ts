// electron/modules/wiring/tts.ts — TTS 模块接线（init / teardown / clearData）
//
// 硬依赖 custom-chat（供应商 ttsModel 端点）；注册表级联保证 custom-chat 关时
// TTS 一并关闭（见 registry.ts）。
//
// 已迁移到统一注入管线（EffectScope）。

import { EffectScope } from '../effect-scope.js'
import { registerTtsTestIpc } from '../../ipc/voice-ipc.js'
import { updateVoiceConfig } from '../../store/voice-store.js'

/** 模块级 EffectScope */
const scope = new EffectScope('tts', 'tts')

export async function initTtsModule(): Promise<void> {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  await scope.dispose()
  // 传递 scope 给 registerTtsTestIpc，使其使用 EffectScope 管理 IPC handler
  registerTtsTestIpc(scope)
}

export async function teardownTtsModule(): Promise<void> {
  await scope.dispose()
}

export function clearTtsData(): void {
  updateVoiceConfig({ ttsMode: 'disable', ttsProvider: '' })
  console.log('[wiring:tts] 数据已清除')
}
