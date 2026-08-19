/* =====================================================================
   lib/cloud-game/client.ts —— 简单云游戏客户端骨架
   按「低延迟视频流 + 实时输入回传」的标准设计提供可复用骨架：
   - 视频下行：WebRTC RTCPeerConnection，远端视频流渲染到 <video>
   - 输入上行：WebRTC DataChannel（或注入的 WebSocket）发送二进制输入帧
   - 断线重连：指数退避 + 最大次数；连接状态回调
   - 输入发送与视频渲染完全解耦：InputCollector 采集 → send() 发送
   信令（offer/answer/ICE 交换）由宿主通过 onSignal / signal() 注入实现，
   不与具体云游戏平台绑定。
   ===================================================================== */

export interface CloudGameClientOptions {
  /** 渲染远端视频的 <video> 元素（自动挂载远端流 + autoplay + playsinline） */
  video: HTMLVideoElement;
  /** RTCPeerConnection 配置（STUN/TURN 由云游戏平台提供） */
  rtcConfig?: RTCConfiguration;
  /** 发送输入帧的函数（DataChannel 就绪时自动切换；也可注入 WebSocket 发送器） */
  send?: (data: ArrayBuffer | Uint8Array) => void;
  /** 信令回调：本地 offer/ICE 需要发往信令服务器 */
  onSignal?: (message: unknown) => void;
  /** 连接状态回调 */
  onStateChange?: (state: CloudGameClientState) => void;
  /** 重连参数 */
  reconnect?: { maxAttempts?: number; baseDelayMs?: number };
}

export type CloudGameClientState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed';

/**
 * 云游戏客户端：管理 WebRTC 连接生命周期 + 输入通道。
 * 使用方式：
 *   const client = new CloudGameClient({ video, onSignal, onStateChange });
 *   await client.createOffer();          // 触发 onSignal(offer)
 *   client.signal(serverAnswer);          // 收到远端 answer
 *   client.signal({ candidate });         // 逐条收远端 ICE
 *   client.sendInput(frameBuffer);        // 输入上行（30–60Hz）
 *   client.close();
 */
export class CloudGameClient {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private video: HTMLVideoElement;
  private rtcConfig?: RTCConfiguration;
  private send?: (data: ArrayBuffer | Uint8Array) => void;
  private onSignal?: (message: unknown) => void;
  private onStateChange?: (state: CloudGameClientState) => void;
  private state: CloudGameClientState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxAttempts: number;
  private baseDelayMs: number;

  constructor(options: CloudGameClientOptions) {
    this.video = options.video;
    this.rtcConfig = options.rtcConfig;
    this.send = options.send;
    this.onSignal = options.onSignal;
    this.onStateChange = options.onStateChange;
    this.maxAttempts = options.reconnect?.maxAttempts ?? 5;
    this.baseDelayMs = options.reconnect?.baseDelayMs ?? 1000;
    this.setupVideo();
  }

  getState(): CloudGameClientState {
    return this.state;
  }

  /** 创建 PeerConnection 与 DataChannel，并生成 offer（经 onSignal 发往信令服务器） */
  async createOffer(): Promise<void> {
    this.pc?.close();
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
    this.channel = pc.createDataChannel('input', { ordered: true });
    this.channel.onopen = () => this.handleConnected();
    this.channel.onclose = () => this.handleDisconnected();

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if (cs === 'connected') this.handleConnected();
      else if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
        this.handleDisconnected();
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.onSignal?.({ type: 'candidate', candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      // 视频下行：远端流挂载到 <video>（渲染与输入解耦）
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.video.srcObject = stream;
      void this.video.play().catch(() => { /* 自动播放被阻止时由用户手势重试 */ });
    };

    this.setState('connecting');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.onSignal?.({ type: 'offer', sdp: offer.sdp });
  }

  /** 处理信令消息（远端 answer / ICE candidate） */
  async signal(message: unknown): Promise<void> {
    if (!this.pc) return;
    const msg = message as { type?: string; sdp?: string; candidate?: RTCIceCandidateInit };
    if (msg.type === 'answer' && msg.sdp) {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'candidate' && msg.candidate) {
      try { await this.pc.addIceCandidate(msg.candidate); } catch { /* 候选失败忽略 */ }
    }
  }

  /** 发送输入帧（二进制；DataChannel 就绪时走 DataChannel，否则走注入的 send） */
  sendInput(data: ArrayBuffer | Uint8Array): void {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(data as ArrayBuffer);
      return;
    }
    this.send?.(data);
  }

  /** 断线重连（指数退避：1s / 2s / 4s / ...，达到上限进入 failed） */
  private scheduleReconnect(): void {
    if (this.state === 'closed') return;
    if (this.reconnectAttempts >= this.maxAttempts) {
      this.setState('failed');
      return;
    }
    this.setState('reconnecting');
    const delay = this.baseDelayMs * 2 ** this.reconnectAttempts;
    this.reconnectAttempts += 1;
    console.log(`[cloud-game] ${delay}ms 后重连（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.createOffer().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private handleConnected(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState('connected');
  }

  private handleDisconnected(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      this.scheduleReconnect();
    }
  }

  private setState(state: CloudGameClientState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private setupVideo(): void {
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = false;
  }

  close(): void {
    this.setState('closed');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channel?.close();
    this.pc?.close();
    this.pc = null;
    this.channel = null;
  }
}
