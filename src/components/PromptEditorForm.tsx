import { useEffect, useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import type { PromptExample, HotkeyConfig } from '../lib/electron-api';
import { usePromptStore } from '../store/usePromptStore';
import {
  getHotkeys,
  startHotkeyRecording,
  stopHotkeyRecording,
  onHotkeyRecordingResult,
  onHotkeyRecordingPartial,
} from '../lib/electron-api';
import { buildOtherHotkeysForPrompt } from '../lib/prompt-hotkey';
import Chip from './ui/Chip';
import HotkeyRecorder from './ui/HotkeyRecorder';
import IconButton from './ui/IconButton';
import '../pages/PromptLibraryView.css';

export interface PromptEditorFormProps {
  title: string;
  content: string;
  category: string;
  hotkey: string;
  example?: PromptExample;
  editingId: string | null;
  onTitleChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onHotkeyChange: (v: string) => void;
  onExampleContentChange?: (v: string) => void;
  sourceAvailable?: boolean;
  disabled?: boolean;
  dataNamePrefix?: string;
}

export default function PromptEditorForm({
  title,
  content,
  category,
  hotkey,
  example,
  editingId,
  onTitleChange,
  onContentChange,
  onCategoryChange,
  onHotkeyChange,
  onExampleContentChange,
  sourceAvailable = false,
  disabled = false,
  dataNamePrefix = 'prompt-editor',
}: PromptEditorFormProps) {
  const prompts = usePromptStore((s) => s.prompts);
  const [appHotkeys, setAppHotkeys] = useState<HotkeyConfig[]>([]);

  useEffect(() => {
    getHotkeys()
      .then(setAppHotkeys)
      .catch((error) => console.warn('[PromptEditorForm] Failed to load global shortcuts:', error));
  }, []);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    prompts.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set);
  }, [prompts]);

  const dn = (suffix: string) => `${dataNamePrefix}.${suffix}`;

  return (
    <div className="prompt-editor-body" data-name={dn('body')}>
      <div className="prompt-field" data-name={dn('field-title')}>
        <label htmlFor={dn('title-input')} data-name={dn('title-label')}>标题</label>
        <input
          id={dn('title-input')}
          disabled={disabled}
          value={title}
          autoFocus
          spellCheck={false}
          placeholder="如：总结全文"
          data-name={dn('title-input')}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>
      <div className="prompt-field" data-name={dn('field-category')}>
        <label htmlFor={dn('category-input')} data-name={dn('category-label')}>分类（可选）</label>
        <div className="prompt-category-chips">
          {allCategories.map((cat) => (
            <Chip
              key={cat}
              selected={category === cat}
              disabled={disabled}
              onClick={() => onCategoryChange(category === cat ? '' : cat)}
              data-name={dn('category-chip')}
            >
              {cat}
            </Chip>
          ))}
          <input
            id={dn('category-input')}
            disabled={disabled}
            value={category}
            spellCheck={false}
            placeholder="新增分类..."
            data-name={dn('category-input')}
            onChange={(e) => onCategoryChange(e.target.value)}
          />
        </div>
      </div>
      <div className="prompt-field" data-name={dn('field-content')}>
        <label htmlFor={dn('content-textarea')} data-name={dn('content-label')}>{onExampleContentChange ? '通用提示词（可选）' : '通用提示词'}</label>
        <textarea
          id={dn('content-textarea')}
          disabled={disabled}
          value={content}
          spellCheck={false}
          placeholder="输入通用提示词"
          data-name={dn('content-textarea')}
          onChange={(e) => onContentChange(e.target.value)}
        />
        <div className="prompt-placeholder-action"><code>{'{{body}}'}</code><IconButton type="button" aria-label="复制当前输入框占位符" title="复制当前输入框占位符" disabled={disabled} onClick={() => void navigator.clipboard.writeText('{{body}}')} data-name={dn('placeholder-copy')}><Copy size={14} /></IconButton></div>
      </div>
      {onExampleContentChange && <div className="prompt-field" data-name={dn('field-example')}>
        <label htmlFor={dn('example-textarea')}>案例（可选）</label>
        <textarea id={dn('example-textarea')} disabled={disabled} value={example?.content ?? ''} spellCheck={false} placeholder="案例文本" data-name={dn('example-textarea')} onChange={event => onExampleContentChange(event.target.value)} />
        {example?.conversationId && <div className="prompt-example-source" data-name={dn('example-source')}>
          <span>{sourceAvailable ? (example.messageId ? '已关联原对话及消息' : '已关联原对话') : '原对话不可用'}</span>
        </div>}
      </div>}
      <div className="prompt-field" data-name={dn('field-hotkey')}>
        <label data-name={dn('hotkey-label')}>局内快捷键（可选）</label>
        <HotkeyRecorder
          value={hotkey}
          disabled={disabled}
          placeholder="点击录入（如 Ctrl+Shift+1）"
          className="prompt-hotkey-input"
          onRecord={(acc) => onHotkeyChange(acc)}
          otherHotkeys={buildOtherHotkeysForPrompt(appHotkeys, editingId, prompts)}
          startRecording={startHotkeyRecording}
          stopRecording={stopHotkeyRecording}
          onRecordingResult={onHotkeyRecordingResult}
          onRecordingPartial={onHotkeyRecordingPartial}
        />
      </div>
    </div>
  );
}
