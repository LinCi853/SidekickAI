/* =====================================================================
   lib/cloud-game/pointer-lock.ts —— 指针锁定 + 光标居中备用方案
   FPS 等需要持续相对位移的场景：
   - 首选 Pointer Lock API：requestPointerLock 捕获鼠标，mousemove 提供
     movementX/movementY 相对位移，光标自动锁定在中心。
   - 备选（页面不支持指针锁定时）：隐藏光标（cursor: none），mousemove
     计算相对位移，并通过注入的 recenter 回调（默认走主进程 SetCursorPos
     IPC）把系统光标重置回窗口中心。
   ===================================================================== */

import { setCursorPosition } from '../electron-api/window';

export interface PointerLockManagerOptions {
  /** 请求锁定的目标元素（默认 document.body；云游戏页面通常锁定 <video> 画布区域） */
  target?: HTMLElement;
  /** 相对位移回调（dx/dy 像素） */
  onMove?: (dx: number, dy: number) => void;
  /** 锁定状态变化回调 */
  onLockChange?: (locked: boolean) => void;
  /** 锁定失败时启用光标居中备用方案（默认 true） */
  fallbackRecenter?: boolean;
  /** 备用方案：光标重置函数（默认走主进程 SetCursorPos；可注入以便单测/平台替换） */
  recenter?: (x: number, y: number) => void;
  /** 光标重置频率（Hz，默认 30；主进程 PowerShell 实现有限流，见 electron/utils/cursor.ts） */
  recenterRate?: number;
}

export class PointerLockManager {
  private target: HTMLElement;
  private onMove?: (dx: number, dy: number) => void;
  private onLockChange?: (locked: boolean) => void;
  private recenter: (x: number, y: number) => void;
  private recenterRate: number;
  private locked = false;
  private fallbackActive = false;
  private recenterTimer: ReturnType<typeof setInterval> | null = null;
  private moveHandler = (e: MouseEvent) => this.handleMove(e);
  private lockChangeHandler = () => this.handleLockChange();

  constructor(options: PointerLockManagerOptions = {}) {
    this.target = options.target ?? document.body;
    this.onMove = options.onMove;
    this.onLockChange = options.onLockChange;
    this.recenterRate = options.recenterRate ?? 30;
    this.recenter =
      options.recenter ??
      ((x, y) => {
        void setCursorPosition(x, y).catch(() => { /* ignore */ });
      });
  }

  /** 请求指针锁定（必须在用户手势中调用，如 click / keydown） */
  request(): boolean {
    if (this.locked) return true;
    try {
      const promise = (this.target.requestPointerLock?.() ?? undefined) as unknown as Promise<void> | undefined;
      if (promise && typeof promise.then === 'function') {
        // 新版本 Chromium 返回 Promise（可能因用户手势丢失而拒绝）
        promise.then(
          () => { /* 锁定成功由 pointerlockchange 事件确认 */ },
          () => this.startFallback(),
        );
      }
      return true;
    } catch {
      // 目标元素不支持时回退到 body
      try {
        document.body.requestPointerLock?.();
        return true;
      } catch {
        this.startFallback();
        return false;
      }
    }
  }

  /** 退出指针锁定 / 停用备用方案 */
  exit(): void {
    if (document.pointerLockElement) {
      try { document.exitPointerLock?.(); } catch { /* ignore */ }
    }
    this.stopFallback();
  }

  /** 当前是否处于锁定或备用居中模式 */
  isActive(): boolean {
    return this.locked || this.fallbackActive;
  }

  start(): void {
    document.addEventListener('mousemove', this.moveHandler);
    document.addEventListener('pointerlockchange', this.lockChangeHandler);
  }

  stop(): void {
    this.exit();
    document.removeEventListener('mousemove', this.moveHandler);
    document.removeEventListener('pointerlockchange', this.lockChangeHandler);
  }

  private handleLockChange(): void {
    this.locked = document.pointerLockElement === this.target || document.pointerLockElement === document.body;
    if (!this.locked) {
      this.stopFallback();
    }
    this.onLockChange?.(this.locked);
  }

  private handleMove(e: MouseEvent): void {
    if (this.locked) {
      this.onMove?.(e.movementX, e.movementY);
      return;
    }
    if (!this.fallbackActive) return;
    // 备用方案：光标位置相对于窗口中心计算相对位移
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    this.onMove?.(e.clientX - cx, e.clientY - cy);
  }

  private startFallback(): void {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    // 隐藏光标（由调用方保证 CSS cursor: none；此处仅触发行为）
    const style = document.createElement('style');
    style.id = 'cloud-game-cursor-none';
    style.textContent = 'body, body * { cursor: none !important; }';
    document.head.appendChild(style);
    // 周期重置光标到窗口中心（防抖由主进程 cursor.ts 承担）
    this.recenterTimer = setInterval(() => {
      this.recenter(window.screenX + window.innerWidth / 2, window.screenY + window.innerHeight / 2);
    }, 1000 / this.recenterRate);
    console.warn('[cloud-game] 指针锁定不可用，启用光标居中备用方案');
    this.onLockChange?.(true);
  }

  private stopFallback(): void {
    if (!this.fallbackActive) return;
    this.fallbackActive = false;
    if (this.recenterTimer) {
      clearInterval(this.recenterTimer);
      this.recenterTimer = null;
    }
    document.getElementById('cloud-game-cursor-none')?.remove();
    this.onLockChange?.(this.locked);
  }
}
