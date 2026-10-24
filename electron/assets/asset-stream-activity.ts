// electron/assets/asset-stream-activity.ts — 流式资产活动登记（基础端口）
//
// custom-chat 的流式请求在录制资产期间登记到此处；基础清理、退出流程与
// prompt-library 的资产清理守卫通过本模块查询或中止，不直接依赖插件实现。

const active = new Set<AbortController>()

/** 登记进行中的流式资产请求；返回释放函数供 finally 调用 */
export function trackAssetStream(controller: AbortController): () => void {
  active.add(controller)
  return () => { active.delete(controller) }
}

/** 是否存在进行中的流式资产请求 */
export function hasActiveAssetStreams(): boolean {
  return active.size > 0
}

/** 中止并清空所有进行中的流式资产请求（退出或清理数据时调用） */
export function abortAllAssetStreams(): void {
  for (const controller of active) {
    try {
      controller.abort()
    } catch (err) {
      console.warn('[asset-stream] 中止流式请求失败:', err)
    }
  }
  active.clear()
}
