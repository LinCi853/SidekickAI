/* =====================================================================
   pages/AiAppEditor/index.tsx —— AI 应用编辑独立窗口
   架构：
   - 顶栏：标题 + 最小化/最大化/关闭（无边框窗口自定义标题栏）
   - 主体：单 AI 应用的全部配置编辑（URL、UA、选择器、主题色、区域、屏蔽规则）
   - 通过 URL 查询参数 ?windowId=ai-app-editor-${base64Opts}&mode=ai-app-editor 接收入参
     · 编辑模式：opts.profileId 精确定位 Profile（支持同一平台多实例）
     · 新建模式：opts.mode='create'，表单空白，保存时调用 createProfile
   - 屏蔽规则按当前平台域名匹配筛选，内嵌紧凑编辑器（增删改即时保存）
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
} from '../../lib/electron-api';
import type {
  AIPlatform,
  Profile,
  DevicePreset,
} from '../../lib/electron-api';
import type { BlockRule, BlockRuleType } from '../../../electron/shared/block-rules.types';
import { generateUniqueName } from '../../../electron/shared/naming';
import { useToast } from '../../hooks/useToast';
import { useEscToCloseWindow } from '../../hooks/useEscToCloseWindow';
import Button from '../../components/ui/Button';
import IconButton from '../../components/ui/IconButton';
import { Combobox } from '../../components/ui';
import type { ComboboxOption } from '../../components/ui';
import Toggle from '../../components/ui/Toggle';
import SegmentedControl from '../../components/ui/SegmentedControl';
import '../PromptLibraryView.css';

/** 从 URL 查询参数获取当前窗口 id */
function getWindowId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('windowId') ?? '';
}

/** AI 应用编辑窗口 windowId 前缀 */
const AI_APP_EDITOR_PREFIX = 'ai-app-editor-';

/** 编辑器入参（从 windowId 的 Base64 JSON 解析） */
interface EditorOpts {
  platformId?: string;
  profileId?: string;
  mode?: 'edit' | 'create';
}

