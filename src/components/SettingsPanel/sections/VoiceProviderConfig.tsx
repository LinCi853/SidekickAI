import { useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Button } from '../../ui';
import { useDraftState } from '../../../hooks/useDraftState';

/** 测试结果的公共字段（AI 回声 / TTS 合成结果均含 ok + message） */
interface BaseTestResult {
  ok: boolean;
  message: string;
}

interface VoiceProviderConfigProps<T, R extends BaseTestResult = BaseTestResult> {
  /** 作用域，用于生成 data-name 属性（ai / local / tts） */
  scope: 'ai' | 'local' | 'tts';
  /** 当前的持久化配置（draft 初始值） */
  initial: T;
  /** 保存草稿：持久化 + 同步父级 state */
  onSave: (draft: T) => Promise<void> | void;
  /** 测试连通性（可选；local 模式无测试按钮） */
  onTest?: (draft: T) => Promise<R> | R;
  /** 测试按钮文案 */
  testLabel?: string;
  /** 测试中文案 */
  testingLabel?: string;
  /** 测试按钮额外禁用条件（如未选择服务商） */
  testDisabled?: (draft: T) => boolean;
  /** 渲染表单字段（服务商选择 / 路径输入等差异化部分） */
  children: (ctx: { draft: T; setDraft: Dispatch<SetStateAction<T>> }) => ReactNode;
  /** 渲染测试结果中的差异化内容（识别回声 / 音频回放） */
  renderTestResultExtra?: (result: R) => ReactNode;
}

/**
 * 语音服务商配置子组件：封装 STT/TTS 三套相同的「草稿 + dirty + 保存 + 测试」模式。
 *
 * 共同结构（本组件负责）：draft 状态、isDirty 判断、保存按钮（仅 dirty 时显示）、
 * 测试按钮、测试结果外层容器。
 * 差异结构（由调用方通过 children / renderTestResultExtra 提供）：具体表单字段、
 * 测试结果内的差异化展示（AI 识别回声 / TTS 音频回放）。
 */
function VoiceProviderConfig<T, R extends BaseTestResult = BaseTestResult>({
  scope,
  initial,
  onSave,
  onTest,
  testLabel = '测试连接',
  testingLabel = '测试中…',
  testDisabled,
  children,
  renderTestResultExtra,
}: VoiceProviderConfigProps<T, R>) {
  const { draft, setDraft, isDirty, save } = useDraftState<T>({ initial, onSave });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<R | null>(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      await save();
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(draft);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) } as R);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {children({ draft, setDraft })}
      {isDirty && (
        <Button
          variant="primary-compact"
          className="voice-save-btn btn-save-primary"
          disabled={saving}
          onClick={handleSave}
          data-name={`settings.voice.${scope}-save-button`}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      )}
      {onTest && (
        <Button
          variant="text"
          className="voice-test-btn btn-secondary-underline"
          disabled={testing || (testDisabled ? testDisabled(draft) : false)}
          onClick={handleTest}
          data-name={`settings.voice.${scope}-test-button`}
        >
          {testing ? testingLabel : testLabel}
        </Button>
      )}
      {testResult && (
        <div
          className={`voice-test-result test-result ${testResult.ok ? 'ok' : 'fail'}`}
          data-name={`settings.voice.${scope}-test-result`}
        >
          {testResult.message}
          {renderTestResultExtra && renderTestResultExtra(testResult)}
        </div>
      )}
    </>
  );
}

export default VoiceProviderConfig;
