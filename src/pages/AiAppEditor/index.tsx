/* =====================================================================
   pages/AiAppEditor/index.tsx —— AI 应用编辑独立窗口
   架构：
   - 顶栏：标题 + 最小化/最大化/关闭（无边框窗口自定义标题栏）
   - 主体：单 AI 应用的全部配置编辑（URL、UA、选择器、主题色、区域、屏蔽规则）
   - 通过 URL 查询参数 ?windowId=ai-app-editor-${base64Opts}&mode=ai-app-editor 接收入参
     · 编辑模式：opts.profileId 精确定位 Profile（支持同一平台多实例）
     · 新建模式：opts.mode='create'，表单空白，保存时调用 createProfile
   - 屏蔽规则按当前平台域名匹配筛选，内嵌紧凑编辑器（增删改即时保存）
   - 渲染按内聚块拆分至 ./components/：基础信息字段、屏蔽规则编辑区、弹窗白名单编辑区
     （均为纯展示组件，表单状态与回调集中在本文件）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onMaximizeToggled,
  onPinToggled,
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
} from '../../lib/electron-api';
import type {
  AIPlatform,
  Profile,
  DevicePreset,
} from '../../lib/electron-api';
import type { BlockRule } from '../../../electron/shared/block-rules.types';
import { generateUniqueName } from '../../../electron/shared/naming';
import { useToast } from '../../hooks/useToast';
import { useEscToCloseWindow } from '../../hooks/useEscToCloseWindow';
import Button from '../../components/ui/Button';
import '../PromptLibraryView.css';
import { parseEditorOpts } from './editorOpts.js';
import { hostnameFromUrl, matchDomain, isValidHexColor } from './domain.js';
import { EMPTY_RULE_DRAFT } from './constants.js';
import { AiAppEditorTitleBar } from './components/TitleBar.js';
import { BasicInfoFields } from './components/BasicInfoFields.js';
import { BlockRulesSection } from './components/BlockRulesSection.js';
import { PopupWhitelistSection } from './components/PopupWhitelistSection.js';

export default function AiAppEditor() {
  const editorOpts = useMemo(parseEditorOpts, []);
  const isCreateMode = editorOpts.mode === 'create';

  const [maximized, setMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<AIPlatform | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [allRules, setAllRules] = useState<BlockRule[]>([]);

  // 表单字段（编辑态）
  const [aiPlatformName, setAiPlatformName] = useState('');
  const [aiPlatformUrl, setAiPlatformUrl] = useState('');
  const [browserHomePage, setBrowserHomePage] = useState('');
  const [aiDesktopPreset, setAiDesktopPreset] = useState('');
  const [aiMobilePreset, setAiMobilePreset] = useState('');
  const [aiInputSelector, setAiInputSelector] = useState('');
  const [aiSendSelector, setAiSendSelector] = useState('');
  const [aiThemeColor, setAiThemeColor] = useState('');
  const [aiPlatformRegion, setAiPlatformRegion] = useState<'cn' | 'global'>('cn');

  // 弹窗白名单编辑（Profile 专属，应用关联域隔离）
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

  // 初始化：最大化状态 + 全局屏蔽规则开关
  useEffect(() => {
    void isWindowMaximized().then(setMaximized).catch(() => {});
    void getAppSettings().then((cfg) => setDisableAllBlockRules(cfg.disableAllBlockRules ?? false)).catch(() => {});
  }, []);

  // F12 由主进程 attachWindowHotkeyInterceptor 拦截处理，渲染层仅通过 IPC 监听状态更新
  useEffect(() => {
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);
  useEffect(() => {
    const offPin = onPinToggled((onTop) => setIsPinned(onTop));
    const offMax = onMaximizeToggled((max) => setMaximized(max));
    return () => { offPin(); offMax(); };
  }, []);

  // ESC / Ctrl+W 关窗：屏蔽规则表单打开时 ESC 优先关闭表单，否则关闭窗口
  useEscToCloseWindow({
    onEsc: () => {
      if (showRuleForm) {
        setShowRuleForm(false);
        return true;
      }
      return false;
    },
  });

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
        // 新建模式：表单空白，用户自由配置（platform/profile 均为 null）
        setPlatform(null);
        setProfile(null);
        // 表单字段全部初始化为空
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

      // 编辑模式：按 profileId 精确查找 Profile（支持同一平台多实例）
      if (!editorOpts.profileId) {
        setError('缺少 profileId');
        setLoading(false);
        return;
      }
      const matchedProfile = profiles.find((p) => p.id === editorOpts.profileId) ?? null;
      if (!matchedProfile) {
        setError(`未找到 Profile: ${editorOpts.profileId}`);
        setLoading(false);
        return;
      }
      // 反向查找平台元数据（颜色/默认值）：profile.aiPlatformId 优先
      const found = matchedProfile.aiPlatformId
        ? platforms.find((p) => p.id === matchedProfile.aiPlatformId) ?? null
        : matchedProfile.aiPlatformUrl
          ? platforms.find((p) => p.url === matchedProfile.aiPlatformUrl) ?? null
          : null;
      setPlatform(found);
      setProfile(matchedProfile);
      // 初始化表单字段（优先用 Profile 覆盖值，回退平台默认值）
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
      console.error('[AiAppEditor] 加载失败:', e);
      setError('加载数据失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [editorOpts.profileId, isCreateMode]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 监听跨窗口 Profile 更新广播：当其他窗口（如 MainView 编辑标题）更新了同 id 的 Profile，
  // 同步更新本地表单字段（名称、URL 等），避免编辑窗口显示陈旧数据
  useEffect(() => {
    const off = onProfileUpdated((data) => {
      if (!profile || data.id !== profile.id) return;
      setProfile(data.profile);
      // 同步表单字段（仅更新用户可能在外部修改的字段）
      if (data.profile.name !== undefined) setAiPlatformName(data.profile.name);
      if (data.profile.aiPlatformUrl !== undefined) setAiPlatformUrl(data.profile.aiPlatformUrl);
      if (data.profile.browserHomePage !== undefined) setBrowserHomePage(data.profile.browserHomePage);
      if (data.profile.aiInputSelector !== undefined) setAiInputSelector(data.profile.aiInputSelector);
      if (data.profile.aiSendSelector !== undefined) setAiSendSelector(data.profile.aiSendSelector);
      if (data.profile.aiThemeColor !== undefined) setAiThemeColor(data.profile.aiThemeColor);
      if (data.profile.aiPlatformRegion !== undefined) setAiPlatformRegion(data.profile.aiPlatformRegion);
      if (data.profile.popupWhitelist !== undefined) setPopupWhitelist(data.profile.popupWhitelist);
      // 更新 allProfiles 中的对应项（名称唯一性校验需要最新数据）
      setAllProfiles((prev) => prev.map((p) => (p.id === data.id ? data.profile : p)));
    });
    return () => { off(); };
  }, [profile]);

  // 按当前平台域名筛选屏蔽规则
  const filteredRules = useMemo(() => {
    const hostname = platform ? hostnameFromUrl(platform.url) : '';
    return allRules.filter((r) => matchDomain(r.domainPattern, hostname));
  }, [allRules, platform]);

  // 设备预设分组
  const desktopPresets = useMemo(
    () => presets.filter((p) => p.platform === 'desktop'),
    [presets],
  );
  const mobilePresets = useMemo(
    () => presets.filter((p) => p.platform === 'mobile'),
    [presets],
  );

  const handleMaximize = async () => {
    const next = await maximizeToggleWindow();
    setMaximized(next);
  };

  // 置顶切换（与 F12 快捷键共用同一逻辑）
  const handlePin = async () => {
    const next = !isPinned;
    setIsPinned(next);
    await pinCurrentWindow(next);
  };

  // 保存 Profile 字段（新建模式调用 createProfile，编辑模式调用 updateProfile）
  const handleSave = async () => {
    if (!aiPlatformUrl.trim()) {
      showToast('平台 URL 不能为空');
      return;
    }
    if (aiThemeColor && !isValidHexColor(aiThemeColor)) {
      showToast('主题色格式无效（需 #RGB 或 #RRGGBB）');
      return;
    }
    // 应用名称处理：
    // - create 模式：重名时自动追加 -2/-3 后缀，不阻塞创建；空名用默认 '未命名 AI 应用'
    // - edit 模式：重名时阻塞保存（避免误改重名）
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
        console.warn(`[AiAppEditor] 应用名称「${trimmedName}」已存在，保存被阻止`);
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
        // 新建模式：调用 createProfile 创建新 Profile
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
        // 创建成功后切换到编辑模式（避免重复创建）
        editorOpts.mode = 'edit';
        editorOpts.profileId = created.id;
      } else {
        // 编辑模式：必须有 profile
        if (!profile) {
          showToast('未找到对应 Profile，无法保存');
          setSaving(false);
          return;
        }
        const updated = await updateProfile(profile.id, patch);
        setProfile(updated);
        // 同步更新 allProfiles 中的名称，避免后续校验使用旧数据
        setAllProfiles((prev) =>
          prev.map((p) => (p.id === updated.id ? updated : p)),
        );
        showToast('已保存');
      }
    } catch (e) {
      console.error('[AiAppEditor] 保存失败:', e);
      showToast('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    void closeCurrentWindow();
  };

  // 屏蔽规则 CRUD（即时保存）
  const refreshRules = useCallback(async () => {
    try {
      const list = await listBlockRules();
      setAllRules(list);
    } catch (e) {
      console.error('[AiAppEditor] 刷新屏蔽规则失败:', e);
    }
  }, []);

  const handleRuleToggle = async (rule: BlockRule) => {
    try {
      await updateBlockRule(rule.id, { enabled: !rule.enabled });
      await refreshRules();
    } catch (e) {
      console.error('[AiAppEditor] 切换规则失败:', e);
    }
  };

  const handleRuleDelete = async (id: string) => {
    try {
      await deleteBlockRule(id);
      await refreshRules();
    } catch (e) {
      console.error('[AiAppEditor] 删除规则失败:', e);
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
    // 默认 domainPattern 用当前平台域名（如有），便于用户少输入
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
      console.error('[AiAppEditor] 保存规则失败:', e);
      showToast('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleRuleCancel = () => {
    setShowRuleForm(false);
    setEditingRuleId(null);
    setRuleDraft(EMPTY_RULE_DRAFT);
  };

  // ===== 渲染 =====
  if (loading) {
    return (
      <>
        <WindowResizeHandles />
        <div className="prompt-view app-shell app-view-root" data-name="ai-app-editor.loading-container">
          <div className="prompt-view-body" style={{ alignItems: 'center', justifyContent: 'center' }} data-name="ai-app-editor.loading-body">
            <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }} data-name="ai-app-editor.loading-text">
              加载中…
            </div>
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <WindowResizeHandles />
        <div className="prompt-view app-shell app-view-root" data-name="ai-app-editor.error-container">
          <AiAppEditorTitleBar
            title="AI 应用配置"
            maximized={maximized}
            isPinned={isPinned}
            onMinimize={() => void minimizeWindow()}
            onMaximize={() => void handleMaximize()}
            onClose={() => void closeCurrentWindow()}
            onPin={() => void handlePin()}
          />
          <div className="prompt-view-body" style={{ alignItems: 'center', justifyContent: 'center' }} data-name="ai-app-editor.error-body">
            <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} data-name="ai-app-editor.error-text">
              {error}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <WindowResizeHandles />
      <div className="prompt-view app-shell app-view-root" data-name="ai-app-editor.container">
        <AiAppEditorTitleBar
          title={`AI 应用配置${platform ? ' · ' + platform.name : ''}`}
          maximized={maximized}
          isPinned={isPinned}
          onMinimize={() => void minimizeWindow()}
          onMaximize={() => void handleMaximize()}
          onClose={() => void closeCurrentWindow()}
          onPin={() => void handlePin()}
        />

        <div className="prompt-view-body" style={{ padding: 'var(--space-3)', gap: 'var(--space-3)' }} data-name="ai-app-editor.body">
          {/* 基础信息 */}
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

          {/* 屏蔽规则（按当前域名筛选）：全局关闭时隐藏 */}
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

          {/* 弹窗白名单（Profile 专属） */}
          <PopupWhitelistSection
            popupWhitelist={popupWhitelist}
            setPopupWhitelist={setPopupWhitelist}
            whitelistInput={whitelistInput}
            setWhitelistInput={setWhitelistInput}
            showToast={showToast}
          />

          {/* 操作按钮 */}
          <div
            data-name="ai-app-editor.footer-actions"
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              justifyContent: 'flex-end',
              paddingTop: 'var(--space-2)',
              borderTop: '1px solid var(--border)',
              marginTop: 'var(--space-1)',
            }}
          >
            <Button
              variant="outline"
              className="prompt-btn"
              onClick={handleCancel}
              disabled={saving}
              data-name="ai-app-editor.cancel-button"
            >
              取消
            </Button>
            <Button
              variant="primary-compact"
              className="prompt-btn"
              onClick={() => void handleSave()}
              disabled={saving}
              data-name="ai-app-editor.save-button"
            >
              {saving ? '保存中…' : (isCreateMode ? '创建' : '保存')}
            </Button>
          </div>
        </div>

        {/* toast */}
        {toast && (
          <div className={`prompt-toast app-toast is-open`} role="status" aria-live="polite" data-name="ai-app-editor.toast">
            {toast}
          </div>
        )}
      </div>
    </>
  );
}

