// installer-tauri/src/types.ts
// 安装向导步骤与选项分页的共享类型

export type StepId =
  | 'welcome'
  | 'license'
  | 'location'
  | 'installing'
  | 'done'

/** 每个模式的步骤序列（步骤条展示用） */
export const MODE_STEPS: Record<'install' | 'repair', { id: StepId; label: string }[]> = {
  install: [
    { id: 'welcome', label: '欢迎' },
    { id: 'license', label: '许可协议' },
    { id: 'location', label: '安装选项' },
    { id: 'installing', label: '安装中' },
    { id: 'done', label: '完成' }
  ],
  repair: [
    { id: 'welcome', label: '选择模式' },
    { id: 'location', label: '选择目标' },
    { id: 'installing', label: '修复中' },
    { id: 'done', label: '完成' }
  ],
}

/** 选项分页：功能开关 / 应用行为 / 日志（独立安装组件仅在安装前选择） */
export type OptionsTab = 'toggles' | 'behavior' | 'logging'
