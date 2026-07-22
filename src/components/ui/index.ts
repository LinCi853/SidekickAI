/* =====================================================================
   ui/index.ts —— React UI 组件库 barrel
   统一导出所有 UI 组件，便于页面用 `import { Button, IconButton } from '../components/ui'`
   ===================================================================== */

export { default as Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';

export { default as IconButton } from './IconButton';
export type { IconButtonProps, IconButtonVariant } from './IconButton';

export { default as Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

export { default as Chip } from './Chip';
export type { ChipProps } from './Chip';

export { default as Toggle } from './Toggle';
export type { ToggleProps } from './Toggle';

export { default as SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { default as WindowControls } from './WindowControls';
export type { WindowControlsProps } from './WindowControls';

export { default as Card } from './Card';
export type { CardProps } from './Card';

export { default as ListItem } from './ListItem';
export type { ListItemProps } from './ListItem';

export { default as Modal } from './Modal';
export type { ModalProps } from './Modal';

export { default as HotkeyRecorder } from './HotkeyRecorder';
export type { HotkeyRecorderProps, OtherHotkey } from './HotkeyRecorder';
