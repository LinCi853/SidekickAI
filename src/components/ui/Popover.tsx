/* =====================================================================
   components/ui/Popover.tsx —— 通用二级菜单/弹出层组件
   统一封装：遮罩、搜索、ESC关闭、点击外部、安全定位、分区显示
   ===================================================================== */

import { 
  useEffect, 
  useState, 
  useRef, 
  type ReactNode, 
  type CSSProperties
} from 'react';
import { createPortal } from 'react-dom';
import './Popover.css';

/* =====================================================================
   类型定义
   ===================================================================== */

/** 弹出层位置 */
export interface PopoverPosition {
  x: number;
  y: number;
}

/** 弹出层配置 */
export interface PopoverConfig {
  /** 是否显示遮罩（默认 false） */
  overlay?: boolean;
  /** 遮罩点击是否关闭（默认 true） */
  closeOnOverlayClick?: boolean;
  /** 是否启用 ESC 关闭（默认 true） */
  closeOnEsc?: boolean;
  /** 是否启用点击外部关闭（默认 true） */
  closeOnOutsideClick?: boolean;
  /** 是否使用 Portal 渲染到 body（默认 false） */
  usePortal?: boolean;
  /** z-index（默认 200） */
  zIndex?: number;
  /** 背景样式：'solid' | 'glass'（默认 'solid'） */
  background?: 'solid' | 'glass';
}

/** 弹出层变体类型 */
export type PopoverVariant = 
  | 'dropdown'      // 下拉菜单
  | 'context-menu'  // 右键菜单
  | 'panel'         // 面板（搜索、设置等）
  | 'dialog'        // 对话框
  | 'tooltip';      // 提示框

/** 分区配置 */
export interface PopoverSection {
  /** 分区标签 */
  label?: string;
  /** 分区内容 */
  children: ReactNode;
  /** 是否显示分隔线 */
  divider?: boolean;
}

/** 搜索配置 */
export interface PopoverSearch {
  /** 搜索占位符 */
  placeholder?: string;
  /** 搜索值 */
  value: string;
  /** 搜索变更回调 */
  onChange: (value: string) => void;
  /** 是否自动聚焦 */
  autoFocus?: boolean;
}

/** Popover 组件属性 */
export interface PopoverProps {
  /** 是否显示 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 弹出层内容 */
  children: ReactNode;
  /** 触发元素的 ref（用于定位） */
  triggerRef?: React.RefObject<HTMLElement>;
  /** 位置（固定定位时使用） */
  position?: PopoverPosition;
  /** 变体类型 */
  variant?: PopoverVariant;
  /** 配置选项 */
  config?: PopoverConfig;
  /** 搜索配置 */
  search?: PopoverSearch;
  /** 分区列表 */
  sections?: PopoverSection[];
  /** 自定义类名 */
  className?: string;
  /** data-name 属性 */
  dataName?: string;
  /** 自定义样式 */
  style?: CSSProperties;
  /** 宽度（可选） */
  width?: number | string;
  /** 最大高度（可选） */
  maxHeight?: number | string;
}

/* =====================================================================
   安全位置计算 Hook
   ===================================================================== */

function useSafePosition(
  isOpen: boolean,
  position: PopoverPosition | undefined,
  triggerRef: React.RefObject<HTMLElement> | undefined,
  variant: PopoverVariant
) {
  const [safePos, setSafePos] = useState<CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const calculatePosition = () => {
      const el = menuRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const GAP = 8;

      let left = position?.x ?? 0;
      let top = position?.y ?? 0;

      // 如果有触发元素，基于触发元素定位
      if (triggerRef?.current) {
        const triggerRect = triggerRef.current.getBoundingClientRect();
        
        switch (variant) {
          case 'dropdown':
            left = triggerRect.left;
            top = triggerRect.bottom + 4;
            break;
          case 'context-menu':
            // 使用传入的 position
            break;
          case 'panel':
            left = triggerRect.left;
            top = triggerRect.bottom + 4;
            break;
          default:
            break;
        }
      }

      // 防止超出右边界
      if (left + rect.width > vw - GAP) {
        left = vw - rect.width - GAP;
      }
      if (left < GAP) left = GAP;

      // 防止超出下边界
      if (top + rect.height > vh - GAP) {
        // 如果是 dropdown，尝试显示在上方
        if (variant === 'dropdown' && triggerRef?.current) {
          const triggerRect = triggerRef.current.getBoundingClientRect();
          top = triggerRect.top - rect.height - 4;
        } else {
          top = vh - rect.height - GAP;
        }
      }
      if (top < GAP) top = GAP;

      setSafePos({ left, top });
    };

    // 使用 requestAnimationFrame 确保 DOM 已更新
    requestAnimationFrame(calculatePosition);
  }, [isOpen, position, triggerRef, variant]);

  return { menuRef, safePos };
}

/* =====================================================================
   Popover 组件
   ===================================================================== */

