/* =====================================================================
   pages/BrowserView/PrintPreviewTab.tsx —— 打印预览标签页
   打印菜单 / Ctrl+P 时生成当前页面的 PDF 临时文件，在本页用 Chromium
   内置 PDF 查看器预览（iframe 加载 file:// PDF，宿主渲染进程默认 session
   注册了 PDF viewer，比自定义 partition 的 webview 更可靠）。
   PDF 查看器自带打印 / 保存 / 缩放工具栏；顶部提供「另存为 PDF」
   与「在浏览器打开」。临时文件不做自动清理（避免 React StrictMode
   双挂载误删），仅在「另存为 PDF」成功复制后清理。
   ===================================================================== */

import { useCallback, useState } from 'react';
import type { BrowserTabState } from '../../lib/electron-api';
import { savePdfAs, deleteTempPdf, openExternal } from '../../lib/electron-api';

interface PrintPreviewTabProps {
  tab: BrowserTabState;
}

/** 解析 sidekickai://print-preview?file=...&title=...&sourceUrl=... 参数 */
function parseParams(tabUrl: string): { file: string; title: string; sourceUrl: string } {
  try {
    const u = new URL(tabUrl);
    return {
      file: u.searchParams.get('file') || '',
      title: u.searchParams.get('title') || '页面',
      sourceUrl: u.searchParams.get('sourceUrl') || '',
    };
  } catch {
    return { file: '', title: '页面', sourceUrl: '' };
  }
}

/** 临时 PDF 绝对路径 → sidekick-pdf:// 协议 URL（主进程自定义协议服务，
 *  规避 dev 模式 http 页面 iframe 加载 file:// 被 webSecurity 阻止的问题） */
function toPdfUrl(filePath: string): string {
  if (!filePath) return '';
  return `sidekick-pdf://preview/${encodeURIComponent(filePath)}`;
}

export default function PrintPreviewTab({ tab }: PrintPreviewTabProps) {
  const { file, title, sourceUrl } = parseParams(tab.url);
  const fileUrl = toPdfUrl(file);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSavePdfAs = useCallback(() => {
    if (!file) return;
    void savePdfAs(file, title).then((res) => {
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        // 已复制到用户指定路径，临时文件可安全清理
        void deleteTempPdf(file);
      }
    }).catch(() => { /* ignore */ });
  }, [file, title]);

  const handleOpenExternal = useCallback(() => {
    if (sourceUrl) void openExternal(sourceUrl);
  }, [sourceUrl]);

  return (
    <div className="print-preview-tab" data-name="browser.print-preview-tab">
      <div className="print-preview-header" data-name="browser.print-preview-header">
        <span className="print-preview-title" title={sourceUrl} data-name="browser.print-preview-title">
          打印预览：{title}
        </span>
        <div className="print-preview-actions" data-name="browser.print-preview-actions">
          <button type="button" className="print-preview-btn" onClick={handleSavePdfAs} data-name="browser.print-preview-save-pdf">
            {saved ? '已保存' : '另存为 PDF'}
          </button>
          <button type="button" className="print-preview-btn" onClick={handleOpenExternal} data-name="browser.print-preview-open-external">
            在浏览器打开
          </button>
        </div>
      </div>
      {fileUrl ? (
        <>
          <iframe
            src={fileUrl}
            title="打印预览"
            className="print-preview-frame"
            data-name="browser.print-preview-frame"
            onLoad={() => setLoadFailed(false)}
            onError={() => setLoadFailed(true)}
            style={{ flex: 1, width: '100%', border: 'none' }}
          />
          {loadFailed && (
            <div className="print-preview-error" data-name="browser.print-preview-error">
              预览加载失败，请使用「另存为 PDF」保存后查看，或在浏览器中打开原页面打印。
            </div>
          )}
        </>
      ) : (
        <div className="print-preview-error" data-name="browser.print-preview-error">
          打印预览生成失败，请重试。
        </div>
      )}
    </div>
  );
}
