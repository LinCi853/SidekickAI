import { useEffect, useRef } from 'react';
import type { WebviewElement } from '../../../lib/webview';

/**
 * enterToSend 运行时标志管理：
 *   - 维护 enterToSendRef 的最新值（供 dom-ready 闭包读取，避免闭包捕获旧值）
 *   - enterToSend 变化时，仅更新 webview 内的运行时标志位（无需重新注入监听器）
 */
export function useEnterToSendFlag({
  webviewRef,
  domReadyRef,
  enterToSend,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  domReadyRef: React.MutableRefObject<boolean>;
  enterToSend?: boolean;
}) {
  // enterToSend 的最新值（供 dom-ready 闭包读取，避免闭包捕获旧值）
  const enterToSendRef = useRef(enterToSend !== false);
  useEffect(() => { enterToSendRef.current = enterToSend !== false; }, [enterToSend]);

  // enterToSend 变化时，仅更新 webview 内的运行时标志位（无需重新注入监听器）
  // 必须检查 domReadyRef，否则 webview 未 ready 时 executeJavaScript 会同步抛错导致白屏
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) return;
    webview.executeJavaScript(`window.__ai_enter_send_enabled__ = ${enterToSend !== false};`)
      .catch(() => { /* ignore */ });
  }, [enterToSend]);

  return { enterToSendRef };
}
