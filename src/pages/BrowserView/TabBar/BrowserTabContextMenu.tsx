/* =====================================================================
   pages/BrowserView/TabBar/BrowserTabContextMenu.tsx —— 标签右键菜单（v0.0.9）
   8 项：右侧新建 / 重新加载 / 复制 / 固定 / 静音 / 关闭 / 关闭其他 / 关闭右侧
   不使用遮罩，参考主窗口 TabContextMenu 设计：ESC + mousedown 外部关闭
   ===================================================================== */

import Popover, { PopoverItem, PopoverDivider } from '../../../components/ui/Popover';

import type { BrowserTabState } from '../../../lib/electron-api';

interface BrowserTabContextMenuProps {
  position: { x: number; y: number };
  tab: BrowserTabState;
  onClose: () => void;
  onNewToRight: () => void;
  onReload: () => void;
  onForceReload: () => void;
  onDuplicate: () => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  /** 冻结/恢复此页面（防撤回保险） */
  onToggleFreeze?: () => void;
  /** 当前是否处于冻结态（控制菜单文案） */
  isFrozen?: boolean;
}

export default function BrowserTabContextMenu({
  position,
  tab,
  onClose,
  onNewToRight,
  onReload,
  onForceReload,
  onDuplicate,
  onTogglePin,
  onToggleMute,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onToggleFreeze,
  isFrozen,
}: BrowserTabContextMenuProps) {


  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Popover
      isOpen={true}
      onClose={onClose}
      position={position}
      variant="context-menu"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      dataName="browser.tab-context-menu"
    >
      <PopoverItem onClick={run(onNewToRight)} label="在右侧新建标签页" dataName="browser.tab-ctx-new-to-right" />
      <PopoverItem onClick={run(onReload)} label="重新加载" dataName="browser.tab-ctx-reload" />
      <PopoverItem onClick={run(onForceReload)} label="强制刷新（清除缓存）" dataName="browser.tab-ctx-force-reload" />
      <PopoverItem onClick={run(onDuplicate)} label="复制" dataName="browser.tab-ctx-duplicate" />
      <PopoverDivider />
      <PopoverItem 
        onClick={run(onTogglePin)} 
        label={tab.pinned ? '取消固定' : '固定标签页'}
        active={tab.pinned}
        dataName="browser.tab-ctx-toggle-pin" 
      />
      <PopoverItem
        onClick={run(onToggleMute)}
        label={tab.muted ? '取消静音' : '静音标签页'}
        active={tab.muted}
        dataName="browser.tab-ctx-toggle-mute"
      />
      {onToggleFreeze && (
        <>
          <PopoverDivider />
          <PopoverItem
            onClick={run(onToggleFreeze)}
            label={isFrozen ? '恢复页面（解除冻结）' : '冻结此页面（防撤回）'}
            active={isFrozen}
            dataName="browser.tab-ctx-toggle-freeze"
          />
        </>
      )}
      <PopoverDivider />
      <PopoverItem onClick={run(onCloseOthers)} label="关闭其他标签页" dataName="browser.tab-ctx-close-others" />
      <PopoverItem onClick={run(onCloseRight)} label="关闭右侧标签页" dataName="browser.tab-ctx-close-right" />
      <PopoverItem onClick={run(onCloseTab)} label="关闭" danger dataName="browser.tab-ctx-close" />
    </Popover>
  );
}
