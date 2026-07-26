/* =====================================================================
   ui/Combobox.tsx —— 统一下拉选择组件
   特性：
   - 自适应宽度：下拉面板宽度根据触发器宽度和内容自适应
   - 网格布局：候选项按内容长度自动排列，超出换行
   - 内嵌搜索框：实时过滤候选
   - 统一关闭方式：ESC + 点击外部 + 关闭按钮
   - Portal 渲染：脱离 transform 祖先影响
   ===================================================================== */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useEscToCloseOverlay } from '../../hooks/useEscToCloseWindow';
import './Combobox.css';

export interface ComboboxOption {
  /** 唯一值 */
  value: string;
  /** 显示文本（默认与 value 相同） */
  label?: string;
  /** 是否已选中 */
  selected?: boolean;
  /** 标签（如「主」「TTS」等） */
  tag?: string;
}

export interface ComboboxProps {
  /** 当前输入框值 */
  inputValue: string;
  /** 输入框值变化回调 */
  onInputChange: (value: string) => void;
  /** 输入框 placeholder */
  inputPlaceholder?: string;
  /** 候选项列表 */
  options: ComboboxOption[];
  /** 选中候选项回调（点击候选项时触发） */
  onSelect: (value: string) => void;
  /** 取消选中回调（点击已选中项时触发，可选） */
  onDeselect?: (value: string) => void;
  /** 是否多选（默认 false：单选模式下选中后自动关闭） */
  multiple?: boolean;
  /** 是否启用搜索框（默认 true） */
  searchable?: boolean;
  /** 搜索框 placeholder */
  searchPlaceholder?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义输入框类名 */
  inputClassName?: string;
  /** 自定义根类名 */
  className?: string;
  /** 是否打开（受控模式，可选。不传则由组件内部管理） */
  open?: boolean;
  /** 打开状态变化回调（受控模式） */
  onOpenChange?: (open: boolean) => void;
  /** 空状态文案 */
  emptyText?: string;
  /** 加载中状态 */
  loading?: boolean;
  /** 加载文案 */
  loadingText?: string;
  /** data-name 前缀（用于测试定位） */
  dataName?: string;
  /** 输入框的右键菜单关闭时是否自动聚焦输入框 */
  autoFocusInput?: boolean;
  /**
   * 输入框是否只读（默认 false）。
   *
   * 用于纯选择场景（如 UA 预设、Provider 切换）：输入框仅显示选中项 label，
   * 不可编辑，用户通过下拉箭头 + 搜索框选择。避免用户在输入框输入文本造成困惑。
   */
  inputReadOnly?: boolean;
}

/**
 * 计算下拉面板的位置和尺寸
 *
 * 规则：
 * - 宽度：触发器宽度 + 一定 padding，但不超过 maxViewportWidth
 * - 高度：根据内容量自适应，但不超过 maxViewportHeight
 * - 位置：默认在触发器下方，若空间不足则向上翻转
 */
function calculatePanelPosition(
  triggerRect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): { style: CSSProperties; placement: 'bottom' | 'top' } {
  const GAP = 4;
  const MIN_WIDTH = 240;
  const MAX_WIDTH = Math.min(viewportWidth * 0.8, 560);
  const MAX_HEIGHT = Math.min(viewportHeight * 0.6, 420);

  // 宽度：触发器宽度，但不小于 MIN_WIDTH，不大于 MAX_WIDTH
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, triggerRect.width));

  // 下方剩余空间
  const spaceBelow = viewportHeight - triggerRect.bottom - GAP;
  const spaceAbove = triggerRect.top - GAP;
  // 决定弹出方向：默认下方，若下方空间 < 200 且上方更宽裕则向上
  const placement: 'bottom' | 'top' = spaceBelow < 200 && spaceAbove > spaceBelow ? 'top' : 'bottom';

  let top: number;
  // 面板最大高度由可用空间决定
  let maxHeight: number;
  if (placement === 'bottom') {
    top = triggerRect.bottom + GAP;
    maxHeight = Math.min(MAX_HEIGHT, spaceBelow - 8);
  } else {
    const panelHeight = Math.min(MAX_HEIGHT, spaceAbove - 8);
    top = triggerRect.top - GAP - panelHeight;
    maxHeight = panelHeight;
  }

  // 防止超出右边界
  let left = triggerRect.left;
  if (left + width > viewportWidth - 8) {
    left = viewportWidth - width - 8;
  }
  if (left < 8) left = 8;

  return {
    style: {
      width: `${width}px`,
      maxHeight: `${Math.max(160, maxHeight)}px`,
      top: `${top}px`,
      left: `${left}px`,
    },
    placement,
  };
}

