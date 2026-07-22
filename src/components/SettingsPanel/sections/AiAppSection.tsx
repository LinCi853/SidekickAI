/* =====================================================================
   AiAppSection —— AI 应用区块（内置 Profile 展示 + 管理）
   默认收起；展开后展示内置 AI 应用 Profile 卡片列表（按 profile 遍历，支持同一平台多实例）。
   支持卡片编辑/复制/删除（带二次确认）+ 顶部新建 AI 应用（直接打开空白编辑器自由配置）。

   卡片采用「单行紧凑结构」：图标 + 名称/URL + 操作按钮，一行展示完毕。

   折叠标题复用 settings-section-title-row（与全局热键等区块样式一致）；
   开关项复用 voice-config-row 行布局。

   「屏蔽国外模型」开关位于折叠头下方第一个控件；
   开启时 region === 'global' 的内置平台卡片完全不渲染（按 profile 反向匹配平台 region 过滤）。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AIPlatform, Profile } from '../../../lib/electron-api';
import { openAiAppEditor } from '../../../lib/electron-api';
import { getPlatformColors } from '../../../pages/MainView/utils';
import { findAiAppProfiles } from '../../../lib/shared-utils';
import { useProfileStore } from '../../../store/useProfileStore';
import Button from '../../ui/Button';
import Toggle from '../../ui/Toggle';

/** pending 删除确认超时时间（ms）：超时未第二次点击则取消删除 */
const PENDING_DELETE_TIMEOUT_MS = 3000;

/** 从 URL 提取最短显示形式（hostname，去掉 www. 前缀） */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface AiAppSectionProps {
  platforms: AIPlatform[];
  onEditApp: (profileId: string) => void;
  hideForeignModels: boolean;
  onToggleHideForeignModels: () => void;
}

