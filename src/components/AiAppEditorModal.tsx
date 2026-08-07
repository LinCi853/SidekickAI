/* =====================================================================
   AiAppEditorModal —— AI 应用编辑器（设置页内遮罩）
   由原独立窗口 pages/AiAppEditor/index.tsx 迁移而来。
   覆盖整个设置页面，通过 Modal portal 渲染到 document.body。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listAIPlatforms,
  getPresetAIPlatforms,
  listProfiles,
  listPresets,
  createProfile,
  updateProfile,
  onProfileUpdated,
  listBlockRules,
  saveBlockRule,
  updateBlockRule,
  deleteBlockRule,
} from '../lib/electron-api';
import type {
  AIPlatform,
  Profile,
  DevicePreset,
} from '../lib/electron-api';
import type { BlockRule, BlockRuleType } from '../../electron/shared/block-rules.types';
import { generateUniqueName } from '../../electron/shared/naming';
import { useToast } from '../hooks/useToast';
import Button from './ui/Button';
import Modal from './ui/Modal';
import { Combobox } from './ui';
import type { ComboboxOption } from './ui';
import Toggle from './ui/Toggle';
import SegmentedControl from './ui/SegmentedControl';
import '../pages/PromptLibraryView.css';
import './AiAppEditorModal.css';

/** 从 URL 提取 hostname（用于屏蔽规则域名匹配） */
function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (!hostname) return false;
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return hostname === pattern.slice(2) || hostname.endsWith(suffix);
  }
  return false;
}

function isValidHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}

const EMPTY_RULE_DRAFT: Omit<BlockRule, 'id' | 'builtin'> = {
  domainPattern: '*',
  type: 'css',
  selector: '',
  jsCode: '',
  label: '',
  enabled: true,
};

export interface AiAppEditorModalProps {
  open: boolean;
  onClose: () => void;
  /** 编辑模式：指定 profileId；新建模式：不传或 mode='create' */
  profileId?: string;
  mode?: 'edit' | 'create';
}

