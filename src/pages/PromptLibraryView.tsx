import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Download, Edit3, ExternalLink, FlipHorizontal2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { hasUsablePromptContent } from '../../electron/shared/prompt-template';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { usePromptStore } from '../store/usePromptStore';
import { requestPromptInject, onPromptInjectResult, exportPrompts, importPrompts } from '../lib/electron-api';
import type { PromptExample, PromptTemplate } from '../lib/electron-api';
import { useToast } from '../hooks/useToast';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import { Button, IconButton, EmptyState, ConfirmDialog } from '../components/ui';
import PromptEditorForm from '../components/PromptEditorForm';
import './PromptLibraryView.css';

export interface PromptLibraryViewProps {
  embedded?: boolean;
  query?: string;
  draft?: { revision: number; example: PromptExample; title?: string };
  onDraftConsumed?: (revision: number) => void;
  onOpenSource?: (example: PromptExample) => void;
  sourceConversationIds?: readonly string[];
}

interface EditorState {
  open: boolean;
  editing: PromptTemplate | null;
  title: string;
  content: string;
  category: string;
  hotkey: string;
  example?: PromptExample;
}

const EMPTY_EDITOR: EditorState = { open: false, editing: null, title: '', content: '', category: '', hotkey: '' };
const hasExample = (template: PromptTemplate) => !!template.example?.content.trim();
const isDual = (template: PromptTemplate) => hasUsablePromptContent(template) && hasExample(template);