/** 从 windowId 解析编辑器入参（平台 ID / Profile ID / 模式） */
function parseEditorOpts(): EditorOpts {
  const wid = getWindowId();
  if (!wid.startsWith(AI_APP_EDITOR_PREFIX)) return {};
  const encoded = wid.slice(AI_APP_EDITOR_PREFIX.length);
  try {
    // 渲染层无 Buffer，用 atob 解码 Base64
    const json = decodeURIComponent(
      atob(encoded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** 从 URL 提取 hostname（用于屏蔽规则域名匹配） */
function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 简单 glob 域名匹配（支持 `*` 通配所有 / `*.domain.com` 匹配子域 / 精确域名）。
 * 仅用于屏蔽规则筛选，非安全敏感场景。
 */
function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (!hostname) return false;
  if (pattern === hostname) return true;
  // *.domain.com → 匹配 domain.com 与任意子域
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .domain.com
    return hostname === pattern.slice(2) || hostname.endsWith(suffix);
  }
  return false;
}

/** 校验十六进制颜色（#RGB / #RRGGBB） */
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

  const [saving, setSaving] = useState(false);
  const { toast, showToast } = useToast();

  // 初始化：最大化状态
  useEffect(() => {
    void isWindowMaximized().then(setMaximized).catch(() => {});
  }, []);

  // F11/F12 由主进程 attachWindowHotkeyInterceptor 拦截处理，渲染层仅通过 IPC 监听状态更新
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

          <FieldGroup label="桌面端 UA 预设">
            <Combobox
              inputValue={desktopPresets.find((p) => p.id === aiDesktopPreset)?.name ?? ''}
              onInputChange={() => {}}
              inputPlaceholder="选择桌面端 UA 预设"
              inputClassName="ai-editor-input"
              inputReadOnly
              options={desktopPresets.map<ComboboxOption>((p, idx) => ({
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
              options={mobilePresets.map<ComboboxOption>((p, idx) => ({
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }} data-name="ai-app-editor.theme-color-row">
              <input
                type="color"
                value={isValidHexColor(aiThemeColor) ? aiThemeColor : '#000000'}
                onChange={(e) => setAiThemeColor(e.target.value)}
                style={{
                  width: 'var(--space-8)',
                  height: 'var(--space-8)',
                  padding: 0,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  cursor: 'pointer',
                  flex: 'none',
                }}
                aria-label="主题色"
                data-name="ai-app-editor.theme-color-picker"
              />
              <input
                type="text"
                className="ai-editor-input"
                value={aiThemeColor}
                onChange={(e) => setAiThemeColor(e.target.value)}
                placeholder="#RRGGBB"
                style={{ flex: 1 }}
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

          {/* 屏蔽规则（按当前域名筛选） */}
          <FieldGroup
            label={`屏蔽规则（按 ${platform ? hostnameFromUrl(platform.url) || '*' : '*'} 匹配）`}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }} data-name="ai-app-editor.block-rules-container">
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
                      onChange={() => void handleRuleToggle(rule)}
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
                    onClick={() => handleRuleEdit(rule)}
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
                      onClick={() => void handleRuleDelete(rule.id)}
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
                      onClick={() => void handleRuleSave()}
                      data-name="ai-app-editor.block-rule-form-save-button"
                    >
                      保存
                    </Button>
                    <Button
                      variant="outline"
                      className="prompt-btn"
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
                  style={{ alignSelf: 'flex-start' }}
                  data-name="ai-app-editor.block-rule-add-button"
                >
                  + 新增屏蔽规则
                </Button>
              )}
            </div>
          </FieldGroup>

          {/* 弹窗白名单（Profile 专属） */}
          <FieldGroup
            label="弹窗白名单（应用专属）"
            hint="允许这些域名弹独立窗口（登录/验证页等）。内置默认登录域（auth/accounts/passport 等）已自动合并，此处只需配置本应用额外的关联域。"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }} data-name="ai-app-editor.popup-whitelist-container">
              {popupWhitelist.length === 0 && (
                <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)', padding: 'var(--space-1) 0' }} data-name="ai-app-editor.popup-whitelist-empty">
                  暂无应用专属白名单（依赖内置默认登录域兜底）
                </div>
              )}
              {popupWhitelist.map((origin, wIdx) => (
                <div
                  key={wIdx}
                  data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}`}
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
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-text`}>
                    {origin}
                  </span>
                  <Button
                    variant="text"
                    danger
                    className="btn-secondary-underline danger"
                    onClick={() => setPopupWhitelist((prev) => prev.filter((_, i) => i !== wIdx))}
                    style={{ flexShrink: 0 }}
                    data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-delete-button`}
                  >
                    删除
                  </Button>
                </div>
              ))}

              {/* 新增输入 */}
              <div style={{ display: 'flex', gap: 'var(--space-1)' }} data-name="ai-app-editor.popup-whitelist-add">
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

/* =====================================================================
   子组件：自定义标题栏（重命名为 AiAppEditorTitleBar 以避免遮蔽共享 ui/TitleBar）
   ===================================================================== */
interface AiAppEditorTitleBarProps {
  title: string;
  maximized: boolean;
  isPinned: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onPin: () => void;
}

function AiAppEditorTitleBar({ title, maximized, isPinned, onMinimize, onMaximize, onClose, onPin }: AiAppEditorTitleBarProps) {
  return (
    <div className="prompt-view-top" data-name="ai-app-editor.topbar">
      <div className="prompt-view-top-drag" data-name="ai-app-editor.topbar-drag">
        <span className="prompt-view-top-title" data-name="ai-app-editor.topbar-title">{title}</span>
      </div>
      <div className="prompt-view-top-actions" data-name="ai-app-editor.topbar-actions">
        <IconButton
          type="button"
          variant={isPinned ? 'active' : 'default'}
          className="prompt-view-win-btn"
          onClick={onPin}
          title={isPinned ? '取消置顶' : '置顶'}
          aria-label={isPinned ? '取消置顶' : '置顶'}
          data-name="ai-app-editor.topbar-pin-button"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-pin-icon">
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </IconButton>
        <IconButton
          className="prompt-view-win-btn"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
          data-name="ai-app-editor.topbar-minimize-button"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-minimize-icon">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
        <IconButton
          className="prompt-view-win-btn"
          onClick={onMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label="最大化"
          data-name="ai-app-editor.topbar-maximize-button"
        >
          {maximized ? (
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-restore-icon">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-maximize-icon">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          )}
        </IconButton>
        <IconButton
          variant="close"
          className="prompt-view-win-btn"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          data-name="ai-app-editor.topbar-close-button"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-editor.topbar-close-icon">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}

/* =====================================================================
   子组件：字段分组（label + content）
   ===================================================================== */
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }} data-name="ai-app-editor.field-group">
      <label
        data-name="ai-app-editor.field-group-label"
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--muted-foreground)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </label>
      {hint && (
        <div
          data-name="ai-app-editor.field-group-hint"
          style={{
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
            opacity: 0.8,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