export default function AiAppSection({
  platforms,
  onEditApp,
  hideForeignModels,
  onToggleHideForeignModels,
}: AiAppSectionProps) {
  const [collapsed, setCollapsed] = useState(true);

  const profiles = useProfileStore((s) => s.profiles);

  // 扁平遍历所有 AI 应用 Profile（按 order 升序）
  const allAiAppProfiles = useMemo(() => findAiAppProfiles(profiles), [profiles]);

  // 国外模型被屏蔽时按 profile 反向匹配平台 region 过滤（用户决策：完全不渲染）
  const aiAppProfiles = useMemo(() => {
    if (!hideForeignModels) return allAiAppProfiles;
    // 仅保留其对应平台 region !== 'global' 的 profile
    return allAiAppProfiles.filter((profile) => {
      const platform = profile.aiPlatformId
        ? platforms.find((pp) => pp.id === profile.aiPlatformId)
        : platforms.find((pp) => pp.url === profile.aiPlatformUrl);
      return platform != null && platform.region !== 'global';
    });
  }, [allAiAppProfiles, platforms, hideForeignModels]);

  const totalCount = aiAppProfiles.length;

  // ===== 删除二次确认状态（与 BottomBar/AppSwitcher 的 pendingClose 模式一致） =====
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingDelete = useCallback(() => {
    if (pendingDeleteTimerRef.current) {
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    setPendingDeleteId(null);
  }, []);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (pendingDeleteTimerRef.current) {
        clearTimeout(pendingDeleteTimerRef.current);
        pendingDeleteTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 删除按钮点击包装：第一次点击进入 pending 状态（按钮文案变为"确认删除"+红色高亮），
   * 3 秒内再次点击才真正调用 deleteProfile 持久化；超时自动取消 pending。
   */
  const handleDelete = useCallback(
    (profile: Profile) => {
      if (pendingDeleteId === profile.id) {
        // 3 秒内第二次点击：执行删除
        clearPendingDelete();
        void useProfileStore.getState().deleteProfile(profile.id).catch((e) => {
          console.error('[AiAppSection] 删除 Profile 失败:', e);
        });
      } else {
        // 第一次点击：设置 pending 状态，3 秒后超时取消
        setPendingDeleteId(profile.id);
        if (pendingDeleteTimerRef.current) clearTimeout(pendingDeleteTimerRef.current);
        pendingDeleteTimerRef.current = setTimeout(() => {
          pendingDeleteTimerRef.current = null;
          setPendingDeleteId(null);
        }, PENDING_DELETE_TIMEOUT_MS);
      }
    },
    [pendingDeleteId, clearPendingDelete],
  );

  /** 复制 Profile：调用 store.duplicateProfile，成功后由 onProfileCreated 监听器自动追加 */
  const handleDuplicate = useCallback(async (profile: Profile) => {
    try {
      await useProfileStore.getState().duplicateProfile(profile.id);
    } catch (e) {
      console.error('[AiAppSection] 复制 Profile 失败:', e);
    }
  }, []);

  /** 新建 AI 应用：直接打开空白编辑器（mode='create'），用户自由配置所有字段后保存 */
  const handleCreateNew = useCallback(() => {
    void openAiAppEditor({ mode: 'create' }).catch((e) =>
      console.error('[AiAppSection] 打开新建编辑器失败:', e),
    );
  }, []);

  return (
    <section data-name="settings.ai-app.section">
      <div
        className="settings-section-title-row collapsible"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
        data-name="settings.ai-app.title-row"
      >
        <span className="settings-section-title" data-name="settings.ai-app.title">
          AI 应用（{totalCount}）
        </span>
        <span className={`collapse-toggle-icon${!collapsed ? ' expanded' : ''}`} data-name="settings.ai-app.collapse-icon">▼</span>
      </div>
      {!collapsed && (
        <>
          <div className="voice-config-row" data-name="settings.ai-app.hide-foreign-models-row">
            <label className="voice-config-label" data-name="settings.ai-app.hide-foreign-models-label">
              <span className="voice-config-name" data-name="settings.ai-app.hide-foreign-models-name">屏蔽国外模型</span>
            </label>
            <Toggle
              checked={hideForeignModels}
              onChange={onToggleHideForeignModels}
              aria-label="屏蔽国外模型"
              data-name="settings.ai-app.hide-foreign-models-toggle"
            />
          </div>

          {/* 新建 AI 应用入口：直接打开空白编辑器自由配置 */}
          <div className="ai-app-create-row" data-name="settings.ai-app.create-row">
            <button
              type="button"
              className="btn-text"
              style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
              onClick={handleCreateNew}
              title="打开空白编辑器，自由配置新 AI 应用的所有字段后创建"
              data-name="settings.ai-app.create-button"
            >
              + 新建 AI 应用
            </button>
          </div>

          {/* 内置 AI 应用 Profile 卡片列表（单行紧凑结构） */}
          {aiAppProfiles.length > 0 && (
            <div className="ai-app-card-list" data-name="settings.ai-app.app-card-list">
              {aiAppProfiles.map((profile, idx) => {
                const platform = profile.aiPlatformId
                  ? platforms.find((pp) => pp.id === profile.aiPlatformId)
                  : platforms.find((pp) => pp.url === profile.aiPlatformUrl);
                const { themeColor: c1, gradientColor: c2 } = platform
                  ? getPlatformColors(profile, platform, platform.id)
                  : { themeColor: 'var(--accent)', gradientColor: 'var(--accent)' };
                const displayName = profile.name || platform?.name || 'AI';
                const displayUrl = platform?.url ?? profile.aiPlatformUrl ?? '';
                const isPendingDelete = pendingDeleteId === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={`preset-card ai-app-card${isPendingDelete ? ' pending-delete' : ''}`}
                    style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, padding: '6px 8px' }}
                    data-name={`settings.ai-app.app-card-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={profile.id}
                  >
                    <span
                      className="ai-app-card-icon"
                      style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, width: 28, height: 28, minWidth: 28, fontSize: 12, borderRadius: 6 }}
                      aria-hidden="true"
                      data-name={`settings.ai-app.app-card-${idx + 1}-icon`}
                    >
                      {displayName.charAt(0).toUpperCase()}
                    </span>
                    <span className="ai-app-card-info" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0, overflow: 'hidden' }} data-name={`settings.ai-app.app-card-${idx + 1}-info`}>
                      <span className="ai-app-card-name" style={{ fontSize: 13, fontWeight: 600, lineHeight: '18px' }} data-name={`settings.ai-app.app-card-${idx + 1}-name`}>{displayName}</span>
                      <span className="ai-app-card-url" style={{ fontSize: 11, color: 'var(--muted-foreground)', lineHeight: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-name={`settings.ai-app.app-card-${idx + 1}-url`}>{shortUrl(displayUrl)}</span>
                    </span>
                    <div style={{ display: 'flex', gap: 0, flexShrink: 0 }} data-name={`settings.ai-app.app-card-${idx + 1}-actions`}>
                      <Button
                        variant="text"
                        className="provider-action-btn"
                        onClick={() => onEditApp(profile.id)}
                        title="打开编辑器自由配置"
                        style={{ padding: '2px 6px', fontSize: 12 }}
                        data-name={`settings.ai-app.app-card-${idx + 1}-edit-button`}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="text"
                        className="provider-action-btn"
                        onClick={() => void handleDuplicate(profile)}
                        title={`复制 ${displayName}`}
                        style={{ padding: '2px 6px', fontSize: 12 }}
                        data-name={`settings.ai-app.app-card-${idx + 1}-duplicate-button`}
                      >
                        复制
                      </Button>
                      <Button
                        variant="text"
                        danger
                        className="provider-action-btn"
                        onClick={() => handleDelete(profile)}
                        title={isPendingDelete ? '再次点击确认删除' : `删除 ${displayName}`}
                        style={{ padding: '2px 6px', fontSize: 12 }}
                        data-name={`settings.ai-app.app-card-${idx + 1}-delete-button`}
                      >
                        {isPendingDelete ? '确认' : '删除'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
