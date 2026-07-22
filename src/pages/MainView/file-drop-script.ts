/* =====================================================================
   file-drop-script.ts —— 生成在 webview guest 内执行的文件派发脚本
   =====================================================================
   父渲染层收集到拖拽文件路径后，经 IPC 由主进程读取字节并以 data URL 返回。
   本模块把 data URL 数组序列化为一段 IIFE 脚本，注入到当前激活 webview 的 guest：
     1. 把每个 dataUrl 转 File 对象（fetch + blob + new File）
     2. 找页面上的文件上传 input（优先用平台自定义 fileInputSelector，否则 input[type=file]）
     3. 若找到：通过 DataTransfer 设置 input.files，派发 change + input 事件
     4. 若未找到或失败：构造 DragEvent('drop')，派发到候选拖放区（含平台自定义 dropZoneSelector）
     5. 若仍失败：构造 ClipboardEvent('paste')，派发到 textarea/contenteditable（智谱/豆包/Kimi 等支持粘贴图片）
     6. 通过 window.postMessage 反馈结果（成功/失败）给宿主

   兼容性：三层兜底覆盖大多数 AI 平台的文件导入机制。
   */

export interface DroppedFileInfo {
  filename: string;
  dataUrl: string;
  mime: string;
  size: number;
}

/** 平台特定的文件派发选项（从 AIPlatform 配置传入） */
export interface FileDropOptions {
  /** 文件上传 input 的 CSS 选择器（优先于通用 input[type=file]） */
  fileInputSelector?: string;
  /** 拖放区 CSS 选择器（追加到启发式候选集） */
  dropZoneSelector?: string;
}

/**
 * 生成在 guest 内执行的文件派发脚本。
 * @param files 文件信息数组（来自主进程的 data URL）
 * @param options 平台特定选择器（可选）
 * @returns 可直接传给 webview.executeJavaScript 的脚本字符串
 */
