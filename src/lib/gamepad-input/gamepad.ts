/* =====================================================================
   lib/cloud-game/gamepad.ts —— 手柄输入采集（Gamepad API）
   直接使用 Chromium/Electron 渲染进程自带的 Gamepad API，无需原生模块：
   - gamepadconnected / gamepaddisconnected 管理连接状态
   - requestAnimationFrame 循环中轮询 navigator.getGamepads()
   - 提取按钮按下状态（位掩码）与摇杆轴值（int16），30–60Hz 回调
   - 多手柄索引（index 0..3）稳定输出
   ===================================================================== */

import type { GamepadInputFrame } from './input-frame';

/** 手柄连接状态（index → { id, connected }） */
export interface GamepadConnection {
  index: number;
  id: string;
  connected: boolean;
}

export interface GamepadCollectorOptions {
  /** 采样频率（Hz，默认 60；rAF 实际受显示器刷新率限制） */
  rate?: number;
  /** 帧回调（含发送职责的调用方注入，保持采集与发送解耦） */
  onFrame?: (frame: GamepadInputFrame) => void;
  /** 连接状态变化回调 */
  onConnectionChange?: (connections: GamepadConnection[]) => void;
}

/**
 * 手柄采集器：负责轮询 Gamepad API 并输出精简输入帧。
 * 输入发送与采集解耦：调用方通过 onFrame 回调把帧交给传输层
 * （WebSocket / WebRTC DataChannel）。
 */
export class GamepadCollector {
  private options: Required<Omit<GamepadCollectorOptions, 'onFrame' | 'onConnectionChange'>>;
  private onFrame?: (frame: GamepadInputFrame) => void;
  private onConnectionChange?: (connections: GamepadConnection[]) => void;
  private rafId: number | null = null;
  private lastSampleAt = 0;
  private running = false;
  /** 上一帧按钮位掩码（只发送变化帧，降低序列化/网络开销） */
  private lastFrames = new Map<number, GamepadInputFrame>();
  private connectionHandler = () => this.emitConnections();
  private disconnectHandler = () => this.emitConnections();

  constructor(options: GamepadCollectorOptions = {}) {
    this.options = { rate: options.rate ?? 60 };
    this.onFrame = options.onFrame;
    this.onConnectionChange = options.onConnectionChange;
  }

  /** 动态替换帧回调（供 wireGamepadToClient 等接线辅助使用） */
  setOnFrame(fn?: (frame: GamepadInputFrame) => void): void {
    this.onFrame = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('gamepadconnected', this.connectionHandler);
    window.addEventListener('gamepaddisconnected', this.disconnectHandler);
    this.emitConnections();
    const loop = (now: number) => {
      if (!this.running) return;
      const intervalMs = 1000 / this.options.rate;
      if (now - this.lastSampleAt >= intervalMs) {
        this.lastSampleAt = now;
        this.sample();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    window.removeEventListener('gamepadconnected', this.connectionHandler);
    window.removeEventListener('gamepaddisconnected', this.disconnectHandler);
    this.lastFrames.clear();
  }

  /** 当前连接的手柄列表 */
  connections(): GamepadConnection[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const list: GamepadConnection[] = [];
    for (const pad of pads) {
      if (pad) list.push({ index: pad.index, id: pad.id, connected: pad.connected });
    }
    return list;
  }

  private sample(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const frame = buildGamepadFrame(pad);
      const prev = this.lastFrames.get(pad.index);
      // 帧去重：状态未变化时不重复发送（仅连接后首帧必发）
      if (prev && framesEqual(prev, frame)) continue;
      this.lastFrames.set(pad.index, frame);
      this.onFrame?.(frame);
    }
  }

  private emitConnections(): void {
    this.onConnectionChange?.(this.connections());
  }
}

/** 从 Gamepad 提取精简帧（按钮位掩码 + 轴 int16 + 扳机 + 十字键） */
export function buildGamepadFrame(pad: Gamepad): GamepadInputFrame {
  let buttons = 0;
  for (let i = 0; i < Math.min(16, pad.buttons.length); i++) {
    if (pad.buttons[i].pressed) buttons |= 1 << i;
  }
  // 标准映射轴顺序：0=左摇杆X 1=左摇杆Y 2=右摇杆X 3=右摇杆Y（部分手柄轴索引不同，按 length 截取）
  const axis = (i: number) => (pad.axes[i] ?? 0) * 32767;
  let dpad = 0;
  // 标准映射下十字键通常位于 buttons[12..15]（或轴 6/7 在部分设备），此处按按钮位取
  const dpadBtn = (i: number) => pad.buttons[i]?.pressed ?? false;
  if (dpadBtn(12)) dpad |= 0b0001; // 上
  if (dpadBtn(13)) dpad |= 0b0010; // 下
  if (dpadBtn(14)) dpad |= 0b0100; // 左
  if (dpadBtn(15)) dpad |= 0b1000; // 右
  return {
    type: 1,
    index: pad.index,
    buttons,
    axes: [axis(0), axis(1), axis(2), axis(3)],
    triggers: [
      Math.round(Math.min(1, Math.max(0, pad.buttons[6]?.value ?? 0)) * 255),
      Math.round(Math.min(1, Math.max(0, pad.buttons[7]?.value ?? 0)) * 255),
    ],
    dpad,
  };
}

function framesEqual(a: GamepadInputFrame, b: GamepadInputFrame): boolean {
  return (
    a.buttons === b.buttons &&
    a.axes[0] === b.axes[0] &&
    a.axes[1] === b.axes[1] &&
    a.axes[2] === b.axes[2] &&
    a.axes[3] === b.axes[3] &&
    a.triggers[0] === b.triggers[0] &&
    a.triggers[1] === b.triggers[1] &&
    a.dpad === b.dpad
  );
}