export default function PromptLibraryView({ embedded = false, query = '', draft, onDraftConsumed, onOpenSource, sourceConversationIds }: PromptLibraryViewProps = {}) {
  const storedPrompts = usePromptStore((s) => s.prompts);
  const search = query.trim().toLowerCase();
  const prompts = storedPrompts.filter(prompt => !search || `${prompt.title} ${prompt.content} ${prompt.example?.content ?? ''} ${prompt.category ?? ''}`.toLowerCase().includes(search));
  const init = usePromptStore((s) => s.init);
  const savePrompt = usePromptStore((s) => s.save);
  const removePrompt = usePromptStore((s) => s.remove);
  const storeLoadFailed = usePromptStore((s) => s.loadError);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [exampleFaces, setExampleFaces] = useState<Map<string, boolean>>(() => new Map());
  const [injectedId, setInjectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const injectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRevision = useRef<number | undefined>();
  const { toast, showToast } = useToast();
  const closeEditor = useCallback(() => {
    if (saving) return;
    setEditor(EMPTY_EDITOR);
    setDeleteOpen(false);
    queueMicrotask(() => returnFocus.current?.focus());
  }, [saving]);
  useEscToCloseOverlay(editor.open && !deleteOpen && !saving, closeEditor);

  const loadPrompts = useCallback(async () => {
    setLoadFailed(false);
    try { await init(); }
    catch (error) { console.error('[PromptLibraryView] Failed to load templates:', error); setLoadFailed(true); }
  }, [init]);
  useEffect(() => { void loadPrompts(); }, [loadPrompts]);
  useEffect(() => () => { if (injectTimer.current) clearTimeout(injectTimer.current); }, []);
  useEffect(() => {
    if (!draft || draftRevision.current === draft.revision) return;
    draftRevision.current = draft.revision;
    setEditor({ ...EMPTY_EDITOR, open: true, title: draft.title ?? '', example: { ...draft.example } });
    onDraftConsumed?.(draft.revision);
  }, [draft, onDraftConsumed]);
  useEffect(() => onPromptInjectResult(result => {
    showToast(result.success ? (result.platformName ? `已注入到 ${result.platformName}` : '已注入') : '未找到输入框，请确认主窗口页面已加载');
  }), [showToast]);

  const sourceAvailable = (example?: PromptExample) => !!example?.conversationId && !!onOpenSource &&
    (sourceConversationIds === undefined || sourceConversationIds.includes(example.conversationId));
  const handleInject = async (template: PromptTemplate) => {
    if (!hasUsablePromptContent(template)) { showToast('请先编写通用提示词'); return; }
    try {
      await requestPromptInject(template);
      setInjectedId(template.id);
      if (injectTimer.current) clearTimeout(injectTimer.current);
      injectTimer.current = setTimeout(() => setInjectedId(null), 800);
    } catch (error) { console.error('[PromptLibraryView] Injection failed:', error); showToast('注入请求失败'); }
  };
  const openEditor = (template?: PromptTemplate, target?: HTMLElement) => {
    returnFocus.current = target ?? (typeof document !== 'undefined' ? document.activeElement as HTMLElement : null);
    setEditor(template ? {
      open: true, editing: template, title: template.title, content: template.content,
      category: template.category ?? '', hotkey: template.hotkey ?? '', example: template.example ? { ...template.example } : undefined,
    } : { ...EMPTY_EDITOR, open: true });
  };
  const handleSave = async () => {
    if (saving) return;
    const title = editor.title.trim();
    if (!title) { showToast('请输入标题'); return; }
    if (!editor.content.trim() && !editor.example?.content.trim()) { showToast('请填写通用提示词或案例'); return; }
    setSaving(true);
    try {
      const now = Date.now();
      await savePrompt({ ...editor.editing, id: editor.editing?.id ?? '', title, content: editor.content,
        category: editor.category.trim() || undefined, hotkey: editor.hotkey.trim() || undefined,
        example: editor.example, createdAt: editor.editing?.createdAt ?? now, updatedAt: now });
      setEditor(EMPTY_EDITOR);
      queueMicrotask(() => returnFocus.current?.focus());
      showToast(editor.editing ? '已更新' : '已添加');
    } catch (error) { console.error('[PromptLibraryView] Failed to save template:', error); showToast('保存失败，内容仍保留，请重试'); }
    finally { setSaving(false); }
  };
  const handleDelete = async () => {
    if (!editor.editing) return;
    try { await removePrompt(editor.editing.id); closeEditor(); showToast('已删除'); }
    catch (error) { console.error('[PromptLibraryView] Failed to delete template:', error); setDeleteOpen(false); showToast('删除失败，模板仍保留，请重试'); }
  };
  const handleExport = async () => {
    try { const result = await exportPrompts(); if (result.ok) showToast('已导出'); else if (!result.canceled) showToast('导出失败'); }
    catch (error) { console.error('[PromptLibraryView] Export failed:', error); showToast('导出失败'); }
  };
  const handleImport = async () => {
    try { const result = await importPrompts(); if (result.ok) { await init(); showToast(`已导入：新增 ${result.added ?? 0} 条，更新 ${result.updated ?? 0} 条`); } else if (!result.canceled) showToast('导入失败'); }
    catch (error) { console.error('[PromptLibraryView] Import failed:', error); showToast('导入失败'); }
  };
  const dualPrompts = storedPrompts.filter(isDual);
  const allTargetExample = dualPrompts.every(template => exampleFaces.get(template.id) === false);
  const allFaceLabel = allTargetExample ? '全部切到案例' : '全部切到通用';
  const flipAll = () => setExampleFaces(previous => {
    const next = new Map(previous);
    for (const template of dualPrompts) next.set(template.id, allTargetExample);
    return next;
  });
  return <>
    {!embedded && <WindowResizeHandles />}
    <div className={`prompt-view app-view-root${embedded ? ' is-embedded' : ' app-shell'}`} data-name="prompts.container">
      {!embedded && <StandaloneWindowHeader title="AI资产" dataNamePrefix="prompts.topbar" />}
      <div className="prompt-view-body" data-name="prompts.body">
        <div className="prompt-view-add-row" data-name="prompts.add-row">
          <IconButton type="button" aria-label={allFaceLabel} title={allFaceLabel} disabled={!dualPrompts.length} onClick={flipAll} data-name="prompts.flip-all-button"><FlipHorizontal2 size={16} /></IconButton>
          <IconButton type="button" aria-label="导入提示词" title="导入提示词" onClick={() => void handleImport()} data-name="prompts.import-button"><Download size={16} /></IconButton>
          <IconButton type="button" aria-label="导出提示词" title="导出提示词" onClick={() => void handleExport()} data-name="prompts.export-button"><Upload size={16} /></IconButton>
          <IconButton type="button" aria-label="新增提示词" title="新增提示词" onClick={event => openEditor(undefined, event.currentTarget)} data-name="prompts.add-button"><Plus size={16} /></IconButton>
        </div>
        {(loadFailed || storeLoadFailed) && <div className="prompt-load-error" role="status"><span>提示词加载失败</span><IconButton type="button" aria-label="重试加载提示词" title="重试加载提示词" onClick={() => void loadPrompts()} data-name="prompts.retry-load-button"><RefreshCw size={16} /></IconButton></div>}
        {!prompts.length && <EmptyState message={search ? '没有匹配的提示词' : '暂无提示词模板'} size="large" className="prompt-view-empty" data-name="prompts.empty-state" />}
        <div className="prompt-card-grid">{prompts.map((template, cardIndex) => {
            const dual = isDual(template);
            const exampleFace = hasExample(template) && (!hasUsablePromptContent(template) || exampleFaces.get(template.id) !== false);
            const prefix = `prompts.card-item-${cardIndex + 1}`;
            const body = <><span className="prompt-card-head"><span className="prompt-card-title" title={template.title}>{template.title}</span><span className="prompt-card-face-label">{exampleFace ? '案例' : '通用'}</span></span>
              <span className="prompt-card-content" data-name={`${prefix}-content`}>{exampleFace ? template.example!.content : template.content || '待编写通用提示词'}</span>
              <span className="prompt-card-meta"><span className="prompt-card-category" title={template.category || '未分类'}>{template.category || '未分类'}</span>{!hasUsablePromptContent(template) && <span>待编写通用</span>}{template.hotkey && <kbd>{template.hotkey}</kbd>}{dual && <FlipHorizontal2 size={14} aria-hidden="true" />}</span></>;
            return <article key={template.id} className={`prompt-card${exampleFace ? ' is-example' : ''}${injectedId === template.id ? ' injected' : ''}`} data-id={template.id} data-face={exampleFace ? 'example' : 'general'} data-name={prefix}>
              {dual ? <button type="button" className="prompt-card-face" aria-label={`${template.title}，切到${exampleFace ? '通用' : '案例'}`} title={`切到${exampleFace ? '通用' : '案例'}`} onClick={() => setExampleFaces(previous => new Map(previous).set(template.id, !exampleFace))} data-name={`${prefix}-flip-button`}>{body}</button> : <div className="prompt-card-face">{body}</div>}
              <div className="prompt-card-actions">
                <IconButton type="button" aria-label={`编辑${template.title}`} title="编辑" data-name={`${prefix}-edit-button`} onClick={event => openEditor(template, event.currentTarget)}><Edit3 size={15} /></IconButton>
                {template.example && <IconButton type="button" aria-label={sourceAvailable(template.example) ? `打开${template.title}的原对话` : '原对话不可用'} title={sourceAvailable(template.example) ? '原对话' : '原对话不可用'} disabled={!sourceAvailable(template.example)} onClick={() => onOpenSource?.(template.example!)} data-name={`${prefix}-source-button`}><ExternalLink size={15} /></IconButton>}
                <IconButton type="button" aria-label={`使用${template.title}`} title={hasUsablePromptContent(template) ? '使用通用提示词' : '待编写通用提示词'} disabled={!hasUsablePromptContent(template)} data-name={`${prefix}-use-button`} onClick={() => void handleInject(template)}><ArrowUpRight size={16} /></IconButton>
              </div>
            </article>;
          })}</div>
      </div>
    </div>
    <div className={`prompt-editor-overlay${editor.open ? ' is-open' : ''}`} data-name="prompts.editor-overlay" onClick={closeEditor} aria-hidden={!editor.open}>
      {editor.open && <div className="prompt-editor" role="dialog" aria-modal="true" aria-label="提示词编辑" data-name="prompts.editor-modal" onClick={event => event.stopPropagation()}>
        <div className="prompt-editor-header"><h3>{editor.editing ? '编辑提示词' : '新增提示词'}</h3><IconButton type="button" variant="close" disabled={saving} aria-label="关闭" title="关闭" onClick={closeEditor} data-name="prompts.editor-close-button"><X size={18} /></IconButton></div>
        <PromptEditorForm title={editor.title} content={editor.content} category={editor.category} hotkey={editor.hotkey} example={editor.example} editingId={editor.editing?.id ?? null}
          onTitleChange={value => setEditor(previous => ({ ...previous, title: value }))} onContentChange={value => setEditor(previous => ({ ...previous, content: value }))}
          onCategoryChange={value => setEditor(previous => ({ ...previous, category: value }))} onHotkeyChange={value => setEditor(previous => ({ ...previous, hotkey: value }))}
          onExampleContentChange={value => setEditor(previous => ({ ...previous, example: { ...previous.example, content: value } }))}
          sourceAvailable={sourceAvailable(editor.example)} disabled={saving} dataNamePrefix="prompts.editor" />
        <div className="prompt-editor-footer">
          {editor.editing ? <IconButton type="button" aria-label="删除提示词" title="删除提示词" disabled={saving} onClick={() => setDeleteOpen(true)} data-name="prompts.editor-delete-button"><Trash2 size={16} /></IconButton> : <span />}
          <div className="prompt-editor-actions"><Button type="button" variant="outline" disabled={saving} onClick={closeEditor} data-name="prompts.editor-cancel-button">取消</Button><Button type="button" variant="primary-compact" disabled={saving} onClick={() => void handleSave()} data-name="prompts.editor-save-button">{saving ? '保存中' : '保存'}</Button></div>
        </div>
      </div>}
    </div>
    <ConfirmDialog open={deleteOpen} title="删除提示词" message={`确认删除「${editor.title}」？`} confirmLabel="删除" variant="danger" onConfirm={handleDelete} onCancel={() => setDeleteOpen(false)} />
    <div role="status" className={`prompt-toast app-toast${toast !== null ? ' is-open' : ''}`} data-name="prompts.toast">{toast ?? ''}</div>
  </>;
}
