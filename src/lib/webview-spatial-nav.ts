/* =====================================================================
   lib/webview-spatial-nav.ts —— 手柄/键盘空间导航注入脚本
   参照 W3C js-spatial-navigation 算法：
   - 方向键：半平面过滤 + 投影距离最近候选
   - 手柄：navigator.getGamepads() 轮询 + 摇杆阈值 + 按键映射
   - Ctrl+G 切换开关（由 before-input-event 拦截触发）
   - 虚拟鼠标光标：跟随焦点元素移动，Enter 触发点击动画
   ===================================================================== */

export function buildSpatialNavScript(): string {
  return `(function() {
    if (window.__ai_spatial_nav__) return;
    var enabled = false;
    var currentEl = null;
    var outlineStyle = '3px solid #c25a4a';
    var shadowStyle = '0 0 8px rgba(194, 90, 74, 0.6)';
    var prevOutline = '';
    var prevShadow = '';
    var cursorEl = null;
    var cursorInner = null;

    // 虚拟鼠标光标 SVG（经典箭头指针，白底深色边框，任意背景可见）
    var cursorSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
      'viewBox="0 0 24 24" style="display:block;">' +
      '<path d="M3 2 L3 19 L7.5 14.8 L10.2 21.2 L13 20 L10.4 13.6 L17 13.4 Z" ' +
      'fill="#ffffff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round" ' +
      'stroke-linecap="round"/></svg>';

    function createCursor() {
      if (cursorEl) return;
      cursorEl = document.createElement('div');
      cursorEl.setAttribute('data-ai-spatial-cursor', '1');
      cursorEl.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'width:24px',
        'height:24px',
        'z-index:2147483647',
        'pointer-events:none',
        'transition:left 0.15s ease-out, top 0.15s ease-out',
        'will-change:left, top',
        'margin:0',
        'padding:0'
      ].join(';');
      cursorInner = document.createElement('div');
      cursorInner.style.cssText = [
        'width:24px',
        'height:24px',
        'transform-origin:3px 2px',
        'transition:transform 0.12s ease-out'
      ].join(';');
      cursorInner.innerHTML = cursorSVG;
      cursorEl.appendChild(cursorInner);
      document.documentElement.appendChild(cursorEl);
    }

    function removeCursor() {
      if (cursorEl && cursorEl.parentNode) {
        cursorEl.parentNode.removeChild(cursorEl);
      }
      cursorEl = null;
      cursorInner = null;
    }

    // 将光标移动到指定元素中心（偏移到指针尖端位置）
    function moveCursorTo(el) {
      if (!cursorEl || !el) return;
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      // 让箭头尖端对准元素中心
      cursorEl.style.left = (cx - 3) + 'px';
      cursorEl.style.top = (cy - 2) + 'px';
    }

    // 点击缩放反馈动画
    function playClickAnim() {
      if (!cursorInner) return;
      cursorInner.style.transform = 'scale(0.7)';
      setTimeout(function() {
        if (cursorInner) cursorInner.style.transform = 'scale(1)';
      }, 120);
    }

    // 判断元素是否可见（不依赖 offsetParent，支持 position:fixed 元素）
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      // viewport 内或可滚动到视口内即可
      return true;
    }

    function getFocusables() {
      // 扩大选区：原生可交互元素 + ARIA role + 常见可点击容器 + 有事件属性的元素
      var sel = 'a[href], button:not([disabled]), input:not([disabled]), ' +
        'textarea:not([disabled]), select:not([disabled]), [tabindex], ' +
        '[contenteditable=true], [contenteditable=""], [role=button], [role=link], ' +
        '[role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], ' +
        '[role=switch], [onclick], [class*="btn"], [class*="button"], [class*="click"], ' +
        'summary, label, [data-action], [data-click], [data-href]';
      var list = [];
      var all = document.querySelectorAll(sel);
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!isVisible(el)) continue;
        list.push(el);
      }
      return list;
    }

    function highlight(el) {
      if (currentEl && currentEl !== el) {
        currentEl.style.outline = prevOutline;
        currentEl.style.boxShadow = prevShadow;
      }
      currentEl = el;
      if (el) {
        prevOutline = el.style.outline;
        prevShadow = el.style.boxShadow;
        el.style.outline = outlineStyle;
        el.style.boxShadow = shadowStyle;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        moveCursorTo(el);
      }
    }

    // 查找元素最近的可交互祖先（包括自身）
    function findInteractiveEl(el) {
      var node = el;
      var depth = 0;
      while (node && node !== document.documentElement && depth < 20) {
        if (!node.tagName) { node = node.parentElement; depth++; continue; }
        var tag = node.tagName.toLowerCase();
        // 原生可交互元素
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
            tag === 'select' || tag === 'label' || tag === 'summary') {
          if (node.disabled !== true) return node;
        }
        // ARIA role 可交互
        var role = node.getAttribute && node.getAttribute('role');
        if (role && /^(button|link|tab|menuitem|option|checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)) {
          return node;
        }
        // 有点击事件绑定
        if (node.onclick || (node.getAttribute && node.getAttribute('onclick'))) {
          return node;
        }
        // tabindex 表示可聚焦（也可能可点击）
        var ti = node.getAttribute && node.getAttribute('tabindex');
        if (ti !== null && ti !== '-1' && depth > 0) {
          // 只有当没有更具体的可交互元素时才用 tabindex 元素
        }
        node = node.parentElement;
        depth++;
      }
      return el; // 找不到就返回原元素
    }

    // 在指定坐标触发真实点击：找到最深层元素 → 找到可交互祖先 → 分发完整事件序列
    function clickAt(cx, cy) {
      var target = document.elementFromPoint(cx, cy);
      console.log('[spatial-nav] elementFromPoint:', cx, cy, '→', target && target.tagName, target && target.className);
      if (!target) return false;
      var interactiveEl = findInteractiveEl(target);
      console.log('[spatial-nav] 交互元素:', interactiveEl.tagName, interactiveEl.className || '', interactiveEl.id || '');

      var opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy,
        button: 0,
        buttons: 1,
        composed: true,
      };

      // focus
      try {
        if (typeof interactiveEl.focus === 'function' && (
          interactiveEl.tagName === 'INPUT' ||
          interactiveEl.tagName === 'TEXTAREA' ||
          interactiveEl.tagName === 'SELECT' ||
          interactiveEl.isContentEditable ||
          interactiveEl.hasAttribute('tabindex')
        )) {
          interactiveEl.focus();
        }
      } catch (e) { /* webview 上下文错误已通过返回值上报 */ }

      // Pointer 事件序列（带 over/enter 前置）
      try {
        target.dispatchEvent(new PointerEvent('pointerover', opts));
        target.dispatchEvent(new PointerEvent('pointerenter', opts));
        interactiveEl.dispatchEvent(new PointerEvent('pointerdown', opts));
        interactiveEl.dispatchEvent(new PointerEvent('pointerup', opts));
        interactiveEl.dispatchEvent(new PointerEvent('click', opts));
      } catch (e) { /* webview 上下文错误已通过返回值上报 */ }

      // Mouse 事件序列
      try {
        target.dispatchEvent(new MouseEvent('mouseover', opts));
        target.dispatchEvent(new MouseEvent('mouseenter', opts));
      } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
      interactiveEl.dispatchEvent(new MouseEvent('mousedown', opts));
      interactiveEl.dispatchEvent(new MouseEvent('mouseup', opts));
      interactiveEl.dispatchEvent(new MouseEvent('click', opts));

      // 最后再尝试原生 click() 方法（对 button/a 等原生元素最可靠）
      if (typeof interactiveEl.click === 'function') {
        setTimeout(function() {
          try { interactiveEl.click(); } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
        }, 0);
      }

      return true;
    }

    // 点击当前焦点元素
    function clickCurrent() {
      if (!currentEl) {
        console.log('[spatial-nav] 无当前元素，无法点击');
        return;
      }
      playClickAnim();
      var r = currentEl.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      if (!clickAt(cx, cy)) {
        // fallback：直接点击 currentEl
        try { currentEl.click && currentEl.click(); } catch (e) { /* webview 上下文错误已通过返回值上报 */ }
      }
    }

    // 空间导航核心：方向 + 半平面过滤 + 投影距离
    function navigate(dir) {
      var candidates = getFocusables();
      console.log('[spatial-nav] navigate', dir, '候选元素数:', candidates.length);
      if (!currentEl) { if (candidates.length) highlight(candidates[0]); return; }
      var cr = currentEl.getBoundingClientRect();
      var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      var best = null, bestDist = Infinity;

      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] === currentEl) continue;
        var r = candidates[i].getBoundingClientRect();
        var tx = r.left + r.width / 2, ty = r.top + r.height / 2;
        var dx = tx - cx, dy = ty - cy;

        // 方向半平面过滤
        if (dir === 'up' && dy >= 0) continue;
        if (dir === 'down' && dy <= 0) continue;
        if (dir === 'left' && dx >= 0) continue;
        if (dir === 'right' && dx <= 0) continue;

        // 投影距离（主轴）+ 垂直偏移惩罚（权重 2x）
        var proj = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
        var perp = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
        var dist = proj + perp * 2;
        if (dist < bestDist) { bestDist = dist; best = candidates[i]; }
      }
      if (best) highlight(best);
    }

    // 键盘方向键（仅在导航模式启用时拦截）
    document.addEventListener('keydown', function(e) {
      if (!enabled) return;
      var map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (map[e.key]) { e.preventDefault(); e.stopPropagation(); navigate(map[e.key]); return; }
      if (e.key === 'Enter' && currentEl) {
        e.preventDefault(); e.stopPropagation();
        clickCurrent();
        return;
      }
      if (e.key === 'Escape') { toggleNav(false); }
    }, true);

    // 手柄轮询（60fps，250ms 节流避免摇杆抖动）
    var polling = false;
    var lastNavTime = 0, lastBtnTime = 0;

    function pollGamepad() {
      if (!enabled) { polling = false; return; }
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      var gp = null;
      for (var i = 0; i < pads.length; i++) { if (pads[i]) { gp = pads[i]; break; } }
      if (gp) {
        var now = Date.now();
        var x = gp.axes[0] || 0, y = gp.axes[1] || 0;
        var threshold = 0.5;
        if (now - lastNavTime > 250) {
          if (y < -threshold) { navigate('up'); lastNavTime = now; }
          else if (y > threshold) { navigate('down'); lastNavTime = now; }
          else if (x < -threshold) { navigate('left'); lastNavTime = now; }
          else if (x > threshold) { navigate('right'); lastNavTime = now; }
        }
        // A 按钮（index 0）= 确认/点击
        if (gp.buttons[0] && gp.buttons[0].pressed && now - lastBtnTime > 300) {
          if (currentEl) { clickCurrent(); }
          lastBtnTime = now;
        }
        // B 按钮（index 1）= 退出导航
        if (gp.buttons[1] && gp.buttons[1].pressed && now - lastBtnTime > 300) {
          toggleNav(false);
          lastBtnTime = now;
        }
      }
      requestAnimationFrame(pollGamepad);
    }

    function toggleNav(on) {
      enabled = on;
      console.log('[spatial-nav] toggle', on);
      if (on) {
        createCursor();
        var els = getFocusables();
        console.log('[spatial-nav] 找到可交互元素:', els.length);
        if (els.length) highlight(els[0]);
        if (!polling) { polling = true; pollGamepad(); }
      } else {
        if (currentEl) {
          currentEl.style.outline = prevOutline;
          currentEl.style.boxShadow = prevShadow;
          currentEl = null;
        }
        removeCursor();
      }
    }

    // 手柄连接/断开事件监听（仅注册一次，用于 UX 提示）
    if (!window.__ai_gamepad_listeners__) {
      window.__ai_gamepad_listeners__ = true;
      window.addEventListener('gamepadconnected', function(e) {
        console.log('[SpatialNav] 手柄已连接:', e.gamepad.id);
      });
      window.addEventListener('gamepaddisconnected', function(e) {
        console.log('[SpatialNav] 手柄已断开:', e.gamepad.id);
      });
    }

    window.__ai_spatial_nav__ = {
      toggle: toggleNav,
      isEnabled: function() { return enabled; },
    };
  })();`;
}