export default function Combobox({
  inputValue,
  onInputChange,
  inputPlaceholder,
  options,
  onSelect,
  onDeselect,
  multiple = false,
  searchable = true,
  searchPlaceholder = '搜索过滤…',
  disabled = false,
  inputClassName,
  className,
  open: controlledOpen,
  onOpenChange,
  emptyText = '无匹配项',
  loading = false,
  loadingText = '加载中…',
  dataName = 'combobox',
  autoFocusInput = false,
  inputReadOnly = false,
}: ComboboxProps) {
  const triggerRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 内部打开状态（非受控模式）
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    else setInternalOpen(v);
  };

  // 搜索关键字
  const [search, setSearch] = useState('');

  // 面板位置样式
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  // ESC 关闭：栈顶时由本组件处理
  useEscToCloseOverlay(isOpen, () => setOpen(false));

  // 打开时计算位置、清空搜索、聚焦搜索框
  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { style } = calculatePanelPosition(rect, vw, vh);
    setPanelStyle(style);
    // 聚焦搜索框（如有）
    if (searchable) {
      // 延迟一帧确保 DOM 已挂载
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // 滚动/调整窗口时重新计算位置
  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const { style } = calculatePanelPosition(rect, window.innerWidth, window.innerHeight);
      setPanelStyle(style);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const triggerEl = triggerRef.current;
      const panelEl = panelRef.current;
      if (triggerEl?.contains(target)) return; // 点击触发器内部
      if (panelEl?.contains(target)) return; // 点击面板内部
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // 搜索过滤
  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options;
    const kw = search.toLowerCase().trim();
    return options.filter((opt) => {
      const text = (opt.label ?? opt.value).toLowerCase();
      return text.includes(kw);
    });
  }, [options, search]);

  // 选中数量
  const selectedCount = options.filter((o) => o.selected).length;

  // 触发器输入框
  const inputClasses = ['combobox-input'];
  if (inputClassName) inputClasses.push(inputClassName);

  const rootClasses = ['combobox'];
  if (className) rootClasses.push(className);
  if (disabled) rootClasses.push('is-disabled');

  const handleArrowClick = () => {
    if (disabled) return;
    setOpen(!isOpen);
  };

  const handleInputFocus = () => {
    // readOnly 模式下由 click 处理打开，避免 focus+click 事件冲突导致自动关闭
    if (inputReadOnly) return;
    if (options.length > 0 && !isOpen) setOpen(true);
  };

  // 只读模式下点击输入框仅打开，不 toggle（避免 focus 已打开后 click 又关闭）
  const handleInputClick = () => {
    if (inputReadOnly && !disabled && !isOpen) setOpen(true);
  };

  const handleOptionClick = (value: string, isSelected: boolean) => {
    if (isSelected && onDeselect) {
      onDeselect(value);
      // 单选模式下取消选中不关闭
      return;
    }
    onSelect(value);
    // 单选模式下选中后自动关闭
    if (!multiple) {
      setOpen(false);
    }
  };

  // 只读模式根类名
  if (inputReadOnly) rootClasses.push('is-readonly');

  return (
    <div className={rootClasses.join(' ')} data-name={dataName}>
      <div className="combobox-trigger">
        <input
          ref={triggerRef}
          type="text"
          className={inputClasses.join(' ')}
          value={inputValue}
          placeholder={inputPlaceholder}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          readOnly={inputReadOnly}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={handleInputFocus}
          onClick={handleInputClick}
          data-name={`${dataName}.input`}
        />
        <button
          type="button"
          className={`combobox-arrow ${isOpen ? 'expanded' : ''}`}
          onClick={handleArrowClick}
          disabled={disabled || (options.length === 0 && !loading)}
          aria-label={isOpen ? '收起' : '展开'}
          title={options.length > 0 ? `${options.length} 个候选` : '无候选'}
          data-name={`${dataName}.arrow`}
        >
          {isOpen ? '▴' : '▾'}
        </button>
      </div>

      {isOpen && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            className="combobox-panel"
            style={panelStyle}
            data-name={`${dataName}.panel`}
          >
            {searchable && (
              <div className="combobox-header" data-name={`${dataName}.header`}>
                <input
                  ref={searchRef}
                  type="text"
                  className="combobox-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                  data-name={`${dataName}.search`}
                />
                <button
                  type="button"
                  className="combobox-close"
                  onClick={() => setOpen(false)}
                  aria-label="关闭"
                  title="关闭（ESC）"
                  data-name={`${dataName}.close`}
                >
                  ×
                </button>
              </div>
            )}
            <div className="combobox-body" data-name={`${dataName}.body`}>
              {loading ? (
                <div className="combobox-loading" data-name={`${dataName}.loading`}>{loadingText}</div>
              ) : filteredOptions.length === 0 ? (
                <div className="combobox-empty" data-name={`${dataName}.empty`}>
                  {emptyText}
                </div>
              ) : (
                filteredOptions.map((opt) => {
                  const label = opt.label ?? opt.value;
                  const isSelected = !!opt.selected;
                  return (
                    <button
                      type="button"
                      key={opt.value}
                      className={`combobox-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleOptionClick(opt.value, isSelected)}
                      title={label}
                      data-name={`${dataName}.option.${opt.value}`}
                    >
                      {opt.tag && <span className="combobox-option-tag">{opt.tag}</span>}
                      <span className="combobox-option-label">{label}</span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="combobox-footer" data-name={`${dataName}.footer`}>
              <span>
                {loading
                  ? loadingText
                  : `${filteredOptions.length}/${options.length} 项${
                      multiple && selectedCount > 0 ? ` · 已选 ${selectedCount}` : ''
                    }`}
              </span>
              <span className="combobox-footer-hint">ESC 关闭</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export type { ComboboxProps as ComboboxPropsType };
