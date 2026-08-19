// electron/modules/capability.ts — 功能贡献声明（主进程侧）
//
// re-export 共享层类型，并提供主进程专用的辅助函数。
// 共享层定义（electron/shared/module-manifest.types.ts）避免循环依赖。

export type {
  CapabilityRef as Capability,
  EffectKind,
  CapabilityScope,
  CapabilityTrigger,
} from '../shared/module-manifest.types.js'

import type { CapabilityRef } from '../shared/module-manifest.types.js'

/** 从 manifest 的 capabilities 字段提取声明（扁平化） */
export function extractCapabilities(manifests: { id: string; capabilities?: CapabilityRef[] }[]): CapabilityRef[] {
  const result: CapabilityRef[] = []
  for (const m of manifests) {
    if (m.capabilities) {
      result.push(...m.capabilities)
    }
  }
  return result
}
