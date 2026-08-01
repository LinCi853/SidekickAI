/* =====================================================================
   usePlatformUrlConfig —— 平台 URL 配置状态管理 hook
   从 AdvancedSection 抽离，供设置面板顶层直接调用。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AIPlatform, Profile } from '../lib/electron-api';
import { updateProfile } from '../lib/electron-api';
import { useProfileStore } from '../store/useProfileStore';
import { useTabStore } from '../store/useTabStore';

export interface PlatformUrlConfig {
  profiles: Profile[];
  openProfileIds: Set<string>;
  platformUrlDrafts: Record<string, string>;
  setPlatformUrlDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformDesktopUaDrafts: Record<string, string>;
  setPlatformDesktopUaDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformMobileUaDrafts: Record<string, string>;
  setPlatformMobileUaDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformThemeColorDrafts: Record<string, string>;
  setPlatformThemeColorDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformRegionDrafts: Record<string, 'cn' | 'global'>;
  setPlatformRegionDrafts: Dispatch<SetStateAction<Record<string, 'cn' | 'global'>>>;
  savingPlatformId: string | null;
  handleSavePlatform: (platform: AIPlatform) => Promise<void>;
  handleSwitchToPlatformTab: (platform: AIPlatform) => void;
}

export function usePlatformUrlConfig(platforms: AIPlatform[]): PlatformUrlConfig {
  const profiles = useProfileStore((s) => s.profiles);
  const tabs = useTabStore((s) => s.tabs);
  const openProfileIds = useMemo(() => new Set(tabs.map((t) => t.profileId).filter(Boolean)), [tabs]);

  const [platformUrlDrafts, setPlatformUrlDrafts] = useState<Record<string, string>>({});
  const [platformDesktopUaDrafts, setPlatformDesktopUaDrafts] = useState<Record<string, string>>({});
  const [platformMobileUaDrafts, setPlatformMobileUaDrafts] = useState<Record<string, string>>({});
  const [platformThemeColorDrafts, setPlatformThemeColorDrafts] = useState<Record<string, string>>({});
  const [platformRegionDrafts, setPlatformRegionDrafts] = useState<Record<string, 'cn' | 'global'>>({});
  const [savingPlatformId, setSavingPlatformId] = useState<string | null>(null);

  useEffect(() => {
    const urlDrafts: Record<string, string> = {};
    const desktopDrafts: Record<string, string> = {};
    const mobileDrafts: Record<string, string> = {};
    const colorDrafts: Record<string, string> = {};
    const regionDrafts: Record<string, 'cn' | 'global'> = {};
    for (const p of platforms) {
      const profile = profiles.find(
        (pr) => pr.isAIPlatform && (pr.aiPlatformId === p.id || pr.aiPlatformUrl === p.url),
      );
      urlDrafts[p.id] = profile?.aiPlatformUrl ?? p.url ?? '';
      desktopDrafts[p.id] = profile?.aiDesktopPreset ?? p.defaultDesktopPreset ?? '';
      mobileDrafts[p.id] = profile?.aiMobilePreset ?? p.defaultMobilePreset ?? '';
      colorDrafts[p.id] = profile?.aiThemeColor ?? p.themeColor ?? '';
      regionDrafts[p.id] = (profile?.aiPlatformRegion ?? p.region ?? 'cn') as 'cn' | 'global';
    }
    setPlatformUrlDrafts(urlDrafts);
    setPlatformDesktopUaDrafts(desktopDrafts);
    setPlatformMobileUaDrafts(mobileDrafts);
    setPlatformThemeColorDrafts(colorDrafts);
    setPlatformRegionDrafts(regionDrafts);
  }, [platforms, profiles]);

  const handleSavePlatform = useCallback(
    async (platform: AIPlatform) => {
      const profile = profiles.find(
        (pr) => pr.isAIPlatform && (pr.aiPlatformId === platform.id || pr.aiPlatformUrl === platform.url),
      );
      if (!profile) return;
      setSavingPlatformId(platform.id);
      try {
        const patch: Partial<Profile> = {
          aiPlatformUrl: platformUrlDrafts[platform.id]?.trim() || platform.url,
          aiDesktopPreset: platformDesktopUaDrafts[platform.id] || undefined,
          aiMobilePreset: platformMobileUaDrafts[platform.id] || undefined,
          aiThemeColor: platformThemeColorDrafts[platform.id] || undefined,
          aiPlatformRegion: platformRegionDrafts[platform.id] || platform.region,
        };
        await updateProfile(profile.id, patch);
      } catch (e) {
        console.error('[usePlatformUrlConfig] 保存平台配置失败:', e);
      } finally {
        setSavingPlatformId(null);
      }
    },
    [
      profiles,
      platformUrlDrafts,
      platformDesktopUaDrafts,
      platformMobileUaDrafts,
      platformThemeColorDrafts,
      platformRegionDrafts,
    ],
  );

  const handleSwitchToPlatformTab = useCallback(
    (platform: AIPlatform) => {
      const profile = profiles.find(
        (pr) => pr.isAIPlatform && (pr.aiPlatformId === platform.id || pr.aiPlatformUrl === platform.url),
      );
      if (!profile) return;
      useTabStore.getState().setActiveTab(profile.id);
    },
    [profiles],
  );

  return {
    profiles,
    openProfileIds,
    platformUrlDrafts,
    setPlatformUrlDrafts,
    platformDesktopUaDrafts,
    setPlatformDesktopUaDrafts,
    platformMobileUaDrafts,
    setPlatformMobileUaDrafts,
    platformThemeColorDrafts,
    setPlatformThemeColorDrafts,
    platformRegionDrafts,
    setPlatformRegionDrafts,
    savingPlatformId,
    handleSavePlatform,
    handleSwitchToPlatformTab,
  };
}
