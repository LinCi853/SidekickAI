/* =====================================================================
   FileDropOverlay —— 文件拖拽导入提示层
   =====================================================================
   当用户从系统资源管理器拖拽文件进入窗口时显示半透明遮罩，
   提示用户松手后文件将导入到当前激活的 AI 应用。
   遮罩可见时拦截 drop 事件（pointer-events: auto），覆盖 webview 区域
   防止 guest 进程拿走 drop；事件冒泡到 document 由统一监听器处理。
   */

interface FileDropOverlayProps {
  visible: boolean;
}

export default function FileDropOverlay({ visible }: FileDropOverlayProps) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.35)',
        border: '3px dashed var(--primary, #4a90d9)',
        borderRadius: 8,
        margin: 8,
        // 拦截 drop 事件（覆盖 webview，防止 guest 拿走），事件冒泡到 document 由监听器统一处理
        pointerEvents: 'auto',
      }}
      data-name="main.file-drop-overlay.overlay"
    >
      <div
        style={{
          padding: '16px 24px',
          background: 'var(--card, #fff)',
          color: 'var(--foreground, #333)',
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 600,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
        }}
        data-name="main.file-drop-overlay.message"
      >
        松手以导入文件到当前 AI 应用
      </div>
    </div>
  );
}
