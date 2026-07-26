// 维护性说明：本文件超过 300 行建议上限。
// 拆分计划：将注入流程抽到 useWebviewInjection hook，对话抓取抽到 useConversationScrape hook。
// 暂缓原因：dom-ready 注入、UA 切换、登录检测等逻辑通过共享 webview ref 紧密耦合，
// 拆分需保证注入时序与 ref 生命周期一致，避免破坏指纹注入与对话抓取功能。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFingerprintScript,
  logLoginTrace,
  createConversation,
  saveMessageWithMerge,
  notifyConversationPersisted,
  getPreset,
  listBlockRules,
  onWebviewPopupUrl,
  onPopupDenied,
  addToPopupWhitelist,
  addToProfilePopupWhitelist,
  applyProxyFallback,
  getAppSettings,
} from '../../lib/electron-api';
import type { Profile } from '../../lib/electron-api';
import { injectViewportAndPopupGuard, sanitizeUrl, safeLoadURLWebview, type WebviewElement } from '../../lib/webview';
import { buildBlockerScript, matchDomain } from '../../lib/webview-blocker';
import { buildCookieHandlerScript } from '../../lib/cookie-handler';
import { buildSpatialNavScript } from '../../lib/webview-spatial-nav';
import { useTabStore } from '../../store/useTabStore';
import { simpleHash } from './utils';
import { SCRAPE_CHAT_SCRIPT, DETECT_LOGIN_SCRIPT } from './scripts';

/* =====================================================================
   WebviewTab —— 单个标签的 webview（自管理指纹注入与导航）
   所有标签的 webview 始终挂载，仅通过 display 切换可见性，保留页面状态。
   ===================================================================== */

/**
 * 4.2 检测 webview 是否有活跃的网络请求（如 AI 流式回复）。
 * 通过 executeJavaScript 注入脚本读取 performance API：
 *   - 检查最近 2 秒内发起且尚未完成的资源请求（duration === 0 表示尚未完成）
 *   - 或文档未完成加载
 * 用于 UA 变化触发 reload 前判断是否需要延缓，避免丢失流式数据。
 */
async function checkWebviewStreaming(webview: WebviewElement): Promise<boolean> {
  try {
    const result = await webview.executeJavaScript(`
      (function() {
        var entries = performance.getEntriesByType('resource');
        var now = performance.now();
        // 检查最近 2 秒内发起且尚未完成的资源请求（duration === 0 表示尚未完成）
        var active = entries.filter(function(e) { return now - e.startTime < e.duration + 2000 && e.duration === 0; });
        return active.length > 0 || document.readyState !== 'complete';
      })()
    `);
    return Boolean(result);
  } catch (e) {
    // 检测失败时保守处理：返回 false（不延缓 reload），避免阻塞用户操作
    console.warn('[WebviewTab] 流式检测失败，不延缓 reload:', e);
    return false;
  }
}

