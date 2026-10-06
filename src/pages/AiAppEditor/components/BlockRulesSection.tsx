/* =====================================================================
   pages/AiAppEditor/components/BlockRulesSection.tsx —— 屏蔽规则编辑区
   纯展示组件：按当前平台域名筛选的规则列表 + 内嵌新增/编辑表单。
   规则数据与增删改回调均由父组件（pages/AiAppEditor/index.tsx）传入。
   ===================================================================== */

import type { Dispatch, SetStateAction } from 'react';
import Button from '../../../components/ui/Button';
import Toggle from '../../../components/ui/Toggle';
import SegmentedControl from '../../../components/ui/SegmentedControl';
import type { BlockRule, BlockRuleType } from '../../../../electron/shared/block-rules.types';
import type { AIPlatform } from '../../../lib/electron-api';
import { hostnameFromUrl } from '../domain.js';
import { FieldGroup } from './FieldGroup.js';

export interface BlockRulesSectionProps {
  platform: AIPlatform | null;
  filteredRules: BlockRule[];
  showRuleForm: boolean;
  ruleDraft: Omit<BlockRule, 'id' | 'builtin'>;
  setRuleDraft: Dispatch<SetStateAction<Omit<BlockRule, 'id' | 'builtin'>>>;
  onRuleToggle: (rule: BlockRule) => void;
  onRuleEdit: (rule: BlockRule) => void;
  onRuleDelete: (id: string) => void;
  onRuleAdd: () => void;
  onRuleSave: () => void;
  onRuleCancel: () => void;
}

export function BlockRulesSection({
  platform,
  filteredRules,
  showRuleForm,
  ruleDraft,
  setRuleDraft,
  onRuleToggle,
  onRuleEdit,
  onRuleDelete,
  onRuleAdd,
  onRuleSave,
  onRuleCancel,
}: BlockRulesSectionProps) {
  return (
    <>
      <FieldGroup
        label={`屏蔽规则（按 ${platform ? hostnameFromUrl(platform.url) || '*' : '*'} 匹配）`}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }} data-name="ai-app-editor.block-rules-container">
          <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>CSS 屏蔽会立即更新。JS 规则修改或关闭后，已运行脚本的效果可能需要刷新页面才能恢复。</p>
          {filteredRules.length === 0 && !showRuleForm && (
            <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)', padding: 'var(--space-1) 0' }} data-name="ai-app-editor.block-rules-empty">
              暂无匹配规则
            </div>
          )}
          {filteredRules.map((rule, rIdx) => (
            <div
              key={rule.id}
              data-name={`ai-app-editor.block-rule-item-${rIdx + 1}`}
              data-index={rIdx + 1}
              data-id={rule.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: 'var(--space-1) var(--space-2)',
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-xs)',
              }}
            >
              <span style={{ flexShrink: 0, display: 'inline-flex' }} data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-toggle-wrapper`}>
                <Toggle
                  checked={rule.enabled}
                  onChange={() => void onRuleToggle(rule)}
                />
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-label`}>
                {rule.label || '(未命名)'}
                {rule.builtin && (
                  <span style={{ marginLeft: 'var(--space-1)', color: 'var(--accent-bright)', fontSize: 'var(--text-2xs)' }} data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-builtin-badge`}>
                    内置
                  </span>
                )}
              </span>
              <Button
                variant="outline"
                onClick={() => onRuleEdit(rule)}
                style={{ flexShrink: 0 }}
                data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-edit-button`}
              >
                编辑
              </Button>
              {!rule.builtin && (
                <Button
                  variant="text"
                  danger
                  className="btn-secondary-underline danger"
                  onClick={() => void onRuleDelete(rule.id)}
                  style={{ flexShrink: 0 }}
                  data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-delete-button`}
                >
                  删除
                </Button>
              )}
            </div>
          ))}

          {/* 内嵌新增/编辑表单 */}
          {showRuleForm && (
            <div
              data-name="ai-app-editor.block-rule-form"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                padding: 'var(--space-2)',
                background: 'var(--card)',
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <input
                type="text"
                className="ai-editor-input"
                value={ruleDraft.label}
                onChange={(e) => setRuleDraft({ ...ruleDraft, label: e.target.value })}
                placeholder="规则名称（如：屏蔽下载按钮）"
                data-name="ai-app-editor.block-rule-form-label-input"
              />
              <input
                type="text"
                className="ai-editor-input"
                value={ruleDraft.domainPattern}
                onChange={(e) => setRuleDraft({ ...ruleDraft, domainPattern: e.target.value })}
                placeholder="域名匹配（* / *.domain.com / domain.com）"
                data-name="ai-app-editor.block-rule-form-domain-input"
              />
              <SegmentedControl
                value={ruleDraft.type}
                onChange={(v) => setRuleDraft({ ...ruleDraft, type: v as BlockRuleType })}
                options={[
                  { value: 'css', label: 'CSS 隐藏' },
                  { value: 'js', label: 'JS 脚本' },
                ]}
              />
              {ruleDraft.type === 'css' ? (
                <input
                  type="text"
                  className="ai-editor-input"
                  value={ruleDraft.selector}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, selector: e.target.value })}
                  placeholder="CSS 选择器（如 .ad-banner）"
                  data-name="ai-app-editor.block-rule-form-selector-input"
                />
              ) : (
                <textarea
                  className="ai-editor-input"
                  value={ruleDraft.jsCode}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, jsCode: e.target.value })}
                  placeholder="JS 代码（如 window.alert = function() {};）"
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', minHeight: 'var(--space-12)' }}
                  data-name="ai-app-editor.block-rule-form-js-code-textarea"
                />
              )}
              <div style={{ display: 'flex', gap: 'var(--space-1)' }} data-name="ai-app-editor.block-rule-form-actions">
                <Button
                  variant="primary-compact"
                  className="prompt-btn"
                  onClick={() => void onRuleSave()}
                  data-name="ai-app-editor.block-rule-form-save-button"
                >
                  保存
                </Button>
                <Button
                  variant="outline"
                  className="prompt-btn"
                  onClick={onRuleCancel}
                  data-name="ai-app-editor.block-rule-form-cancel-button"
                >
                  取消
                </Button>
              </div>
            </div>
          )}

          {!showRuleForm && (
            <Button
              variant="outline"
              onClick={onRuleAdd}
              style={{ alignSelf: 'flex-start' }}
              data-name="ai-app-editor.block-rule-add-button"
            >
              + 新增屏蔽规则
            </Button>
          )}
        </div>
      </FieldGroup>
    </>
  );
}
