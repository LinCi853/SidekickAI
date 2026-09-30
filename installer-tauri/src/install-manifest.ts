// Installation types for the runtime getInfo response. Product features and
// defaults are generated from the application and read from embedded metadata.

export interface InstallFeature {
  /** 与 ModuleManifest.id 一致 */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话说明 */
  description: string
  /** 稳定功能 / 实验功能（UI 分区用） */
  category: 'stable' | 'dev'
  /** 默认是否启用 */
  defaultEnabled: boolean
  /** 是否为核心功能（不可在安装期关闭） */
  required?: boolean
  /** 需独立安装才能使用（安装前选定，安装中不可调整） */
  installRequired?: boolean
  /** 体积级别：large = 需独立安装 / small = 恒随包 */
  sizeLevel: 'large' | 'small'
}

export interface InstallOption {
  id: string
  label: string
  description: string
  type: 'boolean' | 'choice'
  defaultValue: boolean | string
  choices?: { value: string; label: string }[]
  /** 选项分组页（behavior / logging）；空 = 不分页 */
  page?: 'behavior' | 'logging'
}

/** 协议文档（用户许可 / 开源许可 / 隐私政策等），驱动协议页 tab 列表 */
export interface LicenseDoc {
  id: string
  title: string
  /** 默认打开的协议（用户许可协议） */
  defaultOpen: boolean
  body: string
}
