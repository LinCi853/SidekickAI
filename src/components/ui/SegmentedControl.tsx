/* =====================================================================
   ui/SegmentedControl.tsx —— 分段控件
   依赖 globals.css 的 .seg-btn 全局类
   替代 .proxy-mode-btn / .voice-mode-btn / .platform-region-btn / .platform-status-btn
   ===================================================================== */

import type { ReactNode } from 'react';
import { Fragment } from 'react';

export interface SegmentedOption<T extends string> {
  /** 选项值 */
  value: T;
  /** 选项标签（可为文本或图标） */
  label: ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** 当前选中值 */
  value: T;
  /** 选项列表 */
  options: SegmentedOption<T>[];
  /** 选中变更回调 */
  onChange: (value: T) => void;
  /** 用于分组的无障碍 name */
  name?: string;
  /** 是否禁用整个控件 */
  disabled?: boolean;
  /** 额外类名（应用到容器） */
  className?: string;
}

/**
 * 分段控件 —— 用于在多个互斥选项间切换
 *
 * @example
 * <SegmentedControl
 *   value={theme}
 *   onChange={setTheme}
 *   options={[
 *     { value: 'light', label: '亮色' },
 *     { value: 'dark', label: '暗色' },
 *   ]}
 * />
 */
export default function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  name,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={className}
      data-name="ui.segmented-control.container"
    >
      {options.map((opt, index) => {
        const isActive = opt.value === value;
        const isDisabled = disabled || opt.disabled;
        return (
          <Fragment key={opt.value}>
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              className={`seg-btn${isActive ? ' is-active' : ''}`}
              disabled={isDisabled}
              onClick={() => !isDisabled && onChange(opt.value)}
              data-name={`ui.segmented-control.option-button-${index}`}
            >
              {opt.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
