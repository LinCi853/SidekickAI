/* =====================================================================
   pages/BrowserView/NavBar/GamepadIndicator.tsx —— 手柄接入指示器
   - 未连接：淡色手柄图标（提示未检测到手柄）
   - 已连接：高亮图标 + 数量角标；点击打开实时面板
   面板：每个手柄的按钮位掩码网格（按下高亮）、摇杆/扳机进度条、十字键。
   数据来自 useGamepadStore（宿主 GamepadCollector 驱动，20Hz 节流刷新）。
   ===================================================================== */

import { useState } from 'react';
import Popover from '../../../components/ui/Popover';
import { useGamepadStore } from '../../../store/useGamepadStore';
import type { GamepadInputFrame } from '../../../lib/cloud-game/input-frame';

function GamepadIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 手柄主体 */}
      <path d="M6 11h4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z" />
      <path d="M18 11h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2z" />
      {/* 十字键 */}
      <path d="M8 6v2M7 7h2" />
      {/* 摇杆 */}
      <circle cx="8" cy="14.5" r="1.1" />
      <circle cx="16" cy="14.5" r="1.1" />
      {/* 功能键 */}
      <circle cx="13.5" cy="9" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="9" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 按钮位掩码网格：0..15，按下高亮 */
function ButtonGrid({ buttons }: { buttons: number }) {
  return (
    <div className="gamepad-panel-buttons" data-name="browser.gamepad-panel.buttons">
      {Array.from({ length: 16 }, (_, i) => (
        <span
          key={i}
          className={`gamepad-panel-btn${buttons & (1 << i) ? ' pressed' : ''}`}
          title={`按钮 ${i}`}
        >
          {i}
        </span>
      ))}
    </div>
  );
}

/** 轴进度条（-1..1 → 0..100%） */
function AxisBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(((value / 32767 + 1) / 2) * 100);
  return (
    <div className="gamepad-panel-axis" data-name="browser.gamepad-panel.axis">
      <span className="gamepad-panel-axis-label">{label}</span>
      <div className="gamepad-panel-axis-track">
        <div className="gamepad-panel-axis-fill" style={{ width: `${pct}%` }} />
        <div className="gamepad-panel-axis-center" />
      </div>
      <span className="gamepad-panel-axis-value">{Math.round(value / 32767 * 100)}%</span>
    </div>
  );
}

function PadDetails({ index, id, frame }: { index: number; id: string; frame: GamepadInputFrame | null }) {
  const axes = frame?.axes ?? [0, 0, 0, 0];
  const triggers = frame?.triggers ?? [0, 0];
  const dpad = frame?.dpad ?? 0;
  return (
    <div className="gamepad-panel-pad" data-name="browser.gamepad-panel.pad">
      <div className="gamepad-panel-pad-header">
        <span className="gamepad-panel-pad-index">手柄 {index + 1}</span>
        <span className="gamepad-panel-pad-id">{id}</span>
      </div>
      <ButtonGrid buttons={frame?.buttons ?? 0} />
      <div className="gamepad-panel-axes">
        <AxisBar label="左摇杆X" value={axes[0]} />
        <AxisBar label="左摇杆Y" value={axes[1]} />
        <AxisBar label="右摇杆X" value={axes[2]} />
        <AxisBar label="右摇杆Y" value={axes[3]} />
        <AxisBar label="L2" value={triggers[0] * 128.5} />
        <AxisBar label="R2" value={triggers[1] * 128.5} />
      </div>
      <div className="gamepad-panel-dpad">
        <span className={dpad & 0b0001 ? 'pressed' : ''}>▲</span>
        <span className={dpad & 0b0010 ? 'pressed' : ''}>▼</span>
        <span className={dpad & 0b0100 ? 'pressed' : ''}>◀</span>
        <span className={dpad & 0b1000 ? 'pressed' : ''}>▶</span>
      </div>
    </div>
  );
}

export default function GamepadIndicator() {
  const pads = useGamepadStore((s) => s.pads);
  const connectedCount = useGamepadStore((s) => s.connectedCount);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const connectedPads = Object.values(pads).filter((p) => p.connected);

  const togglePanel = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!panelOpen) {
      const rect = e.currentTarget.getBoundingClientRect();
      // 面板宽度 320，右对齐到按钮右侧，按钮下方 8px
      setPanelPos({ x: rect.right - 320, y: rect.bottom + 8 });
    }
    setPanelOpen((v) => !v);
  };

  return (
    <div className="gamepad-indicator" data-name="browser.gamepad-indicator">
      <button
        type="button"
        className={`gamepad-indicator-btn${connectedCount > 0 ? ' active' : ''}`}
        onClick={togglePanel}
        title={connectedCount > 0 ? `已连接 ${connectedCount} 个手柄（点击查看状态）` : '未检测到手柄（Gamepad API）'}
        data-name="browser.gamepad.btn"
      >
        <GamepadIcon active={connectedCount > 0} />
        {connectedCount > 0 && <span className="gamepad-indicator-badge">{connectedCount}</span>}
      </button>
      {panelOpen && (
        <Popover
          isOpen={true}
          onClose={() => setPanelOpen(false)}
          position={panelPos}
          variant="context-menu"
          config={{ closeOnOutsideClick: true, closeOnEsc: true }}
          width={320}
          maxHeight={420}
          dataName="browser.gamepad.panel"
        >
          <div className="gamepad-panel" data-name="browser.gamepad.panel.content">
            <div className="gamepad-panel-title">手柄状态</div>
            {connectedPads.length === 0 ? (
              <div className="gamepad-panel-empty">
                未检测到已连接的手柄。
                <br />
                请通过 USB / 蓝牙连接手柄后按任意按键，Gamepad API 会自动识别。
              </div>
            ) : (
              connectedPads.map((p) => (
                <PadDetails key={p.index} index={p.index} id={p.id} frame={p.frame} />
              ))
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
