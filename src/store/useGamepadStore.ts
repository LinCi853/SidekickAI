/* =====================================================================
   store/useGamepadStore.ts —— 手柄连接状态 store
   由 GamepadCollector（宿主渲染层）驱动：
   - 连接/断开：gamepadconnected / gamepaddisconnected 事件
   - 实时帧：rAF 轮询 navigator.getGamepads()（节流 ~20Hz 写入，避免高频重渲染）
   供导航栏手柄指示器、手柄面板与云游戏输入接线消费。
   ===================================================================== */

import { create } from 'zustand';
import type { GamepadInputFrame } from '../lib/cloud-game/input-frame';

export interface GamepadStateEntry {
  /** 手柄索引（多手柄：0..3） */
  index: number;
  /** 手柄标识（如 Xbox Controller (STANDARD GAMEPAD)） */
  id: string;
  /** 是否已连接 */
  connected: boolean;
  /** 最新输入帧（按钮位掩码 / 轴 int16 / 扳机 / 十字键） */
  frame: GamepadInputFrame | null;
}

interface GamepadStoreState {
  /** 手柄状态（index → entry） */
  pads: Record<number, GamepadStateEntry>;
  /** 连接中的手柄数量 */
  connectedCount: number;
  /** 更新连接状态（gamepadconnected / disconnected） */
  setConnections: (connections: { index: number; id: string; connected: boolean }[]) => void;
  /** 更新实时帧（由采集器节流调用） */
  setFrame: (frame: GamepadInputFrame, id: string) => void;
  /** 清空（窗口销毁时） */
  reset: () => void;
}

/** 帧写入节流（20Hz，避免 60Hz 手柄轮询导致 React 高频重渲染） */
let lastFrameSetAt = 0;

export const useGamepadStore = create<GamepadStoreState>((set, get) => ({
  pads: {},
  connectedCount: 0,

  setConnections: (connections) => {
    const pads: Record<number, GamepadStateEntry> = {};
    let connectedCount = 0;
    for (const conn of connections) {
      pads[conn.index] = {
        index: conn.index,
        id: conn.id,
        connected: conn.connected,
        frame: get().pads[conn.index]?.frame ?? null,
      };
      if (conn.connected) connectedCount += 1;
    }
    set({ pads, connectedCount });
  },

  setFrame: (frame, id) => {
    const now = Date.now();
    if (now - lastFrameSetAt < 50) {
      // 节流：20Hz 足够 UI 展示；高频帧仍由采集器回调直发传输层
      return;
    }
    lastFrameSetAt = now;
    set((s) => ({
      pads: {
        ...s.pads,
        [frame.index]: {
          index: frame.index,
          id: s.pads[frame.index]?.id || id || `手柄 ${frame.index + 1}`,
          connected: s.pads[frame.index]?.connected ?? true,
          frame,
        },
      },
    }));
  },

  reset: () => set({ pads: {}, connectedCount: 0 }),
}));