export function buildFileDropScript(files: DroppedFileInfo[], options?: FileDropOptions): string {
  // 序列化参数为 JSON 注入脚本，避免字符串拼接转义问题
  const payload = JSON.stringify(files);
  const fileInputSelector = options?.fileInputSelector ?? '';
  const dropZoneSelector = options?.dropZoneSelector ?? '';
  return `
(function(filesPayload, fileInputSelector, dropZoneSelector) {
  // 1. dataUrl → File 对象
  async function dataUrlToFile(d) {
    try {
      var r = await fetch(d.dataUrl);
      var b = await r.blob();
      return new File([b], d.filename, { type: d.mime || b.type || 'application/octet-stream' });
    } catch (e) {
      console.error('[FileDrop] 转换文件失败:', d.filename, e);
      return null;
    }
  }

  // 2. 找页面上的文件输入（优先用平台自定义选择器，不要求可见——智谱等 input 可能隐藏）
  function findFileInput() {
    var selector = fileInputSelector || 'input[type=file]';
    var inputs = document.querySelectorAll(selector);
    if (inputs.length === 0) {
      // 自定义选择器没找到，回退到通用 input[type=file]
      if (fileInputSelector) {
        inputs = document.querySelectorAll('input[type=file]');
      }
      if (inputs.length === 0) return null;
    }
    if (inputs.length === 1) return inputs[0];
    // 多个时优先选可见的
    for (var i = 0; i < inputs.length; i++) {
      var r = inputs[i].getBoundingClientRect();
      var s = window.getComputedStyle(inputs[i]);
      if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
        return inputs[i];
      }
    }
    return inputs[0];
  }

  // 3. 通过 input[type=file] 派发
  function dispatchOnInput(input, fileObjs) {
    try {
      var dt = new DataTransfer();
      for (var i = 0; i < fileObjs.length; i++) dt.items.add(fileObjs[i]);
      input.files = dt.files;
    } catch (e) {
      console.warn('[FileDrop] 设置 input.files 失败:', e);
      return false;
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // 4. 通过合成 drop 事件派发到候选拖放区
  function dispatchDropOnDropZones(fileObjs) {
    var dt = new DataTransfer();
    for (var i = 0; i < fileObjs.length; i++) dt.items.add(fileObjs[i]);
    var ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    // 候选集：平台自定义 + 启发式英文关键字 + 通用输入区
    var selectorParts = [
      '[class*="drop" i], [class*="upload" i], [class*="attach" i]',
      '[data-testid*="drop" i], [data-testid*="upload" i]',
      'form, [contenteditable="true"], textarea'
    ];
    if (dropZoneSelector) selectorParts.unshift(dropZoneSelector);
    var candidates = document.querySelectorAll(selectorParts.join(', '));
    var dispatched = 0;
    for (var j = 0; j < candidates.length; j++) {
      try {
        candidates[j].dispatchEvent(ev);
        dispatched++;
      } catch (e) { /* ignore */ }
    }
    // 兜底：派发到 document.body（部分平台在 document 级监听）
    try { document.body.dispatchEvent(ev); } catch (e) { /* ignore */ }
    return dispatched > 0;
  }

  // 5. 通过合成 paste 事件派发到输入区（智谱/豆包/Kimi 等支持粘贴图片）
  function dispatchPasteOnInputs(fileObjs) {
    var dt = new DataTransfer();
    for (var i = 0; i < fileObjs.length; i++) dt.items.add(fileObjs[i]);
    var ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    var targets = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]');
    var dispatched = 0;
    for (var j = 0; j < targets.length; j++) {
      try {
        targets[j].focus();
        targets[j].dispatchEvent(ev);
        dispatched++;
      } catch (e) { /* ignore */ }
    }
    // 兜底：document 级
    try { document.dispatchEvent(ev); } catch (e) { /* ignore */ }
    return dispatched > 0;
  }

  // 6. 主流程：三层兜底
  Promise.all(filesPayload.map(dataUrlToFile)).then(function(fileObjs) {
    var valid = fileObjs.filter(function(f) { return f !== null; });
    if (valid.length === 0) {
      console.error('[FileDrop] 无有效文件');
      window.postMessage({ type: 'ai-file-drop-result', success: false, error: 'no-valid-files' }, '*');
      return;
    }

    // 第一层：input[type=file]
    var input = findFileInput();
    if (input) {
      var ok = dispatchOnInput(input, valid);
      console.log('[FileDrop] 通过 input[type=file] 派发', valid.length, '个文件，成功:', ok);
      if (ok) {
        window.postMessage({ type: 'ai-file-drop-result', success: true, method: 'input' }, '*');
        return;
      }
    }

    // 第二层：合成 drop 事件
    var ok2 = dispatchDropOnDropZones(valid);
    console.log('[FileDrop] 派发 drop 事件到候选区域，成功:', ok2);
    if (ok2) {
      window.postMessage({ type: 'ai-file-drop-result', success: true, method: 'drop' }, '*');
      return;
    }

    // 第三层：合成 paste 事件（智谱/豆包/Kimi 等支持粘贴图片的兜底）
    var ok3 = dispatchPasteOnInputs(valid);
    console.log('[FileDrop] 派发 paste 事件到输入区，成功:', ok3);
    if (ok3) {
      window.postMessage({ type: 'ai-file-drop-result', success: true, method: 'paste' }, '*');
      return;
    }

    console.warn('[FileDrop] 所有派发方式均未成功');
    window.postMessage({ type: 'ai-file-drop-result', success: false, error: 'no-target-found' }, '*');
  }).catch(function(e) {
    console.error('[FileDrop] 主流程失败:', e);
    window.postMessage({ type: 'ai-file-drop-result', success: false, error: String(e) }, '*');
  });
})(${payload}, ${JSON.stringify(fileInputSelector)}, ${JSON.stringify(dropZoneSelector)});
  `.trim();
}
