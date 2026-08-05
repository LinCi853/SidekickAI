import { useEffect } from 'react';
import { getAppSettings, setMinimumSize } from '../../../lib/electron-api';
import { useUiVersionStore } from '../../../store/useUiVersionStore';
import { getOxyLayout } from '../../../lib/oxy-design-system';
import {
  calculateMainWindowMinWidth,
  calculateOxyMainWindowMinWidthByScale,
  MAIN_WINDOW_MIN_HEIGHT,
  type UiScale,
} from '../../../../electron/shared/window-size';
import type { TopBarButtonGroup } from '../../../../electron/shared/api.types';

/**
 * Dynamically update the window minimum width when the title or top-bar buttons change.
 */
export function useWindowMinWidth(
  activeTitle: string,
  topBarVisibleButtons: TopBarButtonGroup[],
) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getAppSettings();
        if (cancelled) return;
        const isOxy = useUiVersionStore.getState().version === 'oxy';
        if (isOxy) {
          const oxyLayout = getOxyLayout();
          if (oxyLayout) {
            const minWidth = calculateOxyMainWindowMinWidthByScale(oxyLayout.scale, topBarVisibleButtons, activeTitle);
            await setMinimumSize(minWidth, MAIN_WINDOW_MIN_HEIGHT);
            return;
          }
        }
        const uiScale = (cfg.uiScale ?? 'medium') as UiScale;
        const minWidth = calculateMainWindowMinWidth(uiScale, topBarVisibleButtons, activeTitle);
        await setMinimumSize(minWidth, MAIN_WINDOW_MIN_HEIGHT);
      } catch (e) {
        console.warn('[MainView] 标题变化更新 minWidth 失败:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTitle, topBarVisibleButtons]);
}
