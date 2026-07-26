import { updateAppSettings } from '../../../lib/electron-api';
import { useThemeStore, type ThemeMode } from '../../../store/useThemeStore';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';

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
      <SectionTitle>外观</SectionTitle>

      {/* 主题模式 */}
      <FormRow label="主题">
        <SegmentedControl
          value={theme}
          options={THEME_OPTIONS}
          onChange={(v) => setTheme(v)}
          name="主题"
          className="seg-control-row"
        />
      </FormRow>

      {/* UI 比例（三档：紧凑/中档/大号） */}
      <FormRow label="UI 比例">
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
          className="seg-control-row"
        />
      </FormRow>

      {/* 标签栏自动收起 */}
      <FormRow label="标签栏收起">
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
      </FormRow>
    </section>
  );
}
