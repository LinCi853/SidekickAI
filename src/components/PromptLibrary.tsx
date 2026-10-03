import { useEffect, useRef, useState } from 'react';
import type { PromptTemplate } from '../lib/electron-api';
import { openPromptWindow } from '../lib/electron-api';
import { usePromptStore } from '../store/usePromptStore';
import { useTabStore } from '../store/useTabStore';
import Button from './ui/Button';
import './PromptLibrary.css';
import { hasUsablePromptContent } from '../../electron/shared/prompt-template';

export interface PromptLibraryProps {
  onInject?: (template: PromptTemplate) => Promise<{ success: boolean; platformName?: string }>;
}

export default function PromptLibrary({ onInject }: PromptLibraryProps) {
  const prompts = usePromptStore(state => state.prompts);
  const [injectedId, setInjectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const inject = async (template: PromptTemplate) => {
    if (!hasUsablePromptContent(template)) { setNotice('请先编写通用提示词'); return; }
    try {
      if (!onInject) { setNotice('暂无可用的注入目标'); return; }
      const result = await onInject(template);
      if (!result.success) { setNotice('未找到输入框，请确认页面已加载'); return; }
      setInjectedId(template.id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setInjectedId(null), 800);
      setNotice(result.platformName ? `已注入到 ${result.platformName}` : '已注入');
      useTabStore.getState().setBottomBarExpanded(false);
    } catch (error) { setNotice(String(error)); }
  };
  return <div className="prompt-section" data-name="component.prompt-library.section">
    <div className="bottom-section-title">提示词快捷调用</div>
    <div className="prompt-chip-row" data-name="component.prompt-library.chip-list">
      {!prompts.length && <span className="prompt-empty">暂无模板，可在 AI资产中添加</span>}
      {prompts.map((template, index) => <button key={template.id} type="button"
        className={`prompt-chip${injectedId === template.id ? ' injected' : ''}`}
        title={hasUsablePromptContent(template) ? template.content : '待编写通用提示词'} disabled={!hasUsablePromptContent(template)} data-name={`component.prompt-library.chip-${index + 1}`}
        onClick={() => void inject(template)}><span className="prompt-chip-title">{template.title}</span></button>)}
      <Button variant="outline" data-name="component.prompt-library.manage-button"
        onClick={() => void openPromptWindow({ category: 'prompts' }).catch(error => setNotice(String(error)))}>管理提示词</Button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
