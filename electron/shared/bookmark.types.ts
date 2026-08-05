// bookmark.types.ts — 浏览器书签类型定义（v0.0.9）
//
// 书签为全局数据，跨所有 AI 应用汇聚，但记录来源应用信息（profileId +
// profileName 快照 + aiPlatformId + platformName 快照），避免 Profile 删除后
// 丢失来源标识。存储于独立 SQLite db（bookmarks.db）。

/** 书签条目 */
export interface Bookmark {
  /** 书签唯一 id（UUID） */
  id: string
  /** 书签标题（用户可编辑，默认取页面 title） */
  title: string
  /** 书签网址 */
  url: string
  /** 站点 favicon（data URL 或 http URL，可选） */
  favicon?: string
  /** 来源 Profile id 快照 */
  profileId: string
  /** 来源 Profile 名称快照（Profile 删除后仍可辨识来源） */
  profileName: string
  /** 来源 AI 平台 id 快照（可选） */
  aiPlatformId?: string
  /** 来源 AI 平台名称快照（可选） */
  platformName?: string
  /** 是否显示到书签栏（false=仅出现在书签管理器，true=同时出现在书签栏） */
  inBookmarkBar: boolean
  /** 排序（书签栏内顺序，从 0 开始） */
  order: number
  /** 创建时间戳（ms） */
  createdAt: number
  /** 最近更新时间戳（ms） */
  updatedAt: number
}

/** 新建书签的输入参数（id/createdAt/updatedAt 由 store 自动生成） */
export interface BookmarkInput {
  title: string
  url: string
  favicon?: string
  profileId: string
  profileName: string
  aiPlatformId?: string
  platformName?: string
  inBookmarkBar?: boolean
}

/** 书签查询过滤条件 */
export interface BookmarkFilter {
  /** 仅查指定 Profile 的书签 */
  profileId?: string
  /** 仅查书签栏内书签（in_bookmark_bar=1） */
  barOnly?: boolean
}

/** 书签更新补丁（部分字段） */
export interface BookmarkPatch {
  title?: string
  url?: string
  favicon?: string
  inBookmarkBar?: boolean
}
