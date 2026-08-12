/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层 + 控制条
   当激活标签处于冻结态时显示：
   - 顶部控制条：冻结状态 + 抓取快照信息 + 恢复/分离按钮
   - 半透明边框指示器（蓝色呼吸光，提示页面已冻结）
   ===================================================================== */

import { useEffect, useState } from 'react';
import { useFreezeStore } from '../../store/useFreezeStore';

interface FreezeOverlayProps {
  /** 当前激活标签 id */
  activeTabId: string | null;
}

export default function FreezeOverlay({ activeTabId }: FreezeOverlayProps) {
  const state = useFreezeStore((s) => (activeTabId ? s.states[activeTabId] : undefined));
  const snapshot = useFreezeStore((s) => (activeTabId ? s.snapshots[activeTabId] : undefined));
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

      {state === 'frozen' && (
        <>
          {/* 冻结边框指示器（蓝色呼吸光） */}
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
          {/* 顶部控制条 */}
          <div
            className="freeze-control-bar"
            data-name="browser.freeze-control"
            style={{
              position: 'absolute',
              top: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '6px 14px',
              borderRadius: 8,
              background: 'rgba(79, 70, 229, 0.95)',
              color: '#fff',
              fontSize: 13,
              fontFamily: 'var(--font-sans, system-ui)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#a5f3fc',
                  animation: 'freeze-pulse 1s ease-in-out infinite',
                }}
              />
              页面已冻结
            </span>
            {snapshot && (
              <span style={{ opacity: 0.85, fontSize: 12 }}>
                已抓取 {snapshot.pairsCount} 条对话入库
              </span>
            )}
            <button
              onClick={() => activeTabId && useFreezeStore.getState().doResume(activeTabId)}
              style={{
                border: '1px solid rgba(255,255,255,0.4)',
                background: 'rgba(255,255,255,0.15)',
                color: '#fff',
                padding: '3px 10px',
                borderRadius: 5,
                cursor: 'pointer',
                fontSize: 12,
              }}
              data-name="browser.freeze-resume-btn"
            >
              恢复
            </button>
            <button
              onClick={() => activeTabId && useFreezeStore.getState().doDetach(activeTabId)}
              style={{
                border: '1px solid rgba(255,255,255,0.3)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.8)',
                padding: '3px 10px',
                borderRadius: 5,
                cursor: 'pointer',
                fontSize: 12,
              }}
              data-name="browser.freeze-detach-btn"
            >
              分离
            </button>
          </div>
        </>
      )}
      <style>{`
        @keyframes freeze-breath {
          0%, 100% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.5); }
          50% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.9); }
        }
        @keyframes freeze-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes freeze-flash {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </>
  );
}
