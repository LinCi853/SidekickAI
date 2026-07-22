import { updateAppSettings } from '../../../lib/electron-api';
import { useThemeStore, type ThemeMode } from '../../../store/useThemeStore';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';

interface AppearanceSectionProps {
  /** 标签栏是否默认收起 */
  tabBarCollapsed: boolean;
  setTabBarCollapsed: (v: boolean) => void;
  /** UI 比例：small/medium/large */
  uiScale: 'small' | 'medium' | 'large';
  setUiScale: (v: 'small' | 'medium' | 'large') => void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
];

const UI_SCALE_OPTIONS: Array<{ value: 'small' | 'medium' | 'large'; label: string }> = [
  { value: 'small', label: '紧凑' },
  { value: 'medium', label: '中档' },
  { value: 'large', label: '大号' },
];

export default function AppearanceSection({
  tabBarCollapsed,
  setTabBarCollapsed,
  uiScale,
  setUiScale,
}: AppearanceSectionProps) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <section data-name="settings.appearance.section">
      <div className="settings-section-title" data-name="settings.appearance.title">外观</div>

      {/* 主题模式 */}
      <div className="voice-config-row" data-name="settings.appearance.theme-row">
        <label className="voice-config-label" data-name="settings.appearance.theme-label">
          <span className="voice-config-name" data-name="settings.appearance.theme-name">主题</span>
        </label>
        <SegmentedControl
          value={theme}
          options={THEME_OPTIONS}
          onChange={(v) => setTheme(v)}
          name="主题"
          className="proxy-mode-group"
        />
      </div>

      {/* UI 比例（三档：紧凑/中档/大号） */}
      <div className="voice-config-row" data-name="settings.appearance.ui-scale-row">
        <label className="voice-config-label" data-name="settings.appearance.ui-scale-label">
          <span className="voice-config-name" data-name="settings.appearance.ui-scale-name">UI 比例</span>
        </label>
        <SegmentedControl
          value={uiScale}
          options={UI_SCALE_OPTIONS}
          onChange={async (v) => {
            setUiScale(v);
            document.documentElement.setAttribute('data-ui-scale', v);
            try {
              await updateAppSettings({ uiScale: v });
            } catch (e) {
              console.error('保存 UI 比例失败:', e);
            }
          }}
          name="UI 比例"
          className="proxy-mode-group"
        />
      </div>

      {/* 标签栏自动收起 */}
      <div className="voice-config-row" data-name="settings.appearance.tab-bar-collapsed-row">
        <label className="voice-config-label" data-name="settings.appearance.tab-bar-collapsed-label">
          <span className="voice-config-name" data-name="settings.appearance.tab-bar-collapsed-name">标签栏收起</span>
        </label>
        <Toggle
          checked={tabBarCollapsed}
          onChange={async (next) => {
            setTabBarCollapsed(next);
            try {
              await updateAppSettings({ tabBarCollapsed: next });
            } catch (e) {
              console.error('保存标签栏收起设置失败:', e);
              setTabBarCollapsed(!next);
            }
          }}
          aria-label="标签栏收起"
          data-name="settings.appearance.tab-bar-collapsed-toggle"
        />
      </div>
    </section>
  );
}
