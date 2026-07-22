// fingerprint.types.ts — 指纹配置类型
// 由 shared/types.ts 拆分而来；类型定义内容保持原样，仅做物理拆分。

// ============================================================================
// 基础枚举
// ============================================================================

/** 指纹模式：noise 注入微噪声 / block 返回空值 / real 不干预 */
export type FingerprintMode = 'noise' | 'block' | 'real'

// ============================================================================
// Profile 数据模型（核心）
// ============================================================================

/** 指纹配置：每个维度的覆盖策略 */
export interface FingerprintConfig {
  /** 随机种子（保证同一 Profile 每次启动指纹值一致） */
  seed: number
  /** Canvas 指纹策略 */
  canvas: FingerprintMode
  /** WebGL 指纹策略 */
  webgl: FingerprintMode
  /** AudioContext 指纹策略 */
  audio: FingerprintMode
  /** 字体指纹策略 */
  fonts: FingerprintMode
  /** WebRTC 策略（real=不干预 / block=禁用） */
  webrtc: 'real' | 'block'
}