export default function Popover({
  isOpen,
  onClose,
  children,
  triggerRef,
  position,
  variant = 'dropdown',
  config = {},
  search,
  sections,
  className = '',
  dataName = 'popover',
  style,
  width,
  maxHeight,
}: PopoverProps) {
  const {
    overlay = false,
    closeOnOverlayClick = true,
    closeOnEsc = true,
    closeOnOutsideClick = true,
    usePortal = false,
    zIndex = 200,
    background = 'solid',
  } = config;

  const { menuRef, safePos } = useSafePosition(isOpen, position, triggerRef, variant);

  // ESC 关闭
  useEffect(() => {
    if (!isOpen || !closeOnEsc) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 输入框聚焦时不处理 ESC
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEsc, onClose]);

  // 点击外部关闭 - 使用透明遮罩层解决 webview 捕获事件问题
  useEffect(() => {
    if (!isOpen || !closeOnOutsideClick || overlay) return;

    // 创建透明遮罩层覆盖整个屏幕
    const overlayEl = document.createElement('div');
    overlayEl.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: ${zIndex - 1};
      background: transparent;
    `;
    overlayEl.setAttribute('data-name', 'popover-click-outside-overlay');

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // 如果点击的是菜单内部，不关闭
      if (menuRef.current?.contains(target)) return;
      // 如果点击的是触发元素，不关闭
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };

    overlayEl.addEventListener('mousedown', handleClickOutside);
    document.body.appendChild(overlayEl);

    return () => {
      overlayEl.removeEventListener('mousedown', handleClickOutside);
      if (overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
    };
  }, [isOpen, closeOnOutsideClick, overlay, onClose, triggerRef, zIndex]);

  if (!isOpen) return null;

  const isFixed = variant === 'context-menu' || variant === 'dialog';

  const popoverStyle: CSSProperties = {
    position: isFixed ? 'fixed' : 'absolute',
    zIndex,
    ...style,
    ...safePos,
    width,
    maxHeight,
  };

  const content = (
    <>
      {/* 遮罩层 */}
      {overlay && (
        <div
          className={`popover-overlay${background === 'glass' ? ' glass' : ''}`}
          style={{ zIndex: zIndex - 1 }}
          onClick={closeOnOverlayClick ? onClose : undefined}
          data-name={`${dataName}.overlay`}
        />
      )}
      
      {/* 弹出层主体 */}
      <div
        ref={menuRef}
        className={`popover popover-${variant} popover-bg-${background} ${className}`}
        style={popoverStyle}
        data-name={dataName}
      >
        {/* 搜索框 */}
        {search && (
          <div className="popover-search" data-name={`${dataName}.search`}>
            <input
              className="popover-search-input"
              type="text"
              placeholder={search.placeholder || '搜索...'}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              autoFocus={search.autoFocus}
              data-name={`${dataName}.search-input`}
            />
          </div>
        )}

        {/* 内容区域 */}
        {sections ? (
          <div className="popover-sections" data-name={`${dataName}.sections`}>
            {sections.map((section, index) => (
              <div key={index} className="popover-section" data-name={`${dataName}.section-${index}`}>
                {section.label && (
                  <div className="popover-section-label" data-name={`${dataName}.section-${index}-label`}>
                    {section.label}
                  </div>
                )}
                <div className="popover-section-content" data-name={`${dataName}.section-${index}-content`}>
                  {section.children}
                </div>
                {section.divider && index < sections.length - 1 && (
                  <div className="popover-divider" data-name={`${dataName}.section-${index}-divider`} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="popover-content" data-name={`${dataName}.content`}>
            {children}
          </div>
        )}
      </div>
    </>
  );

  // 始终使用 Portal 渲染到 body，确保菜单在遮罩层上面
  return createPortal(content, document.body);
}

/* =====================================================================
   菜单项组件
   ===================================================================== */

export interface PopoverItemProps {
  /** 点击回调 */
  onClick?: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为危险操作 */
  danger?: boolean;
  /** 是否激活（如选中状态） */
  active?: boolean;
  /** 图标 */
  icon?: ReactNode;
  /** 标签 */
  label: string;
  /** 快捷键提示 */
  shortcut?: string;
  /** data-name 属性 */
  dataName?: string;
}

export function PopoverItem({
  onClick,
  disabled = false,
  danger = false,
  active = false,
  icon,
  label,
  shortcut,
  dataName = 'popover-item',
}: PopoverItemProps) {
  const classNames = [
    'popover-item',
    danger ? 'danger' : '',
    active ? 'active' : '',
    disabled ? 'disabled' : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={classNames}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-name={dataName}
    >
      {icon && (
        <span className="popover-item-icon" data-name={`${dataName}.icon`}>
          {icon}
        </span>
      )}
      <span className="popover-item-label" data-name={`${dataName}.label`}>
        {label}
      </span>
      {shortcut && (
        <span className="popover-item-shortcut" data-name={`${dataName}.shortcut`}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

/* =====================================================================
   分隔线组件
   ===================================================================== */

export function PopoverDivider({ dataName = 'popover-divider' }: { dataName?: string }) {
  return <div className="popover-divider" data-name={dataName} />;
}