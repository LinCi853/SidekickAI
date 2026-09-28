/* =====================================================================
   lib/cloud-game/input-frame.ts —— 云游戏输入帧：类型与二进制序列化
   低延迟要求下的精简格式（按钮位掩码 + 轴 int16），30–60Hz 上行。
   ===================================================================== */

/** 手柄输入帧（标准映射：16 按钮 + 4 轴 + 2 扳机 + 十字键） */
export interface GamepadInputFrame {
  /** 帧类型：0x01 */
  type: 1;
  /** 手柄索引（多手柄：0..3） */
  index: number;
  /** 按钮按下位掩码（bit N = buttons[N].pressed，仅 16 个标准按钮） */
  buttons: number;
  /** 轴值：左摇杆 X/Y、右摇杆 X/Y，int16（-32768..32767，中位 0） */
  axes: [number, number, number, number];
  /** 扳机（L2/R2），uint8 */
  triggers: [number, number];
  /** 十字键位掩码：bit0=上 bit1=下 bit2=左 bit3=右 */
  dpad: number;
}

/** 鼠标相对位移帧（Pointer Lock / 光标居中模式下由 movementX/Y 累积） */
export interface MouseMoveFrame {
  type: 2;
  /** 相对位移（int16，逐帧累积；发送后清零） */
  dx: number;
  dy: number;
  /** 鼠标按钮位掩码：bit0=左 bit1=中 bit2=右 */
  buttons: number;
  /** 滚轮（int8） */
  wheel: number;
}

/** 键盘事件帧（event.code 事件流：按下/释放，保证物理键位一致） */
export interface KeyboardEventFrame {
  type: 3;
  /** 0=释放 1=按下 */
  down: 0 | 1;
  /** 物理键位 code（如 KeyW / ShiftLeft），发送后由对端映射 */
  code: string;
}

/** 所有输入帧的联合 */
export type InputFrame = GamepadInputFrame | MouseMoveFrame | KeyboardEventFrame;

/** 单帧序列化（不含分帧协议头；调用方按 WebSocket/DataChannel 消息边界发送） */
export function serializeFrame(frame: InputFrame): ArrayBuffer {
  switch (frame.type) {
    case 1: {
      // 1B type + 1B index + 4B buttons + 8B axes + 2B triggers + 1B dpad
      const buf = new ArrayBuffer(17);
      const v = new DataView(buf);
      v.setUint8(0, 1);
      v.setUint8(1, frame.index);
      v.setUint32(2, frame.buttons, true);
      for (let i = 0; i < 4; i++) {
        v.setInt16(6 + i * 2, clampInt16(frame.axes[i]), true);
      }
      v.setUint8(14, clampUint8(frame.triggers[0]));
      v.setUint8(15, clampUint8(frame.triggers[1]));
      v.setUint8(16, frame.dpad);
      return buf;
    }
    case 2: {
      // 1B type + 2B dx + 2B dy + 1B buttons + 1B wheel
      const buf = new ArrayBuffer(7);
      const v = new DataView(buf);
      v.setUint8(0, 2);
      v.setInt16(1, clampInt16(frame.dx), true);
      v.setInt16(3, clampInt16(frame.dy), true);
      v.setUint8(5, frame.buttons);
      v.setInt8(6, clampInt8(frame.wheel));
      return buf;
    }
    case 3: {
      const encoder = new TextEncoder();
      const codeBytes = encoder.encode(frame.code.slice(0, 32));
      const buf = new ArrayBuffer(2 + codeBytes.length);
      const v = new DataView(buf);
      v.setUint8(0, 3);
      v.setUint8(1, frame.down);
      new Uint8Array(buf, 2).set(codeBytes);
      return buf;
    }
  }
}

/** 反序列化（调试/回显用） */
export function deserializeFrame(buf: ArrayBuffer): InputFrame | null {
  const v = new DataView(buf);
  const type = v.getUint8(0);
  if (type === 1 && buf.byteLength >= 17) {
    return {
      type: 1,
      index: v.getUint8(1),
      buttons: v.getUint32(2, true),
      axes: [v.getInt16(6, true), v.getInt16(8, true), v.getInt16(10, true), v.getInt16(12, true)],
      triggers: [v.getUint8(14), v.getUint8(15)],
      dpad: v.getUint8(16),
    };
  }
  if (type === 2 && buf.byteLength >= 7) {
    return {
      type: 2,
      dx: v.getInt16(1, true),
      dy: v.getInt16(3, true),
      buttons: v.getUint8(5),
      wheel: v.getInt8(6),
    };
  }
  if (type === 3 && buf.byteLength >= 2) {
    return {
      type: 3,
      down: v.getUint8(1) === 1 ? 1 : 0,
      code: new TextDecoder().decode(new Uint8Array(buf, 2)),
    };
  }
  return null;
}

function clampInt16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}
function clampInt8(v: number): number {
  return Math.max(-128, Math.min(127, Math.round(v)));
}
function clampUint8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
