import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Expand, FolderOpen, RotateCw, Scan, X, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton, Modal } from '../../components/ui';
import type { AssetAttachment, AssetAttachmentPreview } from '../../../electron/shared/ai-assets.types';
import { requireElectron } from '../../lib/electron-api/core';
import './AssetFilePreview.css';

export default function AssetFilePreview({ item, onClose, onAction }: {
  item: AssetAttachment; onClose: () => void; onAction: (operation: () => Promise<void>) => void;
}) {
  const api = requireElectron().aiAssets;
  const [preview, setPreview] = useState<AssetAttachmentPreview>();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const content = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(true);
  useEffect(() => {
    let active = true, objectUrl = '';
    setPreview(undefined); setUrl(''); setError(''); setZoom('fit'); setDimensions({ width: 0, height: 0 });
    void api.previewAttachment(item.id).then(value => {
      if (!active) return;
      if (value.ok && value.kind !== 'text') {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(value.bytes)], { type: value.mimeType }));
        setUrl(objectUrl);
      }
      setPreview(value);
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, item.id, item.sha256, revision]);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = zoom === 'fit' ? dimensions.width && viewport.width ? Math.min(1, Math.max(0.01, (viewport.width - 24) / dimensions.width), Math.max(0.01, (viewport.height - 24) / dimensions.height)) : 1 : zoom;
  const image = preview?.ok && preview.kind === 'image';
  return <Modal open onClose={onClose} title={item.name} closeIcon={<X size={16} />} portal className="asset-file-preview">
    <div className="asset-preview-toolbar">
      <span title={item.mimeType}>{item.mimeType}{item.size === undefined ? '' : ` · ${(item.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`}</span>
      {image && <>
        <IconButton aria-label="缩小图片" disabled={scale <= 0.1} onClick={() => setZoom(Math.max(0.1, scale - 0.25))}><ZoomOut size={16} /></IconButton>
        <output>{Math.round(scale * 100)}%</output>
        <IconButton aria-label="放大图片" disabled={scale >= 4} onClick={() => setZoom(Math.min(4, scale + 0.25))}><ZoomIn size={16} /></IconButton>
        <IconButton aria-label="适合窗口" onClick={() => setZoom('fit')}><Expand size={16} /></IconButton>
        <IconButton aria-label="原始大小" onClick={() => setZoom(1)}><Scan size={16} /></IconButton>
      </>}
      {preview?.ok && preview.kind === 'text' && <>
        <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />自动换行</label>
        <IconButton aria-label="复制文本" onClick={() => onAction(() => api.copyText(preview.text))}><Copy size={16} /></IconButton>
      </>}
      <IconButton aria-label="重新加载预览" onClick={() => setRevision(value => value + 1)}><RotateCw size={16} /></IconButton>
      <IconButton aria-label="导出原件" onClick={() => onAction(async () => { const result = await api.exportAttachment(item.id); if (!result.ok && !result.canceled) throw new Error(result.error); })}><Download size={16} /></IconButton>
      <IconButton aria-label="在文件夹中查看副本" onClick={() => onAction(async () => { const result = await api.openAttachment(item.id); if (!result.ok) throw new Error(result.error); })}><FolderOpen size={16} /></IconButton>
    </div>
    <div className="asset-preview-content" ref={content}>
      {error || (preview && !preview.ok) ? <p role="alert">{error || (preview && !preview.ok ? preview.error : '')}</p>
        : !preview ? <p role="status">正在读取…</p>
        : preview.ok && preview.kind === 'text' ? <pre className={wrap ? 'is-wrapped' : ''}>{preview.text}</pre>
        : preview.ok && preview.kind === 'image' ? <div className="asset-preview-image"><img src={url} alt={item.name} style={dimensions.width ? { width: dimensions.width * scale, height: dimensions.height * scale } : undefined}
          onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setError('图片无法解码，请导出原件或在文件夹中查看副本')} /></div>
        : <iframe src={`${url}#view=FitH&navpanes=0&pagemode=none`} title={`PDF 预览：${item.name}`} />}
    </div>
    {preview?.ok && preview.kind === 'text' && preview.truncated && <p className="asset-preview-notice" role="status">仅显示前 1 MB，请导出查看完整内容</p>}
  </Modal>;
}