export function WebviewTab({
  tab,
  profile,
  active,
  isNarrow,
  desktopPresetId,
  mobilePresetId,
  inputSelector,
  sendSelector,
  enterToSend,
  onNavigationChange,
  onDomReadyChange,
  onProcessGone,
}: {
  tab: { id: string; profileId: string; url?: string; title?: string; autoMobile?: boolean; originalDevicePreset?: string };
  profile: Profile;
  active: boolean;
  isNarrow: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
  inputSelector?: string | null;
  sendSelector?: string | null;
  enterToSend?: boolean;
  /** webview 导航能力变化回调（dom-ready / 导航后上报 canGoBack/canGoForward） */
  onNavigationChange?: (canGoBack: boolean, canGoForward: boolean) => void;
  /** webview dom-ready 状态变化回调（供父组件判断 reload/loadURL 是否安全） */
  onDomReadyChange?: (isReady: boolean) => void;
  /** webview guest 进程崩溃/异常退出回调（供父组件触发恢复或提示用户） */
  onProcessGone?: (reason: string) => void;
}) {
  const ref = useRef<WebviewElement | null>(null);
  const longPressTabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTabTriggeredRef = useRef(false);
  // webview 是否已 dom-ready（executeJavaScript 必须在 ready 后调用，否则同步抛错）
  const domReadyRef = useRef(false);
  // remount 计数器：guest 进程彻底死亡时递增，通过 key 变化强制 React 销毁并重建 <webview> 元素
  // 这是唯一可靠的恢复手段 —— 当 guest 死亡时，reload/loadURL/src 赋值全部通过
  // GUEST_VIEW_MANAGER_CALL IPC 异步失败，只有销毁 DOM 元素才能触发 Electron 创建新 guest
  const [remountKey, setRemountKey] = useState(0);
  // remount 防循环：记录上次 remount 失败的 URL 和连续失败次数
  // 同一 URL 连续 remount 失败 ≥2 次时，回退到 profile 首页 URL 并重置计数器
  const lastRemountFailUrlRef = useRef<string>('');
  const remountFailCountRef = useRef<number>(0);
  // 导航能力回调 ref（避免 webview setup effect 依赖 onNavigationChange 导致重复挂载）
  const onNavigationChangeRef = useRef(onNavigationChange);
  useEffect(() => { onNavigationChangeRef.current = onNavigationChange; });
  // dom-ready 状态回调 ref（同上，避免重复挂载）
  const onDomReadyChangeRef = useRef(onDomReadyChange);
  useEffect(() => { onDomReadyChangeRef.current = onDomReadyChange; });
  // 进程崩溃回调 ref（同上，避免重复挂载）
  const onProcessGoneRef = useRef(onProcessGone);
  useEffect(() => { onProcessGoneRef.current = onProcessGone; });
  // enterToSend 的最新值（供 dom-ready 闭包读取，避免闭包捕获旧值）
  const enterToSendRef = useRef(enterToSend !== false);
  useEffect(() => { enterToSendRef.current = enterToSend !== false; }, [enterToSend]);

  // 抓取状态：稳定性计数、上次持久化哈希、当前会话 id
  const stableCountRef = useRef(0);
  const lastPersistedHashRef = useRef<string>('');
  const conversationIdRef = useRef<string | null>(null);
  // 上次抓取到的对话 pairs 的哈希（用于稳定性判定，替代旧的 userText/assistantText 字段比较）
  const lastScrapedHashRef = useRef<string>('');
  // 上次抓取时的 URL pathname（pathname 变化视为切换到不同对话，重置 conversationId）
  const lastUrlPathRef = useRef<string>('');
  // 登录痕迹：已记录过登录的 URL 集合、上次检测登录的 URL
  const loggedLoginUrlsRef = useRef<Set<string>>(new Set());
  const lastLoginCheckedUrlRef = useRef<string>('');

  // 4.2 UA 变化触发 reload 的延缓管理：
  //   - pendingReloadRef：是否已有等待中的 reload（避免重复调度）
  //   - reloadPollTimerRef：数据流转完成轮询定时器（每 500ms 检测）
  //   - reloadTimeoutRef：超时兜底定时器（10s 后强制 reload）
  const pendingReloadRef = useRef(false);
  const reloadPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 4.2 调度 reload：若 webview 正在数据流转（AI 流式回复等）则延缓 reload，
   * 轮询检测数据流转完成后执行；含 10s 超时兜底防止检测失效导致永不刷新。
   *
   * 两处调用点（profile UA 变化 + 窄屏/宽屏 UA 自动切换）统一使用本函数。
   */
  const scheduleReload = useCallback((webview: WebviewElement) => {
    // 已有 pending reload，不重复调度
    if (pendingReloadRef.current) {
      console.log('[WebviewTab] 已有 pending reload，跳过本次调度');
      return;
    }

    void checkWebviewStreaming(webview).then((streaming) => {
      if (!streaming) {
        // 无活跃数据流转：立即 reload
        console.log('[WebviewTab] 无活跃数据流转，立即 reload');
        try {
          webview.reload();
        } catch (e) {
          console.error('[WebviewTab] reload 失败:', e);
        }
        return;
      }

      // 有活跃数据流转：设置 pending 标记，启动轮询 + 超时兜底
      console.log('[WebviewTab] 检测到活跃数据流转，延缓 reload');
      pendingReloadRef.current = true;

      // 轮询：每 500ms 检测一次，数据流转完成后执行 reload
      reloadPollTimerRef.current = setInterval(() => {
        void checkWebviewStreaming(webview).then((stillStreaming) => {
          if (!stillStreaming) {
            console.log('[WebviewTab] 数据流转完成，执行延缓的 reload');
            // 清理定时器
            if (reloadPollTimerRef.current) {
              clearInterval(reloadPollTimerRef.current);
              reloadPollTimerRef.current = null;
            }
            if (reloadTimeoutRef.current) {
              clearTimeout(reloadTimeoutRef.current);
              reloadTimeoutRef.current = null;
            }
            pendingReloadRef.current = false;
            try {
              webview.reload();
            } catch (e) {
              console.error('[WebviewTab] 延缓 reload 执行失败:', e);
            }
          }
        });
      }, 500);

      // 超时兜底：10 秒后强制 reload，防止检测失效导致永不刷新
      reloadTimeoutRef.current = setTimeout(() => {
        console.warn('[WebviewTab] 延缓 reload 超时 10s，强制 reload');
        if (reloadPollTimerRef.current) {
          clearInterval(reloadPollTimerRef.current);
          reloadPollTimerRef.current = null;
        }
        pendingReloadRef.current = false;
        try {
          webview.reload();
        } catch (e) {
          console.error('[WebviewTab] 强制 reload 失败:', e);
        }
      }, 10000);
    });
  }, []);

  // 组件卸载时清理 reload 相关定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      if (reloadPollTimerRef.current) {
        clearInterval(reloadPollTimerRef.current);
        reloadPollTimerRef.current = null;
      }
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }
      pendingReloadRef.current = false;
    };
  }, []);

  const src = sanitizeUrl(tab.url || profile.aiPlatformUrl || '');

  // dom-ready：注入指纹脚本
  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;
    let cancelled = false;
    const handleDomReady = async () => {
      domReadyRef.current = true;
      console.log('[WebviewTab] dom-ready, url=', webview.getURL(), 'profileId=', profile.id);
      // 页面成功加载：重置 remount 防循环计数器
      // （下次失败时若 URL 不同则正常重试，避免误判为连续失败循环）
      lastRemountFailUrlRef.current = '';
      remountFailCountRef.current = 0;
      // 上报 dom-ready 状态变化（供父组件判断 reload/loadURL 是否安全）
      onDomReadyChangeRef.current?.(true);
      // 上报初始导航能力（供顶栏后退/前进按钮 disabled 状态）
      try { onNavigationChangeRef.current?.(webview.canGoBack(), webview.canGoForward()); } catch { /* ignore */ }
      try {
        // 1. 注入指纹脚本
        const script = await getFingerprintScript(profile.id);
        await webview.executeJavaScript(script);

        // 2. 强制移动端 viewport，防止部分网页因 viewport 宽度计算错误出现横向滚动/阴影
        await injectViewportAndPopupGuard(webview, { injectShadowStyle: true });

        // 3. 注入页面组件屏蔽规则（按当前域名匹配预置 + 用户自定义规则）
        try {
          const rules = await listBlockRules();
          const url = webview.getURL();
          const hostname = new URL(url).hostname;
          const matched = rules.filter((r) => r.enabled && matchDomain(r.domainPattern, hostname));
          console.log(
            `[WebviewTab] 屏蔽规则注入: url=${url} hostname=${hostname} total=${rules.length} matched=${matched.length}` +
            (matched.length > 0
              ? ` | matched=[${matched.map((r) => `${r.label}(${r.type})`).join(', ')}]`
              : '')
          );
          if (matched.length > 0) {
            await webview.executeJavaScript(buildBlockerScript(matched));
          }
        } catch (e) {
          console.error('[WebviewTab] 屏蔽规则注入失败:', e);
        }

        // 4. 需求 7：Cookie 弹窗自动处理（白名单点击"接受全部"，黑名单隐藏）
        try {
          const settings = await getAppSettings();
          const url = webview.getURL();
          const hostname = new URL(url).hostname;
          const cookieScript = buildCookieHandlerScript(hostname, {
            whitelist: settings.cookieWhitelist,
            blacklist: settings.cookieBlacklist,
            cooldownMs: settings.cookiePopupCooldownMs,
            enabled: settings.cookieHandlerEnabled,
          });
          if (cookieScript) {
            await webview.executeJavaScript(cookieScript);
          }
        } catch (e) {
          console.error('[WebviewTab] Cookie 弹窗处理注入失败:', e);
        }

        // 5. 登录痕迹检测：仅对 AI 平台 Profile 生效。dom-ready 在每次导航后触发，
        //    覆盖页面间 URL 变化；等待 3 秒让登录后元素（头像/菜单）渲染完成，
        //    再执行检测脚本，若已登录且该 URL 未记录过，则记录一次登录痕迹。
        if (profile.isAIPlatform) {
          setTimeout(async () => {
            if (cancelled) return;
            try {
              const ret = await webview.executeJavaScript(DETECT_LOGIN_SCRIPT);
              if (cancelled) return;
              const parsed = JSON.parse(String(ret)) as {
                url?: string;
                cookie?: string;
                isLoggedIn?: boolean;
                error?: string;
              };
              if (parsed.error) return;
              const loginUrl = parsed.url || '';
              if (!parsed.isLoggedIn || !loginUrl) return;
              if (loggedLoginUrlsRef.current.has(loginUrl)) return;
              loggedLoginUrlsRef.current.add(loginUrl);
              lastLoginCheckedUrlRef.current = loginUrl;
              await logLoginTrace({
                profileId: profile.id,
                platform: profile.aiPlatformId,
                loginUrl,
                sessionData: parsed.cookie,
              });
            } catch (e) {
              console.error('[WebviewTab] 登录痕迹检测失败:', e);
            }
          }, 3000);
        }

        // 5.6 注入手柄/键盘空间导航脚本（Ctrl+G 切换开关）
        try {
          await webview.executeJavaScript(buildSpatialNavScript());
        } catch (e) {
          console.error('[WebviewTab] 空间导航注入失败:', e);
        }

        // 6. 注入 Enter 发送 / Shift+Enter 换行行为
        //    始终注入监听器，通过运行时标志 window.__ai_enter_send_enabled__ 控制开关
        //    这样设置面板切换 enterToSend 时无需重新注入，只需更新标志位
        try {
          await webview.executeJavaScript(`
            (function() {
              if (window.__ai_enter_send_injected__) {
                // 已注入，仅更新标志位
                window.__ai_enter_send_enabled__ = ${enterToSendRef.current};
                return;
              }
              window.__ai_enter_send_injected__ = true;
              window.__ai_enter_send_enabled__ = ${enterToSendRef.current};
              var inputSel = ${JSON.stringify(inputSelector ?? null)};
              var sendSel = ${JSON.stringify(sendSelector ?? null)};
              console.log('[EnterSend] 注入监听器, inputSel=', inputSel, 'sendSel=', sendSel, 'enabled=', window.__ai_enter_send_enabled__);

              function findSendButton(inputEl) {
                console.log('[EnterSend] findSendButton 开始, inputEl=', inputEl.tagName, 'sendSel=', sendSel);
                // 1. 优先用平台配置的 sendSelector
                if (sendSel) {
                  var btns = document.querySelectorAll(sendSel);
                  console.log('[EnterSend] sendSel 匹配数量:', btns.length);
                  for (var i = 0; i < btns.length; i++) {
                    var b = btns[i];
                    var s = window.getComputedStyle(b);
                    var visible = s.display !== 'none' && s.visibility !== 'hidden' && b.offsetParent !== null;
                    console.log('[EnterSend] sendSel 候选[' + i + ']:', b.tagName, 'class=', b.className, 'visible=', visible);
                    if (visible) {
                      console.log('[EnterSend] 找到发送按钮(sendSel):', b);
                      return b;
                    }
                  }
                }
                // 2. 在 input 所属 form 内查找 submit 按钮
                var form = inputEl && inputEl.closest && inputEl.closest('form');
                if (form) {
                  var submitBtn = form.querySelector('button[type=submit]');
                  if (submitBtn) {
                    console.log('[EnterSend] 找到 form submit 按钮');
                    return submitBtn;
                  }
                }
                // 3. 通用候选按钮：aria-label / class / data-testid 包含 send/发送
                var candidates = document.querySelectorAll(
                  'button[aria-label*="发送"], button[aria-label*="Send"], button[aria-label*="send"], ' +
                  'button[class*="send" i], button[class*="Send"], ' +
                  'div[role="button"][aria-label*="发送"], div[role="button"][aria-label*="Send"], div[role="button"][aria-label*="send"], ' +
                  'button[data-testid*="send" i], button[data-testid*="Send"]'
                );
                console.log('[EnterSend] 通用候选按钮数量:', candidates.length);
                for (var i = 0; i < candidates.length; i++) {
                  var c = candidates[i];
                  var style = window.getComputedStyle(c);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && c.offsetParent !== null) {
                    console.log('[EnterSend] 找到通用发送按钮:', c);
                    return c;
                  }
                }
                // 3.5 DeepSeek 等现代 SPA：发送按钮仅靠 class 区分（ds-button--primary--filled--circle--m），
                //     aria-label / "send" 文本都没有，只能靠主题色按钮特征识别：
                //     - 优先精确匹配 --primary + --circle（发送按钮的稳定特征）
                //     - 再 fallback 到含向上箭头 SVG 的 div[role="button"]
                //     注意：不再返回任意 ds-button，避免误点"深度思考"/"联网搜索"等开关按钮
                try {
                  // 3.5a 精确匹配 --primary + --circle（发送按钮特征）
                  var primaryCircleBtns = document.querySelectorAll(
                    'div[role="button"].ds-button--primary.ds-button--circle, ' +
                    'div[role="button"][class*="ds-button--primary"][class*="ds-button--circle"]'
                  );
                  console.log('[EnterSend] DeepSeek --primary--circle 匹配数量:', primaryCircleBtns.length);
                  for (var j = 0; j < primaryCircleBtns.length; j++) {
                    var pcb = primaryCircleBtns[j];
                    var pcs = window.getComputedStyle(pcb);
                    var pcbVisible = pcs.display !== 'none' && pcs.visibility !== 'hidden' && pcb.offsetParent !== null;
                    console.log('[EnterSend] primary--circle 候选[' + j + ']:', pcb.tagName, 'class=', pcb.className, 'visible=', pcbVisible);
                    if (pcbVisible) {
                      console.log('[EnterSend] 找到 DeepSeek 发送按钮(--primary--circle):', pcb);
                      return pcb;
                    }
                  }
                  // 3.5b 含向上箭头 SVG 的 div[role="button"]
                  var roleBtns = document.querySelectorAll('div[role="button"]');
                  console.log('[EnterSend] div[role="button"] 总数:', roleBtns.length);
                  for (var k = 0; k < roleBtns.length; k++) {
                    var rb = roleBtns[k];
                    var rs = window.getComputedStyle(rb);
                    if (rs.display === 'none' || rs.visibility === 'hidden' || !rb.offsetParent) continue;
                    var svg = rb.querySelector && rb.querySelector('svg');
                    if (!svg) continue;
                    var path = svg.querySelector && svg.querySelector('path');
                    if (!path) continue;
                    var d = path.getAttribute('d') || '';
                    // 匹配向上箭头（M...Y 0 0.981587 表示 SVG 起始点接近顶端）
                    if (d.indexOf('M8.3125') === 0 || d.indexOf('M12 4') === 0 || d.indexOf('M12 2') === 0 || /^[Mm]12,?\s*2/.test(d) || /^[Mm]12,?\s*4/.test(d)) {
                      console.log('[EnterSend] 找到含向上箭头 SVG 的 role=button:', rb, 'path d=', d);
                      return rb;
                    }
                  }
                } catch (e4) {
                  console.error('[EnterSend] DeepSeek 风格按钮查找失败:', e4);
                }
                // 4. 输入框附近的按钮（兄弟/父级子元素）
                if (inputEl && inputEl.parentElement) {
                  var nearbyBtns = inputEl.parentElement.querySelectorAll('button:not([disabled]), div[role="button"]');
                  console.log('[EnterSend] 输入框附近按钮数量:', nearbyBtns.length);
                  // 取最后一个可见按钮（通常是发送按钮）
                  var lastBtn = null;
                  for (var i = nearbyBtns.length - 1; i >= 0; i--) {
                    var nb = nearbyBtns[i];
                    var ns = window.getComputedStyle(nb);
                    if (ns.display !== 'none' && ns.visibility !== 'hidden' && nb.offsetParent !== null) {
                      lastBtn = nb;
                      break;
                    }
                  }
                  if (lastBtn) {
                    console.log('[EnterSend] 找到附近按钮:', lastBtn, 'class=', lastBtn.className);
                    return lastBtn;
                  }
                }
                console.log('[EnterSend] 未找到发送按钮');
                return null;
              }

              function isEditable(el) {
                if (!el) return false;
                var tag = el.tagName;
                if (tag === 'TEXTAREA' || (tag === 'INPUT' && (el.type === 'text' || el.type === ''))) return !el.disabled && !el.readOnly;
                if (el.isContentEditable) return true;
                return false;
              }

              document.addEventListener('keydown', function(e) {
                if (e.key !== 'Enter') return;
                if (e.isComposing) { console.log('[EnterSend] Enter 跳过: 输入法组合中'); return; }
                // 运行时开关：由外部通过 window.__ai_enter_send_enabled__ 控制
                if (!window.__ai_enter_send_enabled__) { console.log('[EnterSend] Enter 跳过: 功能未启用'); return; }
                var target = e.target;
                console.log('[EnterSend] Enter 按下, target:', target.tagName, 'id=', target.id, 'class=', target.className);
                if (!isEditable(target)) { console.log('[EnterSend] target 不可编辑，跳过'); return; }
                if (inputSel) {
                  var matched = false;
                  var els = document.querySelectorAll(inputSel);
                  for (var i = 0; i < els.length; i++) {
                    if (els[i] === target || els[i].contains(target)) { matched = true; break; }
                  }
                  // 模糊回退：SPA 站点可能更换 DOM 结构（如 DeepSeek 从 textarea 换成 contenteditable div），
                  // inputSel 不再匹配。此时如果 target 是页面上任何 textarea / contenteditable div，
                  // 也视为合法输入框（findSendButton 仍能正确找到发送按钮）。
                  if (!matched) {
                    var fallbackEls = document.querySelectorAll('textarea, div[contenteditable="true"], div[contenteditable=""]');
                    for (var fi = 0; fi < fallbackEls.length; fi++) {
                      if (fallbackEls[fi] === target || fallbackEls[fi].contains(target)) { matched = true; break; }
                    }
                    if (matched) console.log('[EnterSend] inputSel 未匹配但 fallback 命中');
                  }
                  if (!matched) { console.log('[EnterSend] inputSel 未匹配, 跳过. inputSel=', inputSel); return; }
                }
                // Shift+Enter = 换行，不拦截
                if (e.shiftKey) { console.log('[EnterSend] Shift+Enter, 换行'); return; }
                // 输入法组合中不拦截
                if (e.keyCode === 229) { console.log('[EnterSend] keyCode=229, 跳过'); return; }
                console.log('[EnterSend] 开始查找发送按钮, url=', location.pathname);
                // 先查找发送按钮，找到才 preventDefault + click
                // 找不到则不阻止原始事件，让网站自身的 Enter 处理逻辑正常工作
                var sendBtn = findSendButton(target);
                if (!sendBtn) {
                  console.log('[EnterSend] 未找到发送按钮，不拦截 Enter，交由网站处理');
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                console.log('[EnterSend] 拦截 Enter, 点击发送按钮:', sendBtn.tagName, 'class=', sendBtn.className);
                try {
                  sendBtn.click();
                  console.log('[EnterSend] 发送按钮 click() 调用完成');
                } catch (err) {
                  console.error('[EnterSend] 点击发送按钮失败:', err);
                }
              }, true);
              console.log('[EnterSend] 监听器已注册');
            })();
          `);
        } catch (e) {
          console.error('[WebviewTab] Enter 发送行为注入失败:', e);
        }
      } catch (e) {
        console.error('[WebviewTab] dom-ready 注入失败:', e);
      }
    };
    webview.addEventListener('dom-ready', handleDomReady as EventListener);

    // webview 内长按 Tab 调出底栏（500ms+）。
    // 注：Alt+1~9 / Ctrl+Tab / F11 / F12 / Ctrl+G 等应用内快捷键
    // 统一由主进程 before-input-event 拦截后通过 WEBVIEW_HOTKEY IPC 转发渲染层
    // （见 MainView/index.tsx 的 onWebviewHotkey 监听），此处仅保留长按 Tab 逻辑，
    // 因主进程无法实现长按计时。
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as {
        type: string;
        key: string;
        modifiers: string[];
        isAutoRepeat: boolean;
      };
      if (inputEvent.type === 'keyDown' && inputEvent.key === 'Tab') {
        const mods = inputEvent.modifiers || [];
        const hasModifier = mods.includes('control') || mods.includes('ctrl') || mods.includes('alt') || mods.includes('meta') || mods.includes('command');
        // 无修饰键的 Tab：完全拦截，不传给网页，长按切换底栏（已展开则收起，已收起则展开）
        if (!hasModifier && !inputEvent.isAutoRepeat) {
          e.preventDefault();
          // 长按 Tab 切换底栏
          if (longPressTabTimerRef.current) {
            clearTimeout(longPressTabTimerRef.current);
          }
          longPressTabTriggeredRef.current = false;
          longPressTabTimerRef.current = setTimeout(() => {
            longPressTabTriggeredRef.current = true;
            const store = useTabStore.getState();
            // 切换底栏（已展开则收起，已收起则展开）
            store.toggleBottomBar();
          }, 500);
          return;
        }
      }
      if (inputEvent.type === 'keyUp' && inputEvent.key === 'Tab') {
        if (longPressTabTimerRef.current) {
          clearTimeout(longPressTabTimerRef.current);
          longPressTabTimerRef.current = null;
        }
        longPressTabTriggeredRef.current = false;
      }
    };
    webview.addEventListener('before-input-event', handleBeforeInput);

    // 导航事件：更新 tab.url（含 hash 变化的 in-page 导航），保证"设为AI首页"用当前URL
    const handleNavigate = (e: Event) => {
      const navEvent = e as unknown as { url?: string; type?: string };
      const newUrl = navEvent.url;
      console.log('[WebviewTab] did-navigate, type=', (e as Event).type, 'newUrl=', newUrl, 'oldTabUrl=', tab.url);
      if (newUrl && newUrl !== tab.url) {
        void useTabStore.getState().updateTabUrl(tab.id, newUrl);
      }
      // 导航后上报导航能力（顶栏后退/前进按钮 disabled 状态）
      try { onNavigationChangeRef.current?.(webview.canGoBack(), webview.canGoForward()); } catch { /* ignore */ }
    };
    webview.addEventListener('did-navigate', handleNavigate as EventListener);
    webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener);

    // 触发 remount，带防循环保护：
    //   - 同一 URL 连续 remount 失败 ≥2 次时，回退到 profile.aiPlatformUrl 并重置计数
    //   - remount 后若新 webview 成功 dom-ready（见 handleDomReady），重置计数器
    //   - guest 崩溃 / ERR_FAILED 持续 / safeLoadURLWebview 失败 三种场景共用此函数
    // 防循环动机：aistudio.xiaomimimo.com 内 window.open 跳转到 platform.xiaomimimo.com
    //   被拦截后 loadURL 失败 → remount → 新 guest 加载同 URL 又失败 → 无限循环。
    //   通过记录上次失败 URL + 连续失败次数，≥2 次时改加载 profile 首页打破循环。
    // 注意：tab.url 在 effect 闭包中可能已过期，从 store 实时读取最新值做比较。
    const triggerRemount = (failUrl: string, reason: string, updateTabToFailUrl: boolean) => {
      const cleanFailUrl = sanitizeUrl(failUrl);
      // 从 store 读取最新 tab.url，避免闭包捕获过期值导致重复 updateTabUrl
      const currentTabUrl = useTabStore.getState().tabs.find((t) => t.id === tab.id)?.url || '';
      if (cleanFailUrl && cleanFailUrl === lastRemountFailUrlRef.current) {
        remountFailCountRef.current += 1;
        if (remountFailCountRef.current >= 2) {
          // 同一 URL 连续 remount 失败 ≥2 次：回退到 profile 首页，打破循环
          const homeUrl = sanitizeUrl(profile.aiPlatformUrl || '');
          console.warn(`[WebviewTab] ${reason}: 同一 URL 连续失败 ${remountFailCountRef} 次，回退首页:`, cleanFailUrl, '→', homeUrl);
          if (homeUrl && homeUrl !== cleanFailUrl) {
            lastRemountFailUrlRef.current = homeUrl;
            remountFailCountRef.current = 1; // 首页也算一次尝试，若首页也失败则下次走 homeUrl === cleanFailUrl 分支
            void useTabStore.getState().updateTabUrl(tab.id, homeUrl);
          } else {
            // 首页 URL 缺失或与失败 URL 相同：无法回退，重置计数后仅 remount 一次
            remountFailCountRef.current = 0;
            lastRemountFailUrlRef.current = '';
          }
          domReadyRef.current = false;
          onDomReadyChangeRef.current?.(false);
          setRemountKey((k) => k + 1);
          return;
        }
      } else {
        // 不同 URL：重置计数器为 1（首次失败）
        lastRemountFailUrlRef.current = cleanFailUrl;
        remountFailCountRef.current = 1;
      }
      // 默认路径：remount 同一 URL
      // updateTabToFailUrl=true（来自 handleFatalFailure）：先更新 tab.url 到目标 URL，
      // remount 后新 webview 的 src 会取自 tab.url
      if (updateTabToFailUrl && cleanFailUrl && cleanFailUrl !== currentTabUrl) {
        void useTabStore.getState().updateTabUrl(tab.id, cleanFailUrl);
      }
      console.warn(`[WebviewTab] ${reason}: 触发 remount:`, tab.id, 'URL:', cleanFailUrl);
      domReadyRef.current = false;
      onDomReadyChangeRef.current?.(false);
      setRemountKey((k) => k + 1);
    };

    // guest 渲染进程崩溃/被杀：webview DOM 元素仍在但底层 webContents 已失效，
    // 此时 reload()/loadURL()/src 赋值全部通过 GUEST_VIEW_MANAGER_CALL IPC 异步失败。
    // 唯一可靠恢复：通过 remountKey 变化强制 React 销毁并重建 <webview> DOM 元素，
    // 让 Electron 创建全新的 guest 进程。
    const handleProcessGone = (e: Event) => {
      const ev = e as unknown as { reason?: string; exitCode?: number };
      const reason = ev.reason || 'unknown';
      console.error('[WebviewTab] guest 进程异常退出:', { tabId: tab.id, reason, exitCode: ev.exitCode });
      onProcessGoneRef.current?.(reason);
      // 崩溃 URL = 当前 tab.url（如为空则用 profile 首页）
      const failUrl = tab.url || profile.aiPlatformUrl || '';
      triggerRemount(failUrl, `render-process-gone(${reason})`, false);
    };
    webview.addEventListener('render-process-gone', handleProcessGone as EventListener);

    // 加载失败（非 200 / 网络错误）：仅记录，不中断；避免与 did-navigate 重复处理。
    // 排除 -3 (ERR_ABORTED) —— 这是导航被取消（如用户点了另一个链接），属正常现象。
    // ERR_FAILED (-2) 且 isMainFrame：guest 进程可能处于僵尸状态（未正式崩溃但无法加载），
    // 延迟 500ms 后触发 remount（给 render-process-gone 事件留出先到达的时间）
    let remountTimer: ReturnType<typeof setTimeout> | null = null;
    // 代理兜底已触发标记：避免同一 tab 反复触发（用户下次 reload 时由 cleanup 重置）
    let proxyFallbackTriggered = false;
    // 代理相关错误码（Chromium net error codes）：
    //   -102 ERR_CONNECTION_FAILED    -103 ERR_CONNECTION_REFUSED
    //   -104 ERR_CONNECTION_RESET     -105 ERR_CONNECTION_ABORTED
    //   -106 ERR_CONNECTION_CLOSED    -107 ERR_CONNECTION_ENDED
    //   -111 ERR_TUNNEL_CONNECTION_FAILED  -118 ERR_CONNECTION_TIMED_OUT
    //   -127 ERR_PROXY_AUTH_UNSUPPORTED    -130 ERR_PROXY_CONNECTION_FAILED
    //   -136 ERR_PROXY_CERTIFICATE_INVALID -137 ERR_NAME_NOT_RESOLVED
    //   -202 ERR_CERT_AUTHORITY_INVALID (代理 MITM 证书问题)
    //   -300 ERR_INVALID_URL (代理配置错误)
    const PROXY_ERROR_CODES = new Set([
      -102, -103, -104, -105, -106, -107,
      -111, -118,
      -127, -130, -136,
      -137, -202, -300,
    ]);
    const handleFailLoad = (e: Event) => {
      const ev = e as unknown as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
      if (ev.errorCode === -3) return; // ERR_ABORTED: 导航被取消，忽略
      console.warn('[WebviewTab] 加载失败:', {
        tabId: tab.id,
        code: ev.errorCode,
        desc: ev.errorDescription,
        url: ev.validatedURL,
        isMainFrame: ev.isMainFrame,
      });
      // 代理错误码 + 主帧 + 未触发过兜底：触发代理失败兜底
      if (
        ev.isMainFrame &&
        ev.errorCode != null &&
        PROXY_ERROR_CODES.has(ev.errorCode) &&
        !proxyFallbackTriggered
      ) {
        proxyFallbackTriggered = true;
        console.warn('[WebviewTab] 检测到代理/网络错误，尝试代理失败兜底:', ev.errorCode, ev.errorDescription);
        void (async () => {
          try {
            const result = await applyProxyFallback();
            if (result.switched) {
              console.warn(`[WebviewTab] 代理兜底已切换到 ${result.mode} 模式，重新加载`);
              // 等待 200ms 让 session 代理生效，然后 reload
              setTimeout(() => {
                try {
                  const reloadUrl = ev.validatedURL || tab.url || '';
                  if (reloadUrl) {
                    void safeLoadURLWebview(webview, reloadUrl);
                  } else {
                    webview.reload();
                  }
                } catch (err) {
                  console.error('[WebviewTab] 代理兜底 reload 失败:', err);
                }
              }, 200);
            }
          } catch (err) {
            console.error('[WebviewTab] 调用代理兜底失败:', err);
          }
        })();
      }
      // ERR_FAILED (-2) 且主帧：guest 可能已死亡，延迟触发 remount
      // （如果 render-process-gone 先到达并已触发 remount，这里的定时器会在 cleanup 中被清除）
      if (ev.errorCode === -2 && ev.isMainFrame && !remountTimer) {
        const failUrl = ev.validatedURL || tab.url || '';
        remountTimer = setTimeout(() => {
          remountTimer = null;
          triggerRemount(failUrl, 'ERR_FAILED 持续', false);
        }, 500);
      }
    };
    webview.addEventListener('did-fail-load', handleFailLoad as EventListener);

    // safeLoadURLWebview/safeReloadWebview 在 loadURL/reload 异步失败时派发此事件。
    // 这是 guest 进程死亡的可靠信号 —— src 赋值的失败不触发 did-fail-load，
    // 只有此事件能在所有恢复手段都失败后通知 WebviewTab 触发 remount。
    // 事件 detail 携带目标 URL：triggerRemount 内部根据该 URL 做防循环判定与 tab.url 更新。
    const handleFatalFailure = (e: Event) => {
      const ev = e as CustomEvent<{ url?: string }>;
      const targetUrl = ev.detail?.url || '';
      console.warn('[WebviewTab] 收到 fatal-failure 事件:', tab.id, '目标 URL:', targetUrl);
      // triggerRemount 内部会处理防循环与 tab.url 更新
      triggerRemount(targetUrl, 'fatal-failure', true);
    };
    webview.addEventListener('ai-webview-fatal-failure', handleFatalFailure as EventListener);

    return () => {
      cancelled = true;
      domReadyRef.current = false;
      if (remountTimer) { clearTimeout(remountTimer); remountTimer = null; }
      webview.removeEventListener('dom-ready', handleDomReady as EventListener);
      webview.removeEventListener('before-input-event', handleBeforeInput);
      webview.removeEventListener('did-navigate', handleNavigate as EventListener);
      webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener);
      webview.removeEventListener('render-process-gone', handleProcessGone as EventListener);
      webview.removeEventListener('did-fail-load', handleFailLoad as EventListener);
      webview.removeEventListener('ai-webview-fatal-failure', handleFatalFailure as EventListener);
    };
  }, [profile.id, profile.isAIPlatform, profile.aiPlatformId, tab.id, inputSelector, sendSelector, remountKey]);

  // 主进程转发的 webview 弹窗 URL：在当前 webview tab 内导航（页面内跳转，不弹新窗口）。
  // 多 tab 共享同一渲染进程的 IPC 通道，通过 guest webContentsId 精准匹配到触发弹窗的 webview，
  // 避免其它 tab 误导航。监听随 tab 卸载而清理。
  // 依赖 remountKey：remount 后需重新绑定到新 webview 元素，否则弹窗导航会发到旧已销毁的 webview。
  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;
    const off = onWebviewPopupUrl(({ url, webContentsId }) => {
      let currentId: number | undefined;
      try {
        currentId = webview.getWebContentsId();
      } catch {
        // webview 未 attach 时 getWebContentsId 不可用，忽略本次事件
        return;
      }
      if (currentId !== webContentsId) return;
      console.log('[WebviewTab] 收到弹窗 URL 转发，页面内导航:', url);
      // 优先尝试 SPA 路由导航（history.pushState + popstate），避免全页 reload 导致白屏闪烁。
      // 仅对同源 URL 适用：跨域 pushState 会抛 SecurityError，需走 loadURL。
      // 失败时回退到 safeLoadURLWebview（处理 guest 崩溃后的 ERR_FAILED）。
      void (async () => {
        try {
          const currentUrl = webview.getURL?.() || '';
          let currentOrigin = '';
          let targetOrigin = '';
          try {
            currentOrigin = new URL(currentUrl).origin;
            targetOrigin = new URL(url).origin;
          } catch {
            // URL 解析失败，直接走 loadURL
          }
          if (currentOrigin && targetOrigin && currentOrigin === targetOrigin) {
            // 同源：优先 SPA 路由（pushState + popstate），避免全页 reload
            console.log('[WebviewTab] 同源弹窗 URL，尝试 SPA 路由导航:', url);
            const escapedUrl = url.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const result = await webview.executeJavaScript(`
              (function() {
                try {
                  var u = '${escapedUrl}';
                  // 仅当目标 URL 与当前 URL 不同时才导航（避免重复 pushState）
                  if (window.location.href === u) return { ok: true, skipped: true };
                  history.pushState({}, '', u);
                  // 派发 popstate 事件，通知 SPA 路由器更新 UI
                  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                  return { ok: true };
                } catch (e) {
                  return { ok: false, error: String(e) };
                }
              })()
            `) as { ok: boolean; skipped?: boolean; error?: string } | null;
            if (result && result.ok) {
              console.log('[WebviewTab] SPA 路由导航成功:', url, result.skipped ? '(已在该页面，跳过)' : '');
              return;
            }
            console.warn('[WebviewTab] SPA 路由导航失败，回退到 loadURL:', result?.error);
          }
        } catch (err) {
          console.warn('[WebviewTab] SPA 路由导航异常，回退到 loadURL:', err);
        }
        // 回退：使用 safeLoadURLWebview 处理 guest 崩溃后的 ERR_FAILED
        safeLoadURLWebview(webview, url);
      })();
    });
    return () => {
      off();
    };
  }, [tab.id, remountKey]);

  // 弹窗被连续拦截 3 次后，主进程通过 onPopupDenied 通知渲染层：
  // 弹出 confirm 对话框询问用户是否将该 origin 加入白名单（登录/验证页通常需要弹独立窗口）。
  // 监听在组件挂载时注册一次即可，无需依赖 webview 实例。
  // 白名单写入策略：优先写入当前 tab 所属 Profile 的专属白名单（Profile.popupWhitelist），
  // 避免不同 AI 应用的关联域互相污染全局白名单；profileId 不可用时回退到全局白名单。
  useEffect(() => {
    const off = onPopupDenied(({ origin, count }) => {
      console.log(`[WebviewTab] 弹窗被拦截 ${count} 次，提示加白:`, origin);
      const ok = window.confirm(
        `检测到弹窗被多次拦截：\n${origin}\n\n是否允许该站点弹窗？（登录/验证页面通常需要）`,
      );
      if (ok) {
        // 优先写入 Profile 专属白名单（隔离不同 AI 应用的关联域）
        if (tab.profileId) {
          void addToProfilePopupWhitelist(tab.profileId, origin);
        } else {
          // 回退：无 profileId（异常情况）写入全局白名单
          void addToPopupWhitelist(origin);
        }
      }
    });
    return () => off();
  }, [tab.profileId]);

  // enterToSend 变化时，仅更新 webview 内的运行时标志位（无需重新注入监听器）
  // 必须检查 domReadyRef，否则 webview 未 ready 时 executeJavaScript 会同步抛错导致白屏
  useEffect(() => {
    const webview = ref.current;
    if (!webview || !domReadyRef.current) return;
    webview.executeJavaScript(`window.__ai_enter_send_enabled__ = ${enterToSend !== false};`)
      .catch(() => { /* ignore */ });
  }, [enterToSend]);

  // profile UA / 设备预设变化时刷新 webview，使新 UA 生效
  const uaInitializedRef = useRef(false);
  useEffect(() => {
    const webview = ref.current;
    if (!webview || !profile.userAgent) return;
    // 首次挂载不 reload（避免与初始 src 加载冲突），之后 UA/设备变化才刷新
    if (!uaInitializedRef.current) {
      uaInitializedRef.current = true;
      return;
    }
    console.log('[WebviewTab] profile UA 已更新，刷新页面:', profile.name, profile.userAgent.slice(0, 40));
    if (!domReadyRef.current) return; // webview 未 ready 时 reload 会抛错或无效
    // 4.2: 通过 scheduleReload 检测流式数据流转，避免在 AI 流式回复过程中刷新导致数据丢失
    scheduleReload(webview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.userAgent, profile.devicePreset]);

  // 窄屏/宽屏自动切换 UA：窄屏用移动端预设 UA，宽屏用桌面端预设 UA
  // UA 锁定模式（profile.uaLockMode）覆盖自动切换：
  //   - 'mobile'：强制使用移动端预设
  //   - 'desktop'：强制使用桌面端预设
  //   - 'auto' / 未定义：保持按 isNarrow 切换
  const prevPresetRef = useRef<string>('');
  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;
    const uaLock = profile.uaLockMode ?? 'auto';
    const targetPresetId =
      uaLock === 'mobile' ? mobilePresetId
      : uaLock === 'desktop' ? desktopPresetId
      : (isNarrow ? mobilePresetId : desktopPresetId);
    if (prevPresetRef.current === targetPresetId) return;
    prevPresetRef.current = targetPresetId;
    // 异步获取预设的 UA 并切换
    let cancelled = false;
    getPreset(targetPresetId)
      .then((preset) => {
        if (cancelled || !webview) return;
        const targetUA = preset?.userAgent ?? profile.userAgent;
        try {
          webview.setUserAgent(targetUA);
          console.log('[WebviewTab] UA 已切换:', uaLock !== 'auto' ? `锁定${uaLock}` : (isNarrow ? '移动端' : '桌面端'), targetUA.slice(0, 40));
          if (!domReadyRef.current) return; // webview 未 ready 时 reload 会抛错或无效
          // 4.2: 通过 scheduleReload 检测流式数据流转，避免在 AI 流式回复过程中刷新导致数据丢失
          scheduleReload(webview);
        } catch (e) {
          console.error('[WebviewTab] 切换 UA 失败:', e);
        }
      })
      .catch((e) => console.error('[WebviewTab] 获取预设失败:', e));
    return () => {
      cancelled = true;
    };
  }, [isNarrow, desktopPresetId, mobilePresetId, profile.userAgent, profile.uaLockMode]);

  // 定期抓取网页对话内容并持久化到 SQLite（仅 AI 平台 Profile）
  // 策略：每 8 秒通过 executeJavaScript 取回「全量对话 pairs」{ pairs: [{user, assistant}], title, url }；
  //   连续两次抓取 pairs 哈希相同才视为「完成」并入库，避免在 AI 流式输出过程中存入半截回复；
  //   URL pathname 变化（切换到不同对话）时重置 conversationId，开启新会话；
  //   数据库 UNIQUE INDEX (conversation_id, content_hash) 兜底去重，全量重写也安全；
  //   同时监测 SPA 内 URL 变化（pushState 导航），变化时补做一次登录痕迹检测。
  useEffect(() => {
    if (!profile.isAIPlatform) return;
    const webview = ref.current;
    if (!webview) return;
    let cancelled = false;

    // 持久化多轮对话（全量 pairs），按需创建会话。
    // 数据库 UNIQUE INDEX (conversation_id, content_hash) 自动去重，
    // 因此全量重写同一对话也安全，不会出现 DeepSeek 重复保存问题。
    const persistPairs = async (
      pairs: Array<{ user: string; assistant: string }>,
      title: string,
    ) => {
      console.log('[WebviewTab] persistPairs 开始, pairs=', pairs.length, 'title=', title, 'isNew=', !conversationIdRef.current);
      try {
        const isNewConversation = !conversationIdRef.current;
        if (isNewConversation) {
          // 记录对话发生时的页面 URL，用于"启动时打开最近对话"功能
          const currentUrl = webview.getURL();
          console.log('[WebviewTab] 创建新对话记录, profileId=', profile.id, 'url=', currentUrl);
          const conv = await createConversation(profile.id, 'webview', title || profile.name, currentUrl);
          if (cancelled) { console.log('[WebviewTab] persistPairs 取消（effect 已销毁）'); return; }
          conversationIdRef.current = conv.id;
          console.log('[WebviewTab] 新对话已创建, convId=', conv.id);
        }
        const cid = conversationIdRef.current;
        if (!cid) { console.log('[WebviewTab] persistPairs 跳过: cid 为空'); return; }
        let savedCount = 0;
        let skippedShort = 0;
        for (const pair of pairs) {
          // 需求 5：过滤 <15 字符的单方面文本（仅含标点/空白也过滤）
          if (pair.user && pair.user.trim().length >= 15) {
            await saveMessageWithMerge({ conversationId: cid, role: 'user', content: pair.user, autoGrabbed: true });
            savedCount++;
          } else if (pair.user) {
            skippedShort++;
          }
          if (pair.assistant && pair.assistant.trim().length >= 15) {
            await saveMessageWithMerge({ conversationId: cid, role: 'assistant', content: pair.assistant, autoGrabbed: true });
            savedCount++;
          } else if (pair.assistant) {
            skippedShort++;
          }
        }
        console.log('[WebviewTab] persistPairs 完成, convId=', cid, '已保存=', savedCount, '过滤短消息=', skippedShort);
        // 入库后通知主进程广播给其他窗口（HistoryView 订阅以实时刷新侧边栏）
        // 避免重复广播：仅新建对话或内容变化时触发（persistPairs 本身仅在哈希变化时调用）
        void notifyConversationPersisted(profile.id).catch((e) => {
          console.warn('[WebviewTab] 广播入库事件失败:', e);
        });
      } catch (e) {
        console.error('[WebviewTab] 对话持久化失败:', e);
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (!domReadyRef.current) return; // webview 未 ready 时跳过，避免 executeJavaScript 同步抛错
      try {
        const ret = await webview.executeJavaScript(SCRAPE_CHAT_SCRIPT);
        if (cancelled) return;
        const parsed = JSON.parse(String(ret)) as {
          pairs?: Array<{ user?: string; assistant?: string }>;
          title?: string;
          url?: string;
          error?: string;
        };
        if (parsed.error) return;

        const url = parsed.url || '';
        // URL pathname 变化 → 视为切换到不同对话：重置会话 id 与稳定性哈希
        let currentPath = '';
        try {
          currentPath = url ? new URL(url).pathname : '';
        } catch { /* 无效 URL 时保持空串 */ }
        if (currentPath && currentPath !== lastUrlPathRef.current) {
          console.log('[WebviewTab] URL pathname 变化, 旧=', lastUrlPathRef.current, '新=', currentPath);
          lastUrlPathRef.current = currentPath;
          conversationIdRef.current = null;
          lastScrapedHashRef.current = '';
          stableCountRef.current = 0;
          console.log('[WebviewTab] 已重置会话: convId=null, path=', currentPath);
        }

        // 截断每条 pair 的文本，避免单条消息过大
        const pairs = (parsed.pairs || [])
          .map((p) => ({
            user: (p.user || '').slice(0, 8000),
            assistant: (p.assistant || '').slice(0, 8000),
          }))
          .filter((p) => p.user || p.assistant);
        const title = parsed.title || '';

        // 稳定性判定：连续两次抓取 pairs 哈希相同 → 视为完成
        const currentHash = pairs.length > 0 ? simpleHash(JSON.stringify(pairs)) : '';
        if (currentHash && currentHash === lastScrapedHashRef.current) {
          stableCountRef.current += 1;
          console.log('[WebviewTab] 抓取稳定, stableCount=', stableCountRef.current, 'pairs=', pairs.length, 'path=', currentPath);
        } else {
          stableCountRef.current = 0;
          lastScrapedHashRef.current = currentHash;
        }

        // 连续第二次相同且与上次入库不同 → 入库
        if (
          stableCountRef.current === 1 &&
          pairs.length > 0 &&
          currentHash !== lastPersistedHashRef.current
        ) {
          console.log('[WebviewTab] 触发入库, pairs=', pairs.length, 'hash=', currentHash, '上次入库hash=', lastPersistedHashRef.current);
          lastPersistedHashRef.current = currentHash;
          void persistPairs(pairs, title);
        }

        // SPA 内 URL 变化时补做登录检测（覆盖 pushState/replaceState 导航，dom-ready 不触发的情况）
        if (url && url !== lastLoginCheckedUrlRef.current && !loggedLoginUrlsRef.current.has(url)) {
          lastLoginCheckedUrlRef.current = url;
          try {
            const lret = await webview.executeJavaScript(DETECT_LOGIN_SCRIPT);
            if (cancelled) return;
            const lp = JSON.parse(String(lret)) as {
              url?: string;
              cookie?: string;
              isLoggedIn?: boolean;
              error?: string;
            };
            if (!lp.error && lp.isLoggedIn && lp.url && !loggedLoginUrlsRef.current.has(lp.url)) {
              loggedLoginUrlsRef.current.add(lp.url);
              await logLoginTrace({
                profileId: profile.id,
                platform: profile.aiPlatformId,
                loginUrl: lp.url,
                sessionData: lp.cookie,
              });
            }
          } catch (e) {
            console.error('[WebviewTab] SPA 登录检测失败:', e);
          }
        }
      } catch (e) {
        console.error('[WebviewTab] 抓取失败:', e);
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.name, profile.isAIPlatform, profile.aiPlatformId, tab.id, remountKey]);

  if (!src) return null;

  return (
    <webview
      key={`${tab.id}-${remountKey}`}
      ref={ref as React.RefObject<HTMLElement> as React.RefObject<WebviewElement>}
      src={src}
      partition={`persist:${profile.id}`}
      useragent={profile.userAgent || undefined}
      {...({ allowpopups: 'true', backgroundcolor: 'transparent' } as Record<string, unknown>)}
      data-tab-id={tab.id}
      data-name="main.webview-tab.webview"
      data-id={tab.id}
      style={{
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        display: 'flex',
        visibility: active ? 'visible' : 'hidden',
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
    />
  );
}
