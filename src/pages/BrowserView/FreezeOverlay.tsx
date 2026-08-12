/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层
   冻结瞬间显示 1 秒全屏闪烁遮罩（视觉提示）+ 蓝色呼吸边框（状态指示）。
   无顶栏、无按钮 —— 恢复走 Alt+P（与冻结相同的快捷键切换）。
   ===================================================================== */

import { useEffect, useState } from 'react';
import { useFreezeStore } from '../../store/useFreezeStore';

interface FreezeOverlayProps {
  /** 当前激活标签 id */
  activeTabId: string | null;
}

export default function FreezeOverlay({ activeTabId }: FreezeOverlayProps) {
  const state = useFreezeStore((s) => (activeTabId ? s.states[activeTabId] : undefined));
  const [showFlash, setShowFlash] = useState(false);

  // 冻结瞬间触发 1 秒全屏遮罩闪烁（视觉提示）
  useEffect(() => {
    if (state === 'frozen') {
      setShowFlash(true);
      const t = setTimeout(() => setShowFlash(false), 1000);
      return () => clearTimeout(t);
    }
  }, [state, activeTabId]);

  if (state !== 'frozen' && !showFlash) return null;

  return (
    <>
      {/* 冻结瞬间全屏遮罩（1 秒闪烁提示） */}
      {showFlash && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(99, 102, 241, 0.35)',
            pointerEvents: 'none',
            animation: 'freeze-flash 1s ease-out forwards',
          }}
        />
      )}

      {/* 冻结态边框指示器（蓝色呼吸光，纯视觉、不遮挡交互） */}
      {state === 'frozen' && (
        <div
          className="freeze-border-indicator"
          data-name="browser.freeze-border"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 9998,
            boxShadow: 'inset 0 0 0 3px rgba(99, 102, 241, 0.8)',
            animation: 'freeze-breath 2s ease-in-out infinite',
          }}
        />
      )}
      <style>{`
        @keyframes freeze-breath {
          0%, 100% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.5); }
          50% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.9); }
        }
        @keyframes freeze-flash {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
