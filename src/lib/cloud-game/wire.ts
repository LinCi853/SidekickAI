/* =====================================================================
   lib/cloud-game/wire.ts —— 输入采集 ↔ 传输层接线辅助
   保持「输入发送与视频渲染解耦」：采集器只产生输入帧，传输层只发送
   二进制帧；本模块提供一行式接线：
     const client = new CloudGameClient({ video, onSignal });
     const collector = new GamepadCollector({ rate: 60 });
     wireGamepadToClient(collector, client);   // 手柄帧 → DataChannel
   ===================================================================== */

import { GamepadCollector } from './gamepad';
import { CloudGameClient } from './client';
import { serializeFrame } from './input-frame';
import type { GamepadInputFrame } from './input-frame';

/**
 * 把手柄采集器的帧直接发给云游戏客户端（DataChannel 就绪时走 DataChannel）。
 * @returns 解除接线的函数
 */
export function wireGamepadToClient(
  collector: GamepadCollector,
  client: CloudGameClient,
): () => void {
  const onFrame = (frame: GamepadInputFrame) => {
    client.sendInput(serializeFrame(frame));
  };
  collector.setOnFrame(onFrame);
  return () => collector.setOnFrame(undefined);
}
