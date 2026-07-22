export interface SettingsPanelProps {
  /** 是否展开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 打开快捷键查看弹窗（直达按钮，挂在「全局热键」分区右侧） */
  onOpenShortcuts?: () => void;
}
