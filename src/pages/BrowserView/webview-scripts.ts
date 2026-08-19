/* =====================================================================
   pages/BrowserView/webview-scripts.ts —— webview 注入脚本集中管理
   抽取 BrowserWebviewTab.tsx 中所有注入 guest 页面的 JS 字符串，
   并将 3 处重复的 favicon→dataURL canvas 转换脚本去重为共享模板。
   ===================================================================== */

/** 读取页面标题（executeJavaScript 直传脚本） */
export const GET_TITLE_SCRIPT = 'document.title';

/** 空间导航开关脚本：开启手柄/键盘空间导航 */
export const SPATIAL_NAV_ENABLE_SCRIPT =
  'window.__ai_spatial_nav__ && window.__ai_spatial_nav__.toggle(true)';

/** 读取 guest 注入的右键坐标（contextmenu DOM 事件记录的 clientX/clientY） */
export const READ_CONTEXT_COORD_SCRIPT = 'window.__sidekickCtx || null';

/** 本地文件拖放桥：拖文件到页面时，若页面自身没有处理（无上传区），
 * 通过 console-message 上报文件路径（Electron File.path），由宿主打开查看；
 * 页面已处理（preventDefault）则不干预，保留网页上传能力。 */
export const FILE_DROP_BRIDGE_SCRIPT = `
(function() {
  if (window.__sidekickFileDropHook) return;
  window.__sidekickFileDropHook = true;
  document.addEventListener('dragover', function(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types || dt.types.indexOf('Files') < 0) return;
    if (e.defaultPrevented) return; // 页面自己处理上传
    e.preventDefault();
    if (dt.dropEffect) dt.dropEffect = 'copy';
  });
  document.addEventListener('drop', function(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types || dt.types.indexOf('Files') < 0) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    var paths = [];
    for (var i = 0; i < dt.files.length; i++) {
      var f = dt.files[i];
      if (f.path) paths.push(f.path); // Electron File.path（绝对路径）
    }
    if (paths.length > 0) console.log('__SK_FILEDROP__:' + JSON.stringify(paths));
  });
})()
`;

/** 右键坐标记录脚本：guest 的 contextmenu DOM 事件提供精确的 clientX/clientY
 * （viewport CSS 坐标），供右键菜单定位、聚焦输入框、检查元素使用
 * （比 Electron 转发的 params 坐标更可靠）。 */
export const CONTEXT_COORD_HOOK_SCRIPT = `
(function() {
  if (window.__sidekickCtxHook) return;
  window.__sidekickCtxHook = true;
  window.__sidekickCtx = null;
  document.addEventListener('contextmenu', function(e) {
    var editable = null;
    var el = e.target;
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        editable = el;
        break;
      }
      el = el.parentElement;
    }
    window.__sidekickCtx = {
      x: e.clientX,
      y: e.clientY,
      isEditable: !!editable,
    };
  }, true);
})()
`;

/**
 * 共享 canvas→dataURL 转码体（3 处 favicon 转换脚本去重后的公共部分）：
 * 在 guest 页面内用 Image + canvas 将图片转成 PNG data URL，规避跨域/协议限制。
 * @param imgSrcExpr 计算 img.src 的 JS 表达式
 * @param canvasErrorValue canvas 转码失败时 resolve 的 JS 值（如 "''" 或 'href'）
 */
function canvasToDataUrlBody(imgSrcExpr: string, canvasErrorValue: string): string {
  return `
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || 32;
            canvas.height = img.naturalHeight || 32;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
          } catch(e) { resolve(${canvasErrorValue}); }
        };
        img.onerror = function() { resolve(''); };
        img.src = ${imgSrcExpr};`;
}

/** 从 <link rel="icon"> 发现 favicon 并转 data URL（dom-ready / did-stop-loading 兜底） */
export function buildFaviconToDataUrlScript(): string {
  return `(function() {
          return new Promise(function(resolve) {
            var links = document.querySelectorAll('link[rel*="icon"]');
            var href = '';
            for (var i = 0; i < links.length; i++) {
              href = links[i].getAttribute('href');
              if (href) break;
            }
            if (!href) { resolve(''); return; }
            try { href = new URL(href, document.baseURI).href; } catch(e) {}
${canvasToDataUrlBody('href', 'href')}
          });
        })()`;
}

/** 将指定图片 URL 转 data URL（page-favicon-updated 事件：img.src 直接指向已知 URL） */
export function buildImageUrlToDataUrlScript(imgSrcExpr: string): string {
  return `(function() {
          return new Promise(function(resolve) {
${canvasToDataUrlBody(imgSrcExpr, "''")}
          });
        })()`;
}

/** 复制图片脚本：把真实图片写入剪贴板前，先在 guest 内转成 data URL
 * （跨域/加载失败时回退复制图片地址） */
export function buildCopyImageToDataUrlScript(imageUrlJson: string): string {
  return `(function(url) {
          return new Promise(function(resolve) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function() {
              try {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png'));
              } catch (e) { resolve(''); }
            };
            img.onerror = function() { resolve(''); };
            img.src = url;
          });
        })(${imageUrlJson})`;
}

/** 聚焦 guest 页面内右键位置的输入元素（elementFromPoint + 祖先回溯） */
export function buildFocusEditableAtScript(x: number, y: number): string {
  return `(function() {
          var el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
          while (el && el !== document.body && el !== document.documentElement) {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
              el.focus();
              return true;
            }
            el = el.parentElement;
          }
          return false;
        })()`;
}

/** 输入框编辑命令脚本（撤销/重做/剪切/复制/全选） */
export function buildExecCommandScript(cmd: string): string {
  return `document.execCommand("${cmd}")`;
}
