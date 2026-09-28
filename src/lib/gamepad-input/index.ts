/* =====================================================================
   lib/gamepad-input/index.ts —— 浏览器窗口手柄输入支持
   服务 BrowserView 的手柄导航与云电脑页面：Gamepad API 采集 +
   精简二进制输入帧。原云游戏客户端骨架（WebRTC 视频流 / 信令 /
   指针捕获）已按定位调整移除，如需完整云游戏客户端由社区版实现。
   ===================================================================== */

export { GamepadCollector, buildGamepadFrame } from './gamepad';
export type { GamepadConnection, GamepadCollectorOptions } from './gamepad';
export { serializeFrame, deserializeFrame } from './input-frame';
export type { InputFrame, GamepadInputFrame } from './input-frame';
