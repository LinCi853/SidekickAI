/* =====================================================================
   ui/Button.tsx —— 通用按钮组件
   从 globals.css 的 .btn / .btn-primary / .btn-ghost 移植为 React 组件
   支持 primary / ghost / danger / link / primary-compact / text 六种变体
   ===================================================================== */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'ghost'
  | 'danger'
  | 'link'
  | 'primary-compact'
  | 'primary-flat'
  | 'text'
  | 'outline';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮变体 */
  variant?: ButtonVariant;
  /** danger 修饰（仅 text 变体生效，添加 is-danger 类） */
  danger?: boolean;
  /** 按钮内容 */
  children: ReactNode;
}

/** 计算按钮 className —— 组合基础类 + 变体类 */
function resolveClass(variant: ButtonVariant, danger?: boolean, extra?: string): string {
  const variantClass =
    variant === 'primary' ? 'btn-primary'
    : variant === 'danger' ? 'btn-danger'
    : variant === 'link' ? 'btn-link'
    : variant === 'primary-compact' ? 'btn-primary-compact'
    : variant === 'primary-flat' ? 'btn-primary-flat'
    : variant === 'text' ? 'btn-text'
    : variant === 'outline' ? 'btn-outline'
    : 'btn-ghost';
  // link / outline / primary-flat 变体不继承 .btn 基类（自带 padding 与边框样式）
  const base = (variant === 'link' || variant === 'outline' || variant === 'primary-flat') ? '' : 'btn';
  const dangerMod = danger && variant === 'text' ? 'is-danger' : '';
  return [base, variantClass, dangerMod, extra].filter(Boolean).join(' ');
}

/**
 * 通用按钮 —— 视觉风格继承 globals.css 全局类
 *
 * @example
 * <Button variant="primary" onClick={handleSave}>保存</Button>
 * <Button variant="ghost" onClick={handleCancel}>取消</Button>
 * <Button variant="danger" onClick={handleDelete}>删除</Button>
 * <Button variant="text" danger onClick={handleForceQuit}>强制退出</Button>
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  danger = false,
  className,
  children,
  ...rest
}, ref) {
  return (
    <button ref={ref} className={resolveClass(variant, danger, className)} {...rest}>
      {children}
    </button>
  );
});

export default Button;
