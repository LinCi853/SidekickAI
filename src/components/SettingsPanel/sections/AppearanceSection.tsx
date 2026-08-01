import { updateAppSettings } from '../../../lib/electron-api';
import { useThemeStore, type ThemeMode } from '../../../store/useThemeStore';
import { useUiVersionStore } from '../../../store/useUiVersionStore';
import {
  detectUiScale,
  persistUserUiScale,
  readUserUiScale,
  type UiScale,
} from '../../../lib/oxy-design-system';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';

interface AppearanceSectionProps {
  /** 标签栏是否默认收起 */
  tabBarCollapsed: boolean;
  setTabBarCollapsed: (v: boolean) => void;
  /** UI 比例：small/medium/large（经典版使用） */
  uiScale: UiScale;
  setUiScale: (v: UiScale) => void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
];

const UI_SCALE_OPTIONS: Array<{ value: UiScale; label: string }> = [
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
  const uiVersion = useUiVersionStore((s) => s.version);
  const setUiVersion = useUiVersionStore((s) => s.setVersion);

  const isOxy = uiVersion === 'oxy';

  const handleOxyToggle = async (next: boolean) => {
    if (next) {
      // 开启 Oxy：控制器会自动处理主题、UI 比例、监听器
      setUiVersion('oxy');
    } else {
      // 关闭 Oxy：恢复用户之前的手动 UI 比例
      const saved = readUserUiScale();
      setUiScale(saved);
      document.documentElement.setAttribute('data-ui-scale', saved);
      setUiVersion('classic');
    }
  };

  const handleUiScaleChange = async (v: UiScale) => {
    setUiScale(v);
    persistUserUiScale(v);
    document.documentElement.setAttribute('data-ui-scale', v);
    try {
      await updateAppSettings({ uiScale: v });
    } catch (e) {
      console.error('保存 UI 比例失败:', e);
    }
  };

  return (
    <section data-name="settings.appearance.section">
      <SectionTitle>外观</SectionTitle>

      {/* Oxy Design System 开关 */}
      <FormRow label="Oxy Design System">
        <Toggle
          checked={isOxy}
          onChange={handleOxyToggle}
          aria-label="Oxy Design System"
          data-name="settings.appearance.oxy-toggle"
        />
      </FormRow>

      {/* 经典版专属选项：主题模式 + UI 比例（Oxy 开启时隐藏，由系统自动管理） */}
      {!isOxy && (
        <>
          <FormRow label="主题">
            <SegmentedControl
              value={theme}
              options={THEME_OPTIONS}
              onChange={(v) => setTheme(v)}
              name="主题"
              className="seg-control-row"
            />
          </FormRow>

          <FormRow label="UI 比例">
            <SegmentedControl
              value={uiScale}
              options={UI_SCALE_OPTIONS}
              onChange={handleUiScaleChange}
              name="UI 比例"
              className="seg-control-row"
            />
          </FormRow>
        </>
      )}

      {/* 标签栏自动收起（Oxy 模式下隐藏，由系统强制收起） */}
      {!isOxy && (
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
      )}
    </section>
  );
}
