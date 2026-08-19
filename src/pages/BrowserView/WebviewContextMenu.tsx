/* =====================================================================
   pages/BrowserView/WebviewContextMenu.tsx —— Webview 页面右键菜单
   根据右键位置显示不同菜单项（现代浏览器标准）：
   - 普通页面：后退/前进/重新加载/另存为/打印/查看网页源代码/检查
     （页面存在选中文本时，顶部增加「复制」）
   - 输入框：撤销/重做/剪切/复制/粘贴/粘贴为纯文本/全选/检查
   - 链接：在新标签页打开/复制链接地址/链接另存为 + 普通页面项
   - 图片：另存为/复制图片/复制图片地址 + 普通页面项
   菜单项的禁用状态由 Electron context-menu 事件的标准 editFlags 驱动
   （canUndo/canRedo/canCut/canCopy/canPaste/canSelectAll）。
   ===================================================================== */

import Popover, { PopoverItem, PopoverDivider } from '../../components/ui/Popover';
import type { WebviewContextMenuParams } from '../../lib/webview';

export type WebviewContextType = 'page' | 'input' | 'link' | 'image';

/** 编辑能力标志（对应 Electron EditFlags，驱动输入框菜单禁用状态） */
export type WebviewEditFlags = WebviewContextMenuParams['editFlags'];

interface WebviewContextMenuProps {
  position: { x: number; y: number };
  contextType: WebviewContextType;
  onClose: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onSaveAs: () => void;
  onPrint: () => void;
  onViewSource: () => void;
  onInspect: () => void;
  /** 截图当前页面（可见区域） */
  onScreenshot?: () => void;
  /** 页面缩放 */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  /** 云电脑模式 */
  onToggleCloudPc?: () => void;
  isCloudPc?: boolean;
  /** 页面选中文本时显示「复制」 */
  onCopySelection?: () => void;
  /** 链接相关 */
  onOpenLinkInNewTab?: () => void;
  onCopyLinkAddress?: () => void;
  /** 链接另存为（下载链接 URL 到用户指定路径） */
  onSaveLinkAs?: () => void;
  /** 图片相关 */
  onSaveImage?: () => void;
  onCopyImage?: () => void;
  onCopyImageUrl?: () => void;
  /** 输入框相关 */
  onUndo?: () => void;
  onRedo?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onPasteAsPlainText?: () => void;
  onSelectAll?: () => void;
  /** 状态 */
  canGoBack: boolean;
  canGoForward: boolean;
  /** 页面是否有选中文本 */
  hasSelection: boolean;
  /** 输入框编辑能力标志（缺省时所有编辑项启用，兼容旧调用方） */
  editFlags?: WebviewEditFlags;
}

