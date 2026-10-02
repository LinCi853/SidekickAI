import { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Button } from '../../components/ui';
import { requireElectron } from '../../lib/electron-api/core';
import { openExternal } from '../../lib/electron-api';
import 'highlight.js/styles/github-dark.css';

function Code({ className, children, onAction }: { className?: string; children?: React.ReactNode; onAction: (operation: () => Promise<void>) => void }) {
  const ref = useRef<HTMLElement>(null);
  const language = className?.match(/language-([\w+-]+)/)?.[1]?.toLowerCase();
  const preview = language === 'html' || language === 'css' ? language : ['js', 'javascript'].includes(language ?? '') ? 'javascript' : undefined;
  return <div className="asset-code"><div className="asset-code-actions"><span>{language ?? '代码'}</span><Button variant="ghost" onClick={() => onAction(() => requireElectron().aiAssets.copyText(ref.current?.textContent ?? ''))}>复制代码</Button>
    {preview && <Button variant="outline" onClick={() => onAction(async () => { const result = await requireElectron().aiAssets.previewCode(ref.current?.textContent ?? '', preview); if (!result.ok) throw new Error(result.error); })}>浏览器预览</Button>}</div><pre><code ref={ref} className={className}>{children}</code></pre></div>;
}
export default function AssetMarkdown({ content, onAction }: { content: string; onAction: (operation: () => Promise<void>) => void }) {
  return <div className="asset-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, node }) => node?.position && (className || String(children).endsWith('\n')) ? <Code className={className} onAction={onAction}>{children}</Code> : <code className={className}>{children}</code>,
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:/i.test(href)) onAction(() => openExternal(href)); }}>{children}</a>,
  }}>{content}</ReactMarkdown></div>;
}
