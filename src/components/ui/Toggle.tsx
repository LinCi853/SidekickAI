/* =====================================================================
   ui/Toggle.tsx —— 开关组件
   依赖 globals.css 的 .toggle / .toggle-track 全局类
   统一设计：label + checkbox input + span.toggle-track 结构
   ===================================================================== */

export interface ToggleProps {
  /** 当前开关状态 */
  checked: boolean;
  /** 状态变更回调 */
  onChange: (checked: boolean) => void;
  /** 无障碍标签 */
  'aria-label'?: string;
  /** 是否禁用 */
  disabled?: boolean;
}

/**
 * 开关 —— 用于设置项的布尔切换
 *
 * @example
 * <Toggle checked={enterToSend} onChange={setEnterToSend} aria-label="回车发送" />
 */
export default function Toggle({
  checked,
  onChange,
  disabled = false,
  ...rest
}: ToggleProps) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
      <span className="toggle-track" />
    </label>
  );
}
