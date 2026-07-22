/* =====================================================================
   hooks/useWebViewControl.ts —— WebView 控制与文本注入
   迁移到 Electron 单页架构后：渲染进程持有 <webview> 元素，
   UA / 置顶 / 关闭等通过 window.electron IPC 通知主进程操作窗口；
   文本注入（明输入明注入）则由渲染进程直接调用 webview.executeJavaScript 实现。
   ===================================================================== */

import { useCallback } from 'react';
import {
  switchWindowUA,
  switchWindowDevice,
  setWindowAlwaysOnTop,
  closeWindow,
} from '../lib/electron-api';

/** webview 元素最小接口（仅注入所需方法） */
export interface WebviewLike {
  executeJavaScript(script: string): Promise<unknown>;
  focus?(): void;
}

/**
 * 构建「明输入明注入」脚本 —— 将文本填入 AI 平台输入框。
 * 采用两级降级策略：平台专属选择器 → 通用 textarea/contenteditable 兜底。
 * 返回 IIFE 脚本字符串，由调用方通过 webview.executeJavaScript 执行。
 *
 * ## DeepSeek 副作用问题修复（重要）
 *
 * 早期方案只派发 `CustomEvent('__ai_voice_inject__')`，但 DeepSeek 使用了多种副作用触发链：
 *  1. `input`/`change` 事件 → 走 React 的 onInput 监听
 *  2. **MutationObserver** 监听 textarea 的 value 属性变化
 *  3. **focus 事件**（textarea 触发自动聚焦 / sidebar 自动展开）
 *  4. 直接监听 `selectionchange` 事件
 *
 * **新方案 —— 完全绕开 React 副作用**：
 *  - 用 React 拦截前的原生 setter 设置 value（避免 React onChange 链路）
 *  - **不**派发任何事件（input/change/我们的 CustomEvent 都不派发）
 *  - **主动关闭副作用产物**：注入完成后立刻检测并
 *    a. 调用 `document.activeElement.blur()` 移除误聚焦
 *    b. 关闭被自动打开的 sidebar（按 ESC / 找带 `aria-expanded=true` 的按钮再次点击）
 *    c. 清空任何被 focus 出来的搜索输入框的 value
 *  - **多次 setTimeout 持续清理**（0ms / 50ms / 150ms / 400ms），覆盖 React
 *    重渲染 + Transition 动画期间可能多次触发的副作用链
 *  - 派发 input/change 事件让 React 同步 internal state，避免用户点击输入框时
 *    React 用空 state 覆盖 DOM value 导致注入文本消失
 */
