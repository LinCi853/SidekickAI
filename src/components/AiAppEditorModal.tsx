/* =====================================================================
   AiAppEditorModal —— AI 应用编辑器（设置页内遮罩）
   由原独立窗口 pages/AiAppEditor/index.tsx 迁移而来。
   覆盖整个设置页面，通过 Modal portal 渲染到 document.body。
   渲染按内聚块拆分至 ./AiAppEditorModal/：字段分组、基础信息字段、
   屏蔽规则编辑区、弹窗白名单编辑区（均为纯展示，状态与回调集中于此）。
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
  getAppSettings,
} from '../lib/electron-api';
import type {
  AIPlatform,
  Profile,
  DevicePreset,
} from '../lib/electron-api';
import type { BlockRule } from '../../electron/shared/block-rules.types';
import { generateUniqueName } from '../../electron/shared/naming';
import { hostnameFromUrl, matchDomain, isValidHexColor } from '../pages/AiAppEditor/domain';
import { EMPTY_RULE_DRAFT } from '../pages/AiAppEditor/constants';
import { useToast } from '../hooks/useToast';
import Button from './ui/Button';
import Modal from './ui/Modal';
import { BasicInfoFields } from './AiAppEditorModal/BasicInfoFields';
import { BlockRulesSection } from './AiAppEditorModal/BlockRulesSection';
import { PopupWhitelistSection } from './AiAppEditorModal/PopupWhitelistSection';
import '../pages/PromptLibraryView.css';
import './AiAppEditorModal.css';

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
  // 全局屏蔽规则开关
  const [disableAllBlockRules, setDisableAllBlockRules] = useState(false);

  const [saving, setSaving] = useState(false);
  const { toast, showToast } = useToast();

  // 初始化：全局屏蔽规则开关
  useEffect(() => {
    void getAppSettings().then((cfg) => setDisableAllBlockRules(cfg.disableAllBlockRules ?? false)).catch(() => {});
  }, []);

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
          <BasicInfoFields
            platform={platform}
            desktopPresets={desktopPresets}
            mobilePresets={mobilePresets}
            aiPlatformName={aiPlatformName}
            setAiPlatformName={setAiPlatformName}
            aiPlatformUrl={aiPlatformUrl}
            setAiPlatformUrl={setAiPlatformUrl}
            browserHomePage={browserHomePage}
            setBrowserHomePage={setBrowserHomePage}
            aiDesktopPreset={aiDesktopPreset}
            setAiDesktopPreset={setAiDesktopPreset}
            aiMobilePreset={aiMobilePreset}
            setAiMobilePreset={setAiMobilePreset}
            aiInputSelector={aiInputSelector}
            setAiInputSelector={setAiInputSelector}
            aiSendSelector={aiSendSelector}
            setAiSendSelector={setAiSendSelector}
            aiThemeColor={aiThemeColor}
            setAiThemeColor={setAiThemeColor}
            aiPlatformRegion={aiPlatformRegion}
            setAiPlatformRegion={setAiPlatformRegion}
          />

          {/* 屏蔽规则：全局关闭时隐藏 */}
          {!disableAllBlockRules && (
            <BlockRulesSection
              platform={platform}
              filteredRules={filteredRules}
              showRuleForm={showRuleForm}
              ruleDraft={ruleDraft}
              setRuleDraft={setRuleDraft}
              onRuleToggle={handleRuleToggle}
              onRuleEdit={handleRuleEdit}
              onRuleDelete={handleRuleDelete}
              onRuleAdd={handleRuleAdd}
              onRuleSave={handleRuleSave}
              onRuleCancel={handleRuleCancel}
            />
          )}

          {/* 弹窗白名单 */}
          <PopupWhitelistSection
            popupWhitelist={popupWhitelist}
            setPopupWhitelist={setPopupWhitelist}
            whitelistInput={whitelistInput}
            setWhitelistInput={setWhitelistInput}
            showToast={showToast}
          />

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
