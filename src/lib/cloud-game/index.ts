/* =====================================================================
   lib/cloud-game/index.ts —— 简单云游戏客户端支持库
   面向浏览器窗口接入云游戏（低延迟视频流 + 实时输入回传）的完整骨架：
   - CloudGameClient：WebRTC 视频下行（<video> 渲染）+ DataChannel 输入上行
     + 指数退避断线重连；信令通过 onSignal/signal 注入，与平台解耦。
   - GamepadCollector：Gamepad API 手柄采集（按钮位掩码 + 轴 int16，30–60Hz，
     多手柄索引、状态去重）。
   - PointerLockManager：FPS 鼠标捕获；首选 Pointer Lock，不可用时自动
     切换「光标居中」备用方案（主进程 SetCursorPos 重置光标到窗口中心）。
   - 输入帧序列化：精简二进制（按钮位掩码 + 轴 int16），降低上行开销。
   键盘输入（event.code 保证物理键位一致）与鼠标相对位移由页面自身
   （Pointer Lock 的 movementX/Y）或宿主注入采集，帧格式见 input-frame.ts。
   ===================================================================== */

export { CloudGameClient } from './client';
export type {
  CloudGameClientOptions,
  CloudGameClientState,
} from './client';
export { GamepadCollector, buildGamepadFrame } from './gamepad';
export { wireGamepadToClient } from './wire';
export type { GamepadConnection, GamepadCollectorOptions } from './gamepad';
export { PointerLockManager } from './pointer-lock';
export type { PointerLockManagerOptions } from './pointer-lock';
export {
  serializeFrame,
  deserializeFrame,
} from './input-frame';
export type {
  InputFrame,
  GamepadInputFrame,
  MouseMoveFrame,
  KeyboardEventFrame,
} from './input-frame';
