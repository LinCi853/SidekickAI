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
  variant?: ButtonVariant;
  /** Applies destructive text styling to the text variant. */
  danger?: boolean;
  children: ReactNode;
}

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
  // These variants define their own geometry without the base button class.
  const base = (variant === 'link' || variant === 'outline' || variant === 'primary-flat') ? '' : 'btn';
  const dangerMod = danger && variant === 'text' ? 'is-danger' : '';
  return [base, variantClass, dangerMod, extra].filter(Boolean).join(' ');
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'outline',
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
