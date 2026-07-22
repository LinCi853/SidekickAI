// shared/naming.ts — 名称冲突解决工具（纯函数，无 electron 依赖）
//
// 主进程（profile-store.duplicate / createAIAppFromPlatform）与
// 渲染层（AiAppEditor 创建模式自动重命名）共用同一份实现，避免双端逻辑漂移。

/**
 * 生成不冲突的唯一名称。
 * 若 base 不冲突直接返回；否则追加 `-2`、`-3`... 直到唯一。
 *
 * 用于：
 * - 主进程 Profile 复制 / 基于平台创建新 Profile 时保证名称唯一
 * - 渲染层 AiAppEditor 创建模式下用户输入重名时自动追加后缀，避免阻塞创建
 *
 * @param base 期望的名称
 * @param existingNames 已存在的名称列表
 * @returns 不冲突的唯一名称
 */
export function generateUniqueName(base: string, existingNames: string[]): string {
  if (!existingNames.includes(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!existingNames.includes(candidate)) return candidate
  }
}