export function buildInjectionScript(text: string, selector?: string | null): string {
  return `(function(text, selector) {
  var nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  );
  var inputSetter = nativeSetter && nativeSetter.set;
  function fill(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // 关键：用 React 拦截前的原生 setter 设置值（绕开 React 受控组件）
      if (inputSetter) inputSetter.call(el, text);
      else el.value = text;
      // 修复：派发 input/change 事件让 React 同步 internal state
      // 之前不派发导致 React state 与 DOM value 不同步，用户点击输入框触发 re-render 时
      // React 用空 state 覆盖 DOM value，注入的文本消失
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      // contenteditable：直接设置 textContent 也可能被 onInput 监听
      // 用 document.execCommand 是浏览器原生行为，不走 React onInput
      el.focus();
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      } catch (e) {
        el.textContent = text;
      }
    } else {
      el.value = text;
    }
  }
  // 1. 平台专属选择器（可能为逗号分隔的多选择器）
  if (selector) {
    var el = document.querySelector(selector);
    if (el) { fill(el); }
    else {
      // 2. 通用兜底：任意可编辑 textarea / input / contenteditable
      var ta = document.querySelector('textarea:not([disabled]):not([readonly])')
        || document.querySelector('input[type=text]:not([disabled]):not([readonly])');
      if (ta) fill(ta);
      else {
        var ce = document.querySelector('div[contenteditable=true]');
        if (ce) fill(ce);
      }
    }
  } else {
    // 无选择器时走通用兜底
    var ta2 = document.querySelector('textarea:not([disabled]):not([readonly])')
      || document.querySelector('input[type=text]:not([disabled]):not([readonly])');
    if (ta2) fill(ta2);
    else {
      var ce2 = document.querySelector('div[contenteditable=true]');
      if (ce2) fill(ce2);
    }
  }

  // ===== 副作用清理：DeepSeek 等 React 框架会在 input 时自动展开 sidebar / focus 搜索框 =====
  // 关键：React 渲染 + Transition 动画期间可能多次触发表单副作用（延迟到 200~500ms 后）。
  // 单次 setTimeout(0) 清理不够，必须**多次**在 0/50/150/400ms 持续清理，覆盖整个动画链。
  function cleanupSidebarArtifacts() {
    try {
      // 1. blur 误聚焦的"搜索对话"输入框
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        var targetSel = selector ? selector.split(',')[0].trim() : 'textarea';
        var target = document.querySelector(targetSel);
        if (target && ae !== target) {
          ae.blur();
        }
      }
      // 2. 关闭被自动展开的侧边栏（DeepSeek 用 aria-expanded 标记）
      //    关键：必须用 querySelectorAll 找到所有当前 aria-expanded="true" 的按钮，
      //    多次循环关闭（同一个 sidebar 可能由不同按钮控制）
      var expandedBtns = document.querySelectorAll('[aria-expanded="true"][aria-controls]');
      for (var i = 0; i < expandedBtns.length; i++) {
        var btn = expandedBtns[i];
        var controls = btn.getAttribute('aria-controls') || '';
        if (/sidebar|drawer|panel|sidenav/i.test(controls) || /sidebar|drawer|panel|sidenav/i.test((btn.className || '') + ' ' + (btn.id || ''))) {
          try { btn.click(); } catch (e3) { /* ignore */ }
        }
      }
      // 3. 兜底：直接找 DeepSeek 特定的 sidebar 关闭按钮
      var closeBtns = document.querySelectorAll(
        'button[aria-label*="关闭" i], button[aria-label*="close" i], ' +
        'button[title*="关闭" i], button[title*="close" i], ' +
        'button[class*="close" i]'
      );
      for (var j = 0; j < closeBtns.length; j++) {
        var cb = closeBtns[j];
        var p = cb.parentElement;
        while (p && p !== document.body) {
          if (/sidebar|drawer|panel|sidenav/i.test((p.className || '') + ' ' + (p.id || ''))) {
            try { cb.click(); } catch (e4) { /* ignore */ }
            break;
          }
          p = p.parentElement;
        }
      }
      // 4. 兜底：清空误打开的搜索框（DeepSeek 在用户输入时会展开"搜索对话"侧栏 + 自动聚焦搜索框）
      var searchInputs = document.querySelectorAll(
        'input[type="search"], input[placeholder*="搜索" i], input[placeholder*="search" i]'
      );
      for (var k = 0; k < searchInputs.length; k++) {
        var si = searchInputs[k];
        // 仅清空当前被自动聚焦的搜索框（避免误清用户真正想用的）
        if (document.activeElement === si) {
          if (inputSetter) inputSetter.call(si, '');
          else si.value = '';
          si.blur();
        }
      }
    } catch (e) {
      console.warn('[voice-inject] sidebar 清理异常:', e);
    }
  }
  // 立即清理（同步）+ 多次 setTimeout 覆盖 React 重渲染 + Transition 动画
  cleanupSidebarArtifacts();
  setTimeout(cleanupSidebarArtifacts, 0);
  setTimeout(cleanupSidebarArtifacts, 50);
  setTimeout(cleanupSidebarArtifacts, 150);
  setTimeout(cleanupSidebarArtifacts, 400);

  return true;
})(${JSON.stringify(text)}, ${JSON.stringify(selector ?? null)})`;
}

/**
 * 注入文本到指定 webview 的 AI 输入框。
 * @returns 是否成功找到并填充输入框
 */
export async function injectTextToWebview(
  webview: WebviewLike,
  text: string,
  selector?: string | null,
): Promise<boolean> {
  try {
    const result = await webview.executeJavaScript(buildInjectionScript(text, selector));
    return Boolean(result);
  } catch (e) {
    console.error('[injectTextToWebview] 注入失败:', e);
    return false;
  }
}

/**
 * 触发发送：优先点击平台发送按钮，回退对输入框 dispatch Enter。
 * @param webview 目标 webview 元素
 * @param sendSelector 平台发送按钮 CSS 选择器（可逗号分隔）
 * @param inputSelector 输入框选择器（Enter 回退用），未传则用通用 textarea 兜底
 * @returns 是否成功触发发送
 */
