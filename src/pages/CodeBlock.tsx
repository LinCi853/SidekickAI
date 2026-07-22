import { useCallback, useRef, useState } from 'react';
import { Button } from '../components/ui';

/** 复制代码块到剪贴板 */
async function copyCode(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.error('[ChatView] 复制失败:', e);
  }
}

/** 代码块组件：含语法高亮 + 复制按钮 */
export function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement | null>(null);

  const handleCopy = useCallback(async () => {
    const text = codeRef.current?.textContent ?? '';
    await copyCode(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="md-code-block" data-name="chat.code-block.container">
      <Button
        type="button"
        variant="text"
        data-name="chat.code-block.copy-button"
        className={`md-code-copy${copied ? ' copied' : ''}`}
        onClick={handleCopy}
        title="复制代码"
      >
        {copied ? '已复制' : '复制'}
      </Button>
      <pre data-name="chat.code-block.pre">
        <code ref={codeRef} className={className} data-name="chat.code-block.code">
          {children}
        </code>
      </pre>
    </div>
  );
}

export default CodeBlock;
