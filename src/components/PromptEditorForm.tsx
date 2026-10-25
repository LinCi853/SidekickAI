import { useEffect, useMemo, useState } from 'react'
import { Copy, FlipHorizontal2 } from 'lucide-react'
import type { PromptExample, HotkeyConfig } from '../lib/electron-api'
import { usePromptStore } from '../store/usePromptStore'
import {
  getHotkeys,
  startHotkeyRecording,
  stopHotkeyRecording,
  onHotkeyRecordingResult,
  onHotkeyRecordingPartial,
} from '../lib/electron-api'
import { buildOtherHotkeysForPrompt } from '../lib/prompt-hotkey'
import HotkeyRecorder from './ui/HotkeyRecorder'
import IconButton from './ui/IconButton'
import '../pages/PromptLibraryView.css'

/** 编辑器内容面：通用提示词 / 案例（翻面切换，数据模型不变） */
export type PromptEditorFace = 'general' | 'example'

export interface PromptEditorFormProps {
  title: string
  content: string
  category: string
  hotkey: string
  example?: PromptExample
  editingId: string | null
  /** 当前内容面 */
  activeFace: PromptEditorFace
  onTitleChange: (v: string) => void
  onContentChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onHotkeyChange: (v: string) => void
  onExampleContentChange?: (v: string) => void
  /** 翻面切换回调 */
  onFaceChange: (face: PromptEditorFace) => void
  sourceAvailable?: boolean
  disabled?: boolean
  dataNamePrefix?: string
}

export default function PromptEditorForm({
  title,
  content,
  category,
  hotkey,
  example,
  editingId,
  activeFace,
  onTitleChange,
  onContentChange,
  onCategoryChange,
  onHotkeyChange,
  onExampleContentChange,
  onFaceChange,
  sourceAvailable = false,
  disabled = false,
  dataNamePrefix = 'prompt-editor',
}: PromptEditorFormProps) {
  const prompts = usePromptStore((s) => s.prompts)
  const [appHotkeys, setAppHotkeys] = useState<HotkeyConfig[]>([])

  useEffect(() => {
    getHotkeys()
      .then(setAppHotkeys)
      .catch((error) => console.warn('[PromptEditorForm] Failed to load global shortcuts:', error))
  }, [])

  const allCategories = useMemo(() => {
    const set = new Set<string>()
    prompts.forEach((p) => {
      if (p.category) set.add(p.category)
    })
    return Array.from(set)
  }, [prompts])

  const hasExampleFace = !!onExampleContentChange
  const face: PromptEditorFace = hasExampleFace && activeFace === 'example' ? 'example' : 'general'
  const dn = (suffix: string) => `${dataNamePrefix}.${suffix}`

  return (
    <div className="prompt-editor-body" data-name={dn('body')}>
      {/* 标题 + 分类一行；分类是单控件：输入即新建，下拉建议点选即填 */}
      <div className="prompt-editor-row" data-name={dn('row-meta')}>
        <div className="prompt-field" data-name={dn('field-title')}>
          <label htmlFor={dn('title-input')} data-name={dn('title-label')}>
            标题
          </label>
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
          <label htmlFor={dn('category-input')} data-name={dn('category-label')}>
            分类（可选）
          </label>
          <input
            id={dn('category-input')}
            disabled={disabled}
            value={category}
            spellCheck={false}
            placeholder="输入新分类或点选建议"
            list={dn('category-options')}
            data-name={dn('category-input')}
            onChange={(e) => onCategoryChange(e.target.value)}
          />
          <datalist id={dn('category-options')}>
            {allCategories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
          </datalist>
        </div>
      </div>
      {/* 内容区主体：通用/案例共用一个 textarea，翻面切换 */}
      <div className="prompt-field prompt-face-field" data-name={dn('field-content')}>
        <div className="prompt-face-header">
          <label htmlFor={dn('content-textarea')} data-name={dn('content-label')}>
            {face === 'general'
              ? hasExampleFace
                ? '通用提示词（可选）'
                : '通用提示词'
              : '案例（可选）'}
          </label>
          {hasExampleFace && (
            <button
              type="button"
              className="prompt-face-toggle"
              disabled={disabled}
              aria-label={face === 'general' ? '切到案例' : '切到通用'}
              title={face === 'general' ? '切到案例' : '切到通用'}
              onClick={() => onFaceChange(face === 'general' ? 'example' : 'general')}
              data-name={dn('face-toggle')}
            >
              <FlipHorizontal2 size={14} aria-hidden="true" />
              {face === 'general' ? '切到案例' : '切到通用'}
            </button>
          )}
        </div>
        <textarea
          id={dn('content-textarea')}
          disabled={disabled}
          value={face === 'general' ? content : (example?.content ?? '')}
          spellCheck={false}
          placeholder={face === 'general' ? '输入通用提示词' : '案例文本'}
          data-name={face === 'general' ? dn('content-textarea') : dn('example-textarea')}
          onChange={(e) =>
            face === 'general'
              ? onContentChange(e.target.value)
              : onExampleContentChange?.(e.target.value)
          }
        />
        {face === 'general' && (
          <div className="prompt-placeholder-action">
            <code>{'{{body}}'}</code>
            <IconButton
              type="button"
              aria-label="复制当前输入框占位符"
              title="复制当前输入框占位符"
              disabled={disabled}
              onClick={() => void navigator.clipboard.writeText('{{body}}')}
              data-name={dn('placeholder-copy')}
            >
              <Copy size={14} />
            </IconButton>
          </div>
        )}
        {face === 'example' && example?.conversationId && (
          <div className="prompt-example-source" data-name={dn('example-source')}>
            <span>
              {sourceAvailable
                ? example.messageId
                  ? '已关联原对话及消息'
                  : '已关联原对话'
                : '原对话不可用'}
            </span>
          </div>
        )}
      </div>
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
  )
}
