import { useEffect } from 'react';
import { useUiVersionStore } from '../../../store/useUiVersionStore';
import { applyAppTheme } from '../../../lib/oxy-design-system';
import { broadcastThemeColorChanged } from '../../../lib/electron-api';
import { getPlatformColors } from '../utils';
import type { AIPlatform, Profile } from '../../../lib/electron-api';

interface Tab {
  id: string;
  profileId: string;
}

/**
 * Inject the active app's brand color as the Oxy theme color on tab switch.
 * Only active when UI version is 'oxy'.
 * Broadcasts the color change to all other windows.
 */
export function useOxyTheme(
  activeTabId: string | null,
  tabs: Tab[],
  profiles: Profile[],
  platforms: AIPlatform[],
) {
  const uiVersion = useUiVersionStore((s) => s.version);
  const isOxy = uiVersion === 'oxy';

  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const profile = profiles.find((p) => p.id === tab.profileId);
    const platform = profile?.isAIPlatform
      ? platforms.find((p) => p.id === profile.aiPlatformId || p.url === profile.aiPlatformUrl)
      : null;
    const { themeColor } = getPlatformColors(profile, platform, tab.profileId);
    // Oxy 模式下应用主题色到当前窗口并广播
    if (isOxy) {
      applyAppTheme(themeColor);
      broadcastThemeColorChanged(themeColor);
    }
  }, [isOxy, activeTabId, tabs, profiles, platforms]);

  return { isOxy };
}