export default function AiAppEditorModal({
  open,
  onClose,
  profileId,
  mode = 'edit',
}: AiAppEditorModalProps) {
  const isCreateMode = mode === 'create';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<AIPlatform | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [allRules, setAllRules] = useState<BlockRule[]>([]);

  // 表单字段
  const [aiPlatformName, setAiPlatformName] = useState('');
  const [aiPlatformUrl, setAiPlatformUrl] = useState('');
  const [browserHomePage, setBrowserHomePage] = useState('');
  const [aiDesktopPreset, setAiDesktopPreset] = useState('');
  const [aiMobilePreset, setAiMobilePreset] = useState('');
  const [aiInputSelector, setAiInputSelector] = useState('');
  const [aiSendSelector, setAiSendSelector] = useState('');
  const [aiThemeColor, setAiThemeColor] = useState('');
  const [aiPlatformRegion, setAiPlatformRegion] = useState<'cn' | 'global'>('cn');

  // 弹窗白名单
  const [popupWhitelist, setPopupWhitelist] = useState<string[]>([]);
  const [whitelistInput, setWhitelistInput] = useState('');

  // 屏蔽规则编辑草稿
  const [ruleDraft, setRuleDraft] = useState<Omit<BlockRule, 'id' | 'builtin'>>(EMPTY_RULE_DRAFT);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);

  const [saving, setSaving] = useState(false);
  const { toast, showToast } = useToast();

  // 加载所有数据
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [platforms, profiles, presetList, rules] = await Promise.all([
        listAIPlatforms().catch(() => getPresetAIPlatforms()),
        listProfiles(),
        listPresets(),
        listBlockRules(),
      ]);
      setAllProfiles(profiles);
      setPresets(presetList);
      setAllRules(rules);

      if (isCreateMode) {
        setPlatform(null);
        setProfile(null);
        setAiPlatformName('');
        setAiPlatformUrl('');
        setBrowserHomePage('');
        setAiDesktopPreset('');
        setAiMobilePreset('');
        setAiInputSelector('');
        setAiSendSelector('');
        setAiThemeColor('');
        setAiPlatformRegion('cn');
        setPopupWhitelist([]);
        setWhitelistInput('');
        setError(null);
        return;
      }

      if (!profileId) {
        setError('缺少 profileId');
        setLoading(false);
        return;
      }
      const matchedProfile = profiles.find((p) => p.id === profileId) ?? null;
      if (!matchedProfile) {
        setError(`未找到 Profile: ${profileId}`);
        setLoading(false);
        return;
      }
      const found = matchedProfile.aiPlatformId
        ? platforms.find((p) => p.id === matchedProfile.aiPlatformId) ?? null
        : matchedProfile.aiPlatformUrl
          ? platforms.find((p) => p.url === matchedProfile.aiPlatformUrl) ?? null
          : null;
      setPlatform(found);
      setProfile(matchedProfile);
      setAiPlatformName(matchedProfile.name ?? found?.name ?? '');
      setAiPlatformUrl(matchedProfile.aiPlatformUrl ?? found?.url ?? '');
      setBrowserHomePage(matchedProfile.browserHomePage ?? '');
      setAiDesktopPreset(matchedProfile.aiDesktopPreset ?? found?.defaultDesktopPreset ?? '');
      setAiMobilePreset(matchedProfile.aiMobilePreset ?? found?.defaultMobilePreset ?? '');
      setAiInputSelector(matchedProfile.aiInputSelector ?? '');
      setAiSendSelector(matchedProfile.aiSendSelector ?? '');
      setAiThemeColor(matchedProfile.aiThemeColor ?? found?.themeColor ?? '');
      setAiPlatformRegion(matchedProfile.aiPlatformRegion ?? found?.region ?? 'cn');
      setPopupWhitelist(matchedProfile.popupWhitelist ?? []);
      setWhitelistInput('');
      setError(null);
    } catch (e) {
      console.error('[AiAppEditorModal] 加载失败:', e);
      setError('加载数据失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [profileId, isCreateMode]);

  useEffect(() => {
    if (open) void loadAll();
  }, [open, loadAll]);

  // 监听跨窗口 Profile 更新广播
  useEffect(() => {
    if (!open) return;
    const off = onProfileUpdated((data) => {
      if (!profile || data.id !== profile.id) return;
      setProfile(data.profile);
      if (data.profile.name !== undefined) setAiPlatformName(data.profile.name);
      if (data.profile.aiPlatformUrl !== undefined) setAiPlatformUrl(data.profile.aiPlatformUrl);
      if (data.profile.browserHomePage !== undefined) setBrowserHomePage(data.profile.browserHomePage);
      if (data.profile.aiInputSelector !== undefined) setAiInputSelector(data.profile.aiInputSelector);
      if (data.profile.aiSendSelector !== undefined) setAiSendSelector(data.profile.aiSendSelector);
      if (data.profile.aiThemeColor !== undefined) setAiThemeColor(data.profile.aiThemeColor);
      if (data.profile.aiPlatformRegion !== undefined) setAiPlatformRegion(data.profile.aiPlatformRegion);
      if (data.profile.popupWhitelist !== undefined) setPopupWhitelist(data.profile.popupWhitelist);
      setAllProfiles((prev) => prev.map((p) => (p.id === data.id ? data.profile : p)));
    });
    return () => { off(); };
  }, [open, profile]);

  const filteredRules = useMemo(() => {
    const hostname = platform ? hostnameFromUrl(platform.url) : '';
    return allRules.filter((r) => matchDomain(r.domainPattern, hostname));
  }, [allRules, platform]);

  const desktopPresets = useMemo(
    () => presets.filter((p) => p.platform === 'desktop'),
    [presets],
  );
  const mobilePresets = useMemo(
    () => presets.filter((p) => p.platform === 'mobile'),
    [presets],
  );

  const handleSave = async () => {
    if (!aiPlatformUrl.trim()) {
      showToast('平台 URL 不能为空');
      return;
    }
    if (aiThemeColor && !isValidHexColor(aiThemeColor)) {
      showToast('主题色格式无效（需 #RGB 或 #RRGGBB）');
      return;
    }
    const trimmedName = aiPlatformName.trim();
    let finalName = trimmedName || '未命名 AI 应用';
    if (isCreateMode) {
      const existingNames = allProfiles.map((p) => p.name);
      finalName = generateUniqueName(finalName, existingNames);
    } else {
      const duplicate = allProfiles.some(
        (p) => (!profile || p.id !== profile.id) && p.name === trimmedName,
      );
      if (duplicate) {
        showToast(`应用名称「${trimmedName}」已存在，请使用其他名称`);
        return;
      }
    }
    setSaving(true);
    try {
      const patch: Partial<Profile> = {
        name: finalName,
        aiPlatformUrl: aiPlatformUrl.trim(),
        browserHomePage: browserHomePage.trim() || undefined,
        aiDesktopPreset: aiDesktopPreset || undefined,
        aiMobilePreset: aiMobilePreset || undefined,
        aiInputSelector: aiInputSelector.trim() || undefined,
        aiSendSelector: aiSendSelector.trim() || undefined,
        aiThemeColor: aiThemeColor.trim() || undefined,
        aiPlatformRegion,
        popupWhitelist: popupWhitelist.length > 0 ? popupWhitelist : undefined,
      };

      if (isCreateMode) {
        const created = await createProfile({
          isAIPlatform: true,
          aiPlatformId: platform?.id,
          aiPlatformUrl: patch.aiPlatformUrl,
          browserHomePage: patch.browserHomePage,
          name: patch.name,
          aiDesktopPreset: patch.aiDesktopPreset,
          aiMobilePreset: patch.aiMobilePreset,
          aiInputSelector: patch.aiInputSelector,
          aiSendSelector: patch.aiSendSelector,
          aiThemeColor: patch.aiThemeColor,
          aiPlatformRegion: patch.aiPlatformRegion,
          popupWhitelist: patch.popupWhitelist,
        });
        setProfile(created);
        setAllProfiles((prev) => [...prev, created]);
        showToast('已创建');
        onClose();
      } else {
        if (!profile) {
          showToast('未找到对应 Profile，无法保存');
          setSaving(false);
          return;
        }
        const updated = await updateProfile(profile.id, patch);
        setProfile(updated);
        setAllProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        showToast('已保存');
      }
    } catch (e) {
      console.error('[AiAppEditorModal] 保存失败:', e);
      showToast('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  // 屏蔽规则 CRUD
  const refreshRules = useCallback(async () => {
    try {
      const list = await listBlockRules();
      setAllRules(list);
    } catch (e) {
      console.error('[AiAppEditorModal] 刷新屏蔽规则失败:', e);
    }
  }, []);

  const handleRuleToggle = async (rule: BlockRule) => {
    try {
      await updateBlockRule(rule.id, { enabled: !rule.enabled });
      await refreshRules();
    } catch (e) {
      console.error('[AiAppEditorModal] 切换规则失败:', e);
    }
  };

  const handleRuleDelete = async (id: string) => {
    try {
      await deleteBlockRule(id);
      await refreshRules();
    } catch (e) {
      console.error('[AiAppEditorModal] 删除规则失败:', e);
    }
  };

  const handleRuleEdit = (rule: BlockRule) => {
    setEditingRuleId(rule.id);
    setShowRuleForm(true);
    setRuleDraft({
      domainPattern: rule.domainPattern,
      type: rule.type,
      selector: rule.selector,
      jsCode: rule.jsCode || '',
      label: rule.label,
      enabled: rule.enabled,
    });
  };

  const handleRuleAdd = () => {
    setEditingRuleId(null);
    setShowRuleForm(true);
    const hostname = platform ? hostnameFromUrl(platform.url) : '*';
    setRuleDraft({ ...EMPTY_RULE_DRAFT, domainPattern: hostname || '*' });
  };

  const handleRuleSave = async () => {
    if (!ruleDraft.label.trim()) {
      showToast('请填写规则名称');
      return;
    }
    if (ruleDraft.type === 'css' && !ruleDraft.selector.trim()) {
      showToast('请填写 CSS 选择器');
      return;
    }
    if (ruleDraft.type === 'js' && !(ruleDraft.jsCode ?? '').trim()) {
      showToast('请填写 JS 代码');
      return;
    }
    try {
      if (editingRuleId) {
        await updateBlockRule(editingRuleId, ruleDraft);
      } else {
        await saveBlockRule({ ...ruleDraft, id: '', builtin: false } as BlockRule);
      }
      setShowRuleForm(false);
      setEditingRuleId(null);
      setRuleDraft(EMPTY_RULE_DRAFT);
      await refreshRules();
      showToast(editingRuleId ? '已更新' : '已添加');
    } catch (e) {
      console.error('[AiAppEditorModal] 保存规则失败:', e);
      showToast('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleRuleCancel = () => {
    setShowRuleForm(false);
    setEditingRuleId(null);
    setRuleDraft(EMPTY_RULE_DRAFT);
  };

  const title = isCreateMode
    ? '新建 AI 应用'
    : `编辑 AI 应用${platform ? ' · ' + platform.name : ''}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      portal
      closeOnOverlayClick={!showRuleForm}
      className="ai-app-editor-modal"
    >
      {loading ? (
        <div className="ai-app-editor-loading" data-name="ai-app-editor.loading">
          加载中…
        </div>
      ) : error ? (
        <div className="ai-app-editor-error" data-name="ai-app-editor.error">
          {error}
        </div>
      ) : (
        <div className="ai-app-editor-body" data-name="ai-app-editor.body">
          <FieldGroup label="应用名称">
            <input
              type="text"
              className="ai-editor-input"
              value={aiPlatformName}
              onChange={(e) => setAiPlatformName(e.target.value)}
              placeholder={platform?.name ?? '输入应用名称'}
              data-name="ai-app-editor.name-input"
            />
          </FieldGroup>

          <FieldGroup label="平台 URL">
            <input
              type="text"
              className="ai-editor-input"
              value={aiPlatformUrl}
              onChange={(e) => setAiPlatformUrl(e.target.value)}
              placeholder="https://chat.example.com"
              data-name="ai-app-editor.url-input"
            />
          </FieldGroup>

          <FieldGroup label="浏览器主页">
            <input
              type="text"
              className="ai-editor-input"
              value={browserHomePage}
              onChange={(e) => setBrowserHomePage(e.target.value)}
              placeholder="留空则使用平台 URL"
              data-name="ai-app-editor.browser-home-page-input"
            />
          </FieldGroup>

          <FieldGroup label="桌面端 UA 预设">
            <Combobox
              inputValue={desktopPresets.find((p) => p.id === aiDesktopPreset)?.name ?? ''}
              onInputChange={() => {}}
              inputPlaceholder="选择桌面端 UA 预设"
              inputClassName="ai-editor-input"
              inputReadOnly
              options={desktopPresets.map<ComboboxOption>((p) => ({
                value: p.id,
                label: p.name,
                selected: p.id === aiDesktopPreset,
              }))}
              onSelect={(v) => setAiDesktopPreset(v)}
              searchable
              searchPlaceholder="搜索 UA 预设…"
              emptyText="无匹配预设"
              dataName="ai-app-editor.desktop-preset"
            />
          </FieldGroup>

          <FieldGroup label="移动端 UA 预设">
            <Combobox
              inputValue={mobilePresets.find((p) => p.id === aiMobilePreset)?.name ?? ''}
              onInputChange={() => {}}
              inputPlaceholder="选择移动端 UA 预设"
              inputClassName="ai-editor-input"
              inputReadOnly
              options={mobilePresets.map<ComboboxOption>((p) => ({
                value: p.id,
                label: p.name,
                selected: p.id === aiMobilePreset,
              }))}
              onSelect={(v) => setAiMobilePreset(v)}
              searchable
              searchPlaceholder="搜索 UA 预设…"
              emptyText="无匹配预设"
              dataName="ai-app-editor.mobile-preset"
            />
          </FieldGroup>

          <FieldGroup label="输入框选择器（留空用平台默认）">
            <input
              type="text"
              className="ai-editor-input"
              value={aiInputSelector}
              onChange={(e) => setAiInputSelector(e.target.value)}
              placeholder={platform?.inputSelector ?? '如：textarea#prompt-textarea'}
              data-name="ai-app-editor.input-selector-input"
            />
          </FieldGroup>

          <FieldGroup label="发送按钮选择器（留空用平台默认）">
            <input
              type="text"
              className="ai-editor-input"
              value={aiSendSelector}
              onChange={(e) => setAiSendSelector(e.target.value)}
              placeholder={platform?.sendSelector ?? '如：button[data-testid="send-button"]'}
              data-name="ai-app-editor.send-selector-input"
            />
          </FieldGroup>

          <FieldGroup label="主题色">
            <div className="ai-app-editor-color-row" data-name="ai-app-editor.theme-color-row">
              <input
                type="color"
                value={isValidHexColor(aiThemeColor) ? aiThemeColor : '#000000'}
                onChange={(e) => setAiThemeColor(e.target.value)}
                className="ai-app-editor-color-picker"
                aria-label="主题色"
                data-name="ai-app-editor.theme-color-picker"
              />
              <input
                type="text"
                className="ai-editor-input"
                value={aiThemeColor}
                onChange={(e) => setAiThemeColor(e.target.value)}
                placeholder="#RRGGBB"
                data-name="ai-app-editor.theme-color-input"
              />
            </div>
          </FieldGroup>

          <FieldGroup label="区域">
            <SegmentedControl
              value={aiPlatformRegion}
              onChange={setAiPlatformRegion}
              options={[
                { value: 'cn', label: '国内' },
                { value: 'global', label: '国外' },
              ]}
              className="seg-control-row"
            />
          </FieldGroup>

          {/* 屏蔽规则 */}
          <FieldGroup
            label={`屏蔽规则（按 ${platform ? hostnameFromUrl(platform.url) || '*' : '*'} 匹配）`}
          >
            <div className="ai-app-editor-rules" data-name="ai-app-editor.block-rules-container">
              {filteredRules.length === 0 && !showRuleForm && (
                <div className="ai-app-editor-empty" data-name="ai-app-editor.block-rules-empty">
                  暂无匹配规则
                </div>
              )}
              {filteredRules.map((rule, rIdx) => (
                <div
                  key={rule.id}
                  className="ai-app-editor-rule-item"
                  data-name={`ai-app-editor.block-rule-item-${rIdx + 1}`}
                >
                  <span className="ai-app-editor-rule-toggle" data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-toggle-wrapper`}>
                    <Toggle
                      checked={rule.enabled}
                      onChange={() => void handleRuleToggle(rule)}
                    />
                  </span>
                  <span className="ai-app-editor-rule-label" data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-label`}>
                    {rule.label || '(未命名)'}
                    {rule.builtin && (
                      <span className="ai-app-editor-rule-builtin" data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-builtin-badge`}>
                        内置
                      </span>
                    )}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => handleRuleEdit(rule)}
                    data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-edit-button`}
                  >
                    编辑
                  </Button>
                  {!rule.builtin && (
                    <Button
                      variant="text"
                      danger
                      className="btn-secondary-underline danger"
                      onClick={() => void handleRuleDelete(rule.id)}
                      data-name={`ai-app-editor.block-rule-item-${rIdx + 1}-delete-button`}
                    >
                      删除
                    </Button>
                  )}
                </div>
              ))}

              {showRuleForm && (
                <div className="ai-app-editor-rule-form" data-name="ai-app-editor.block-rule-form">
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
                      data-name="ai-app-editor.block-rule-form-js-code-textarea"
                    />
                  )}
                  <div className="ai-app-editor-rule-form-actions" data-name="ai-app-editor.block-rule-form-actions">
                    <Button
                      variant="primary-compact"
                      onClick={() => void handleRuleSave()}
                      data-name="ai-app-editor.block-rule-form-save-button"
                    >
                      保存
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleRuleCancel}
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
                  onClick={handleRuleAdd}
                  data-name="ai-app-editor.block-rule-add-button"
                >
                  + 新增屏蔽规则
                </Button>
              )}
            </div>
          </FieldGroup>

          {/* 弹窗白名单 */}
          <FieldGroup
            label="弹窗白名单（应用专属）"
            hint="允许这些域名弹独立窗口（登录/验证页等）。内置默认登录域已自动合并，此处只需配置本应用额外的关联域。"
          >
            <div className="ai-app-editor-whitelist" data-name="ai-app-editor.popup-whitelist-container">
              {popupWhitelist.length === 0 && (
                <div className="ai-app-editor-empty" data-name="ai-app-editor.popup-whitelist-empty">
                  暂无应用专属白名单（依赖内置默认登录域兜底）
                </div>
              )}
              {popupWhitelist.map((origin, wIdx) => (
                <div
                  key={wIdx}
                  className="ai-app-editor-rule-item"
                  data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}`}
                >
                  <span className="ai-app-editor-rule-label" data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-text`}>
                    {origin}
                  </span>
                  <Button
                    variant="text"
                    danger
                    className="btn-secondary-underline danger"
                    onClick={() => setPopupWhitelist((prev) => prev.filter((_, i) => i !== wIdx))}
                    data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-delete-button`}
                  >
                    删除
                  </Button>
                </div>
              ))}

              <div className="ai-app-editor-whitelist-add" data-name="ai-app-editor.popup-whitelist-add">
                <input
                  type="text"
                  className="ai-editor-input"
                  value={whitelistInput}
                  onChange={(e) => setWhitelistInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const v = whitelistInput.trim();
                      if (v && !popupWhitelist.includes(v)) {
                        setPopupWhitelist((prev) => [...prev, v]);
                        setWhitelistInput('');
                      }
                    }
                  }}
                  placeholder="https://example.com/"
                  data-name="ai-app-editor.popup-whitelist-input"
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    const v = whitelistInput.trim();
                    if (!v) return;
                    if (popupWhitelist.includes(v)) {
                      showToast('该域名已在白名单中');
                      return;
                    }
                    setPopupWhitelist((prev) => [...prev, v]);
                    setWhitelistInput('');
                  }}
                  data-name="ai-app-editor.popup-whitelist-add-button"
                >
                  添加
                </Button>
              </div>
            </div>
          </FieldGroup>

          {/* 操作按钮 */}
          <div className="ai-app-editor-footer" data-name="ai-app-editor.footer-actions">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={saving}
              data-name="ai-app-editor.cancel-button"
            >
              取消
            </Button>
            <Button
              variant="primary-compact"
              onClick={() => void handleSave()}
              disabled={saving}
              data-name="ai-app-editor.save-button"
            >
              {saving ? '保存中…' : (isCreateMode ? '创建' : '保存')}
            </Button>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="prompt-toast app-toast is-open" role="status" aria-live="polite" data-name="ai-app-editor.toast">
          {toast}
        </div>
      )}
    </Modal>
  );
}

/* =====================================================================
   子组件：字段分组
   ===================================================================== */
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="ai-app-editor-field-group" data-name="ai-app-editor.field-group">
      <label className="ai-app-editor-field-label" data-name="ai-app-editor.field-group-label">
        {label}
      </label>
      {hint && (
        <div className="ai-app-editor-field-hint" data-name="ai-app-editor.field-group-hint">
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
