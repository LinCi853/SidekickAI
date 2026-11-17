// download-settings.types.ts — 下载与保存位置设置共享类型
//
// 两层设置：
//   - 全局默认：主应用设置（设置 → 高级 → 下载）里的“下载目录 / 下载行为”，所有 AI 应用默认跟随。
//   - 应用级覆盖：某个 AI 应用可在浏览器设置里改为独立设置，只影响该应用的下载与另存为。
// 生效优先级：Profile.downloadSettings（mode=custom）> 全局 AppSettings。

/** 下载行为：ask=每次询问（弹出自建保存弹窗）/ auto=自动保存到目录 */
export type DownloadBehavior = 'ask' | 'auto'

/** AI 应用级下载设置（绑定单个 AI 应用） */
export interface ProfileDownloadSettings {
  /** default=跟随主应用默认；custom=本应用独立设置 */
  mode: 'default' | 'custom'
  /** 独立设置时的保存目录（留空表示沿用全局目录） */
  downloadDir?: string
  /** 独立设置时的下载行为（留空表示沿用全局行为） */
  downloadBehavior?: DownloadBehavior
}