export default function WebviewContextMenu({
  position,
  contextType,
  onClose,
  onGoBack,
  onGoForward,
  onReload,
  onSaveAs,
  onPrint,
  onViewSource,
  onInspect,
  onScreenshot,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleCloudPc,
  isCloudPc,
  onCopySelection,
  onOpenLinkInNewTab,
  onCopyLinkAddress,
  onSaveLinkAs,
  onSaveImage,
  onCopyImage,
  onCopyImageUrl,
  onUndo,
  onRedo,
  onCut,
  onCopy,
  onPaste,
  onPasteAsPlainText,
  onSelectAll,
  canGoBack,
  canGoForward,
  hasSelection,
  editFlags,
}: WebviewContextMenuProps) {
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // 输入框右键菜单（编辑能力由 editFlags 驱动）
  if (contextType === 'input') {
    return (
      <Popover
        isOpen={true}
        onClose={onClose}
        position={position}
        variant="context-menu"
        config={{ closeOnOutsideClick: true, closeOnEsc: true }}
        dataName="browser.webview-context-menu"
      >
        <PopoverItem onClick={run(onUndo!)} label="撤销" shortcut="Ctrl+Z" disabled={!onUndo || editFlags?.canUndo === false} dataName="browser.webview-ctx-undo" />
        <PopoverItem onClick={run(onRedo!)} label="重做" shortcut="Ctrl+Y" disabled={!onRedo || editFlags?.canRedo === false} dataName="browser.webview-ctx-redo" />
        <PopoverDivider />
        <PopoverItem onClick={run(onCut!)} label="剪切" shortcut="Ctrl+X" disabled={!onCut || editFlags?.canCut === false} dataName="browser.webview-ctx-cut" />
        <PopoverItem onClick={run(onCopy!)} label="复制" shortcut="Ctrl+C" disabled={!onCopy || editFlags?.canCopy === false} dataName="browser.webview-ctx-copy" />
        <PopoverItem onClick={run(onPaste!)} label="粘贴" shortcut="Ctrl+V" disabled={!onPaste || editFlags?.canPaste === false} dataName="browser.webview-ctx-paste" />
        <PopoverItem onClick={run(onPasteAsPlainText!)} label="粘贴为纯文本" shortcut="Ctrl+Shift+V" disabled={!onPasteAsPlainText || editFlags?.canPaste === false} dataName="browser.webview-ctx-paste-plain" />
        <PopoverDivider />
        <PopoverItem onClick={run(onSelectAll!)} label="全选" shortcut="Ctrl+A" disabled={!onSelectAll || editFlags?.canSelectAll === false} dataName="browser.webview-ctx-select-all" />
        <PopoverDivider />
        <PopoverItem onClick={run(onInspect)} label="检查" shortcut="F12" dataName="browser.webview-ctx-inspect" />
      </Popover>
    );
  }

  // 链接右键菜单
  if (contextType === 'link') {
    return (
      <Popover
        isOpen={true}
        onClose={onClose}
        position={position}
        variant="context-menu"
        config={{ closeOnOutsideClick: true, closeOnEsc: true }}
        dataName="browser.webview-context-menu"
      >
        <PopoverItem onClick={run(onOpenLinkInNewTab!)} label="在新标签页中打开链接" dataName="browser.webview-ctx-open-link" />
        <PopoverItem onClick={run(onCopyLinkAddress!)} label="复制链接地址" dataName="browser.webview-ctx-copy-link" />
        <PopoverItem onClick={run(onSaveLinkAs ?? onSaveAs)} label="链接另存为..." dataName="browser.webview-ctx-save-link" />
        <PopoverDivider />
        <PopoverItem onClick={run(onGoBack)} label="后退" shortcut="Alt+←" disabled={!canGoBack} dataName="browser.webview-ctx-back" />
        <PopoverItem onClick={run(onGoForward)} label="前进" shortcut="Alt+→" disabled={!canGoForward} dataName="browser.webview-ctx-forward" />
        <PopoverItem onClick={run(onReload)} label="重新加载" shortcut="F5" dataName="browser.webview-ctx-reload" />
        <PopoverDivider />
        <PopoverItem onClick={run(onSaveAs)} label="另存为..." shortcut="Ctrl+S" dataName="browser.webview-ctx-save" />
        <PopoverItem onClick={run(onPrint)} label="打印..." shortcut="Ctrl+P" dataName="browser.webview-ctx-print" />
        <PopoverDivider />
        <PopoverItem onClick={run(onViewSource)} label="查看网页源代码" shortcut="Ctrl+U" dataName="browser.webview-ctx-source" />
        <PopoverItem onClick={run(onInspect)} label="检查" shortcut="F12" dataName="browser.webview-ctx-inspect" />
      </Popover>
    );
  }

  // 图片右键菜单
  if (contextType === 'image') {
    return (
      <Popover
        isOpen={true}
        onClose={onClose}
        position={position}
        variant="context-menu"
        config={{ closeOnOutsideClick: true, closeOnEsc: true }}
        dataName="browser.webview-context-menu"
      >
        <PopoverItem onClick={run(onSaveImage!)} label="图片另存为..." dataName="browser.webview-ctx-save-image" />
        <PopoverItem onClick={run(onCopyImage!)} label="复制图片" dataName="browser.webview-ctx-copy-image" />
        <PopoverItem onClick={run(onCopyImageUrl!)} label="复制图片地址" dataName="browser.webview-ctx-copy-image-url" />
        <PopoverDivider />
        <PopoverItem onClick={run(onGoBack)} label="后退" shortcut="Alt+←" disabled={!canGoBack} dataName="browser.webview-ctx-back" />
        <PopoverItem onClick={run(onGoForward)} label="前进" shortcut="Alt+→" disabled={!canGoForward} dataName="browser.webview-ctx-forward" />
        <PopoverItem onClick={run(onReload)} label="重新加载" shortcut="F5" dataName="browser.webview-ctx-reload" />
        <PopoverDivider />
        <PopoverItem onClick={run(onSaveAs)} label="另存为..." shortcut="Ctrl+S" dataName="browser.webview-ctx-save" />
        <PopoverItem onClick={run(onPrint)} label="打印..." shortcut="Ctrl+P" dataName="browser.webview-ctx-print" />
        <PopoverDivider />
        <PopoverItem onClick={run(onViewSource)} label="查看网页源代码" shortcut="Ctrl+U" dataName="browser.webview-ctx-source" />
        <PopoverItem onClick={run(onInspect)} label="检查" shortcut="F12" dataName="browser.webview-ctx-inspect" />
      </Popover>
    );
  }

  // 普通页面右键菜单
  return (
    <Popover
      isOpen={true}
      onClose={onClose}
      position={position}
      variant="context-menu"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      dataName="browser.webview-context-menu"
    >
      {hasSelection && onCopySelection && (
        <>
          <PopoverItem onClick={run(onCopySelection)} label="复制" shortcut="Ctrl+C" dataName="browser.webview-ctx-copy-selection" />
          <PopoverDivider />
        </>
      )}
      <PopoverItem onClick={run(onGoBack)} label="后退" shortcut="Alt+←" disabled={!canGoBack} dataName="browser.webview-ctx-back" />
      <PopoverItem onClick={run(onGoForward)} label="前进" shortcut="Alt+→" disabled={!canGoForward} dataName="browser.webview-ctx-forward" />
      <PopoverItem onClick={run(onReload)} label="重新加载" shortcut="F5" dataName="browser.webview-ctx-reload" />
      <PopoverDivider />
      <PopoverItem onClick={run(onSaveAs)} label="另存为..." shortcut="Ctrl+S" dataName="browser.webview-ctx-save" />
      <PopoverItem onClick={run(onPrint)} label="打印..." shortcut="Ctrl+P" dataName="browser.webview-ctx-print" />
      {onScreenshot && (
        <PopoverItem onClick={run(onScreenshot)} label="截图当前页面" dataName="browser.webview-ctx-screenshot" />
      )}
      <PopoverDivider />
      {onZoomIn && onZoomOut && onZoomReset && (
        <>
          <PopoverItem onClick={run(onZoomIn)} label="放大" shortcut="Ctrl+=" dataName="browser.webview-ctx-zoom-in" />
          <PopoverItem onClick={run(onZoomOut)} label="缩小" shortcut="Ctrl+-" dataName="browser.webview-ctx-zoom-out" />
          <PopoverItem onClick={run(onZoomReset)} label="重置缩放" shortcut="Ctrl+0" dataName="browser.webview-ctx-zoom-reset" />
          <PopoverDivider />
        </>
      )}
      {onToggleCloudPc && (
        <>
          <PopoverItem onClick={run(onToggleCloudPc)} label={isCloudPc ? '退出云电脑模式' : '进入云电脑模式'} shortcut="Ctrl+Alt+C" dataName="browser.webview-ctx-cloud-pc" />
          <PopoverDivider />
        </>
      )}
      <PopoverItem onClick={run(onViewSource)} label="查看网页源代码" shortcut="Ctrl+U" dataName="browser.webview-ctx-source" />
      <PopoverItem onClick={run(onInspect)} label="检查" shortcut="F12" dataName="browser.webview-ctx-inspect" />
    </Popover>
  );
}
