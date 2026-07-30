/* =====================================================================
   components/PromptEditorForm.tsx —— 提示词编辑器表单（共享组件）
   三方复用：提示词库独立窗口 / 主窗口底栏 / 笔记存为提示词
   包含：标题 / 分类(Chips+input) / 内容 / {{body}}占位符提示 / 局内快捷键
   不包含外壳(overlay/modal/header/footer)，由调用方各自渲染。
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import type { PromptTemplate, HotkeyConfig } from '../lib/electron-api';
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
import '../pages/PromptLibraryView.css';

export interface PromptEditorFormProps {
  title: string;
  content: string;
  category: string;
  hotkey: string;
  /** 当前编辑的模板 id（用于排除自身的热键冲突检测），新增时为 null */
  editingId: string | null;
  onTitleChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onHotkeyChange: (v: string) => void;
  /** data-name 前缀（可选） */
  dataNamePrefix?: string;
}

export default function PromptEditorForm({
  title,
  content,
  category,
  hotkey,
  editingId,
  onTitleChange,
  onContentChange,
  onCategoryChange,
  onHotkeyChange,
  dataNamePrefix = 'prompt-editor',
}: PromptEditorFormProps) {
  const prompts = usePromptStore((s) => s.prompts);
  const [appHotkeys, setAppHotkeys] = useState<HotkeyConfig[]>([]);

  // 加载全局热键列表，用于冲突检测
  useEffect(() => {
    getHotkeys()
      .then(setAppHotkeys)
      .catch((e) => console.warn('[PromptEditorForm] 加载全局热键失败:', e));
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
        <label data-name={dn('title-label')}>标题</label>
        <input
          value={title}
          autoFocus
          spellCheck={false}
          placeholder="如：总结全文"
          data-name={dn('title-input')}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>
      <div className="prompt-field" data-name={dn('field-category')}>
        <label data-name={dn('category-label')}>分类（可选）</label>
        <div className="prompt-category-chips">
          {allCategories.map((cat) => (
            <Chip
              key={cat}
              selected={category === cat}
              onClick={() => onCategoryChange(category === cat ? '' : cat)}
              data-name={dn('category-chip')}
            >
              {cat}
            </Chip>
          ))}
          <input
            value={category}
            spellCheck={false}
            placeholder="新增分类..."
            data-name={dn('category-input')}
            onChange={(e) => onCategoryChange(e.target.value)}
          />
        </div>
      </div>
      <div className="prompt-field" data-name={dn('field-content')}>
        <label data-name={dn('content-label')}>内容</label>
        <textarea
          value={content}
          spellCheck={false}
          placeholder="输入提示词内容，使用 {{body}} 作为当前输入框内容的占位符（点击上方提示可复制）"
          data-name={dn('content-textarea')}
          onChange={(e) => onContentChange(e.target.value)}
        />
      </div>
      <div className="prompt-field-hint" data-name={dn('placeholder-hint')}>
        占位符：
        <code
          style={{ cursor: 'pointer', userSelect: 'all' }}
          onClick={() => navigator.clipboard.writeText('{{body}}')}
          title="点击复制"
          data-name={dn('placeholder-copy')}
        >
          {'{{body}}'}
        </code>
        当前输入框内容（点击复制）
      </div>
      {/* 需求 2.5：局内快捷键录入 */}
      <div className="prompt-field" data-name={dn('field-hotkey')}>
        <label data-name={dn('hotkey-label')}>局内快捷键（可选）</label>
        <HotkeyRecorder
          value={hotkey}
          placeholder="点击录入（如 Ctrl+Shift+1）"
          className="prompt-hotkey-input"
          onRecord={(acc) => onHotkeyChange(acc)}
          otherHotkeys={buildOtherHotkeysForPrompt(appHotkeys, editingId, prompts)}
          startRecording={startHotkeyRecording}
          stopRecording={stopHotkeyRecording}
          onRecordingResult={onHotkeyRecordingResult}
          onRecordingPartial={onHotkeyRecordingPartial}
        />
        <div className="prompt-field-hint" data-name={dn('hotkey-hint')}>
          在主窗口聚焦时按下快捷键即注入该模板；与全局热键冲突的将自动跳过
        </div>
      </div>
    </div>
  );
}
