// tab-hibernation.types.ts — 历史标签休眠（内存转存储）共享类型
//
// 旧版休眠 = 卸载 guest 进程前，把恢复所需的最小信息落盘；切回时按 url 重载。
// 当前模式保留网页运行态，不再生成这些记录或快照。
// 快照是可选的页面占位图，属于页面内容，纳入保留与清理策略。

/** 一条标签休眠记录 */
export interface TabHibernationEntry {
  /** 标签 id（与 TabState.id 一致） */
  tabId: string
  /** 所属 Profile id（决定 persist 分区，用于恢复时的登录态） */
  profileId: string
  /** 所属窗口 id（'main' 或脱离窗口 UUID） */
  windowId: string
  /** 休眠时的页面 URL，恢复时按此地址重载 */
  url: string
  /** 休眠时的页面标题（占位 UI 展示） */
  title: string
  /** 休眠时间戳（毫秒） */
  hibernatedAt: number
  /** 占位快照文件名（位于 userData/tab-hibernation/），无快照时为 null */
  snapshotPath: string | null
}

/** 快照保留策略：天数与张数双阈值，任一超出即清理 */
export interface TabHibernationPrunePolicy {
  /** 保留天数（0 表示不按时间清理） */
  retentionDays: number
  /** 最多保留张数（0 表示不按张数限制） */
  maxCount: number
}

export interface TabHibernationPruneResult {
  /** 本次删除的记录总数 */
  removed: number
  /** 其中因超过保留天数被删除的数量 */
  expired: number
  /** 顺带回收的孤儿快照数量（无记录引用） */
  orphans: number
}

export interface TabHibernationStats {
  /** 历史元数据条数，不表示当前有同等数量的页面正在休眠。 */
  count: number
  /** 快照目录内实际存在的图片文件数（含尚未清理的孤儿文件）。 */
  snapshotCount: number
  /** 实际快照文件的磁盘字节数，与进程驻留内存无关。 */
  snapshotBytes: number
}

export interface TabHibernationAPI {
  stats(): Promise<TabHibernationStats>
}