export async function triggerSendInWebview(
  webview: WebviewLike,
  sendSelector?: string | null,
  inputSelector?: string | null,
): Promise<boolean> {
  const script = `(function(sendSel, inputSel) {
  // 1. 优先点击发送按钮
  if (sendSel) {
    var btn = document.querySelector(sendSel);
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }
  }
  // 2. 回退：对输入框 dispatch Enter keydown/keyup
  var el = null;
  if (inputSel) el = document.querySelector(inputSel);
  if (!el) el = document.querySelector('textarea:not([disabled]):not([readonly])')
         || document.querySelector('div[contenteditable=true]');
  if (!el) return false;
  try { el.focus(); } catch (e) {}
  var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  try {
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  } catch (e) {
    return false;
  }
})(${JSON.stringify(sendSelector ?? null)}, ${JSON.stringify(inputSelector ?? null)})`;
  try {
    const result = await webview.executeJavaScript(script);
    return Boolean(result);
  } catch (e) {
    console.error('[triggerSendInWebview] 触发发送失败:', e);
    return false;
  }
}

/**
 * 清空当前对话输入框。
 * @returns 是否成功清空
 */
export async function clearConversationInWebview(
  webview: WebviewLike,
  inputSelector?: string | null,
): Promise<boolean> {
  const script = `(function(inputSel) {
  var nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  );
  var setter = nativeSetter && nativeSetter.set;
  function clear(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      try { document.execCommand('selectAll'); } catch (e) {}
      try { document.execCommand('delete'); } catch (e) { el.innerText = ''; }
    } else {
      el.value = '';
    }
  }
  var el = null;
  if (inputSel) el = document.querySelector(inputSel);
  if (!el) el = document.querySelector('textarea:not([disabled]):not([readonly])')
         || document.querySelector('div[contenteditable=true]');
  if (!el) return false;
  clear(el);
  try { el.blur(); } catch (e) {}
  return true;
})(${JSON.stringify(inputSelector ?? null)})`;
  try {
    const result = await webview.executeJavaScript(script);
    return Boolean(result);
  } catch (e) {
    console.error('[clearConversationInWebview] 清空失败:', e);
    return false;
  }
}

/**
 * 聚焦 AI 平台输入框（通用兜底策略：textarea → contenteditable）。
 * @returns 是否成功聚焦
 */
export async function focusInputInWebview(
  webview: WebviewLike,
  inputSelector?: string | null,
): Promise<boolean> {
  const script = `(function(inputSel) {
  var el = null;
  if (inputSel) el = document.querySelector(inputSel);
  if (!el) el = document.querySelector('textarea:not([disabled]):not([readonly])')
         || document.querySelector('div[contenteditable=true]');
  if (!el) return false;
  try { el.focus(); } catch (e) { return false; }
  return true;
})(${JSON.stringify(inputSelector ?? null)})`;
  try {
    const result = await webview.executeJavaScript(script);
    return Boolean(result);
  } catch (e) {
    console.error('[focusInputInWebview] 聚焦失败:', e);
    return false;
  }
}

/**
 * 注入「Enter 发送 / Shift+Enter 换行」行为到 AI 平台输入框。
 * 监听输入框 keydown，Enter 阻止默认并点击发送按钮，Shift+Enter 保留换行。
 * 注入前检测是否已注入，避免重复绑定。
 * @returns 是否成功注入
 */
export async function injectEnterSendBehavior(
  webview: WebviewLike,
  inputSelector?: string | null,
  sendSelector?: string | null,
): Promise<boolean> {
  const script = `(function(inputSel, sendSel) {
  if (window.__ai_enter_send_injected__) return true;
  window.__ai_enter_send_injected__ = true;

  function findSendButton(inputEl) {
    // 1. 指定选择器优先
    if (sendSel) {
      var btn = document.querySelector(sendSel);
      if (btn) return btn;
    }
    // 2. 从输入框向上找 form，再找提交按钮
    var form = inputEl && inputEl.closest && inputEl.closest('form');
    if (form) {
      var submitBtn = form.querySelector('button[type=submit]');
      if (submitBtn) return submitBtn;
    }
    // 3. 通用兜底：查找可见的发送类按钮
    var candidates = document.querySelectorAll('button[aria-label*="发送"], button[aria-label*="Send"], button[class*="send"]');
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var style = window.getComputedStyle(c);
      if (style.display !== 'none' && style.visibility !== 'hidden' && c.offsetParent !== null) {
        return c;
      }
    }
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
    if (e.key !== 'Enter' || e.isComposing) return;
    var target = e.target;
    // 如果不是可编辑元素，不处理
    if (!isEditable(target)) return;
    // 如果指定了 inputSel 但目标不匹配，模糊回退
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
      }
      if (!matched) return;
    }
    if (e.shiftKey) {
      // Shift+Enter：保持默认行为（换行）
      return;
    }
    // Enter：阻止默认，点击发送按钮
    e.preventDefault();
    e.stopPropagation();
    var sendBtn = findSendButton(target);
    if (sendBtn) {
      try { sendBtn.click(); } catch (err) {
        // 兜底：派发 Enter 事件
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        } catch (e2) {}
      }
    }
  }, true);

  return true;
})(${JSON.stringify(inputSelector ?? null)}, ${JSON.stringify(sendSelector ?? null)})`;
  try {
    const result = await webview.executeJavaScript(script);
    return Boolean(result);
  } catch (e) {
    console.error('[injectEnterSendBehavior] 注入失败:', e);
    return false;
  }
}

export interface WebViewControlApi {
  /**
   * 运行时切换指定 Profile 窗口的 UA（不重建窗口，刷新生效）
   */
  switchUA: (profileId: string, ua: string) => Promise<void>;
  /**
   * 切换指定 Profile 窗口的设备预设
   */
  switchDevice: (profileId: string, presetId: string) => Promise<void>;
  /**
   * 设置指定 Profile 窗口置顶
   */
  setAlwaysOnTop: (profileId: string, onTop: boolean) => Promise<void>;
  /**
   * 关闭指定 Profile 窗口
   */
  closeWindow: (profileId: string) => Promise<void>;
  /**
   * 注入文本到指定 webview 的 AI 输入框（明输入明注入）。
   * 需传入目标 webview 元素与平台选择器。
   */
  injectText: (text: string, webview: WebviewLike, selector?: string | null) => Promise<boolean>;
  /**
   * 触发发送：优先点击平台发送按钮，回退对输入框 dispatch Enter。
   */
  triggerSend: (webview: WebviewLike, sendSelector?: string | null, inputSelector?: string | null) => Promise<boolean>;
  /**
   * 清空当前对话输入框。
   */
  clearConversation: (webview: WebviewLike, inputSelector?: string | null) => Promise<boolean>;
  /**
   * 聚焦 AI 平台输入框（通用兜底）。
   */
  focusInput: (webview: WebviewLike, inputSelector?: string | null) => Promise<boolean>;
  /**
   * 注入 Enter 发送 / Shift+Enter 换行行为。
   */
  injectEnterSend: (webview: WebviewLike, inputSelector?: string | null, sendSelector?: string | null) => Promise<boolean>;
}

/**
 * Profile 窗口控制 Hook —— 返回稳定的操作函数集合
 *
 * @example
 * const { switchUA, closeWindow } = useWebViewControl();
 * await switchUA(profileId, newUA);
 */
export function useWebViewControl(): WebViewControlApi {
  const switchUA = useCallback(async (profileId: string, ua: string): Promise<void> => {
    await switchWindowUA(profileId, ua);
  }, []);

  const switchDevice = useCallback(
    async (profileId: string, presetId: string): Promise<void> => {
      await switchWindowDevice(profileId, presetId);
    },
    [],
  );

  const setAlwaysOnTop = useCallback(
    async (profileId: string, onTop: boolean): Promise<void> => {
      await setWindowAlwaysOnTop(profileId, onTop);
    },
    [],
  );

  const closeWindowFn = useCallback(async (profileId: string): Promise<void> => {
    await closeWindow(profileId);
  }, []);

  // 注入文本到 webview 输入框（明输入明注入）—— 由渲染进程直接执行
  const injectText = useCallback(
    (text: string, webview: WebviewLike, selector?: string | null): Promise<boolean> => {
      return injectTextToWebview(webview, text, selector);
    },
    [],
  );

  const triggerSend = useCallback(
    (webview: WebviewLike, sendSelector?: string | null, inputSelector?: string | null): Promise<boolean> => {
      return triggerSendInWebview(webview, sendSelector, inputSelector);
    },
    [],
  );

  const clearConversation = useCallback(
    (webview: WebviewLike, inputSelector?: string | null): Promise<boolean> => {
      return clearConversationInWebview(webview, inputSelector);
    },
    [],
  );

  const focusInput = useCallback(
    (webview: WebviewLike, inputSelector?: string | null): Promise<boolean> => {
      return focusInputInWebview(webview, inputSelector);
    },
    [],
  );

  const injectEnterSend = useCallback(
    (webview: WebviewLike, inputSelector?: string | null, sendSelector?: string | null): Promise<boolean> => {
      return injectEnterSendBehavior(webview, inputSelector, sendSelector);
    },
    [],
  );

  return {
    switchUA,
    switchDevice,
    setAlwaysOnTop,
    closeWindow: closeWindowFn,
    injectText,
    triggerSend,
    clearConversation,
    focusInput,
    injectEnterSend,
  };
}
