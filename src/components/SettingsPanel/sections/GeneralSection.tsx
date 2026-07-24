import { updateAppSettings, listPresets, clearUsageTraces } from '../../../lib/electron-api';
import type { DevicePreset } from '../../../lib/electron-api';
import { useEffect, useState } from 'react';
import { useSettingsDraft } from '../../../hooks/useSettingsData';
import { useFeedbackToast } from '../../../hooks/useFeedbackToast';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';
import type { GeneralSettings } from '../types';

interface GeneralSectionProps {
  general: GeneralSettings;
  onChange: (patch: Partial<GeneralSettings>) => void;
}

const CLOSE_OPTIONS: Array<{ value: 'close' | 'minimize'; label: string }> = [
  { value: 'close', label: '直接关闭' },
  { value: 'minimize', label: '最小化到托盘' },
];

const STARTUP_OPEN_OPTIONS: Array<{ value: 'home' | 'lastConversation'; label: string }> = [
  { value: 'home', label: '首页' },
  { value: 'lastConversation', label: '最近对话' },
];

const APP_CLICK_OPTIONS: Array<{ value: 'switch' | 'close'; label: string }> = [
  { value: 'switch', label: '跳转' },
  { value: 'close', label: '关闭' },
];

export default function GeneralSection({ general, onChange }: GeneralSectionProps) {
  // 重命名解构：保持内部代码对字段名的引用不变，避免大量改动
  const {
    startupOpen,
    closeBehavior,
    enterToSend,
    defaultDesktopUaPreset,
    defaultMobileUaPreset,
    appClickBehavior,
    usageTrackingEnabled,
  } = general;

  // setter 包装：仅更新父组件本地 state（即时 UI 反馈），持久化由本 Section 内部 updateAppSettings 完成
  const setStartupOpen = (v: 'home' | 'lastConversation') => onChange({ startupOpen: v });
  const setCloseBehavior = (v: 'close' | 'minimize') => onChange({ closeBehavior: v });
  const setEnterToSend = (v: boolean) => onChange({ enterToSend: v });
  const setDefaultDesktopUaPreset = (v: string) => onChange({ defaultDesktopUaPreset: v });
  const setDefaultMobileUaPreset = (v: string) => onChange({ defaultMobileUaPreset: v });
  const setAppClickBehavior = (v: 'switch' | 'close') => onChange({ appClickBehavior: v });
  const setUsageTrackingEnabled = (v: boolean) => onChange({ usageTrackingEnabled: v });
  const { draft, setDraft } = useSettingsDraft();
  // 使用统计清除反馈（带自动清除的字符串消息 + 独立的 success/error 类型，用于颜色区分）
  const { feedback: usageClearMsg, showFeedback: showUsageToast } = useFeedbackToast(3000);
  const [usageClearType, setUsageClearType] = useState<'success' | 'error'>('success');
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  // 开机自启动 / 静默启动（通过 useSettingsDraft 从主进程加载，不经过父组件 props）
  const autoLaunch = draft?.autoLaunch ?? false;
  const silentStart = draft?.silentStart ?? false;
  const [autoLaunchError, setAutoLaunchError] = useState(false);

  const showUsageFeedback = (type: 'success' | 'error', msg: string) => {
    setUsageClearType(type);
    showUsageToast(msg);
  };

  useEffect(() => {
    listPresets().then(setPresets).catch((e) => console.error('[general] 加载预设失败:', e));
  }, []);

  const desktopPresets = presets.filter((p) => p.platform === 'desktop');
  const mobilePresets = presets.filter((p) => p.platform === 'mobile');

  return (
    <section data-name="settings.general.section">
      <SectionTitle>通用</SectionTitle>

      {/* 默认 UA 预设（用户自选桌面端 / 移动端 UA，数据来源于设备预设） */}
      <FormRow label="默认桌面端 UA">
        <select
          className="ua-preset-select input-underline"
          value={defaultDesktopUaPreset}
          onChange={async (e) => {
            const next = e.target.value;
            setDefaultDesktopUaPreset(next);
            try {
              await updateAppSettings({ defaultDesktopUaPreset: next });
            } catch (err) {
              console.error('保存默认桌面端 UA 失败:', err);
            }
          }}
          data-name="settings.general.desktop-ua-select"
        >
          {desktopPresets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormRow>

      <FormRow label="默认移动端 UA">
        <select
          className="ua-preset-select input-underline"
          value={defaultMobileUaPreset}
          onChange={async (e) => {
            const next = e.target.value;
            setDefaultMobileUaPreset(next);
            try {
              await updateAppSettings({ defaultMobileUaPreset: next });
            } catch (err) {
              console.error('保存默认移动端 UA 失败:', err);
            }
          }}
          data-name="settings.general.mobile-ua-select"
        >
          {mobilePresets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormRow>

      {/* 启动时打开：首页 / 最近对话 */}
      <FormRow label="启动时打开">
        <SegmentedControl
          value={startupOpen}
          options={STARTUP_OPEN_OPTIONS}
          onChange={async (v) => {
            setStartupOpen(v);
            try {
              await updateAppSettings({ startupOpen: v });
            } catch (e) {
              console.error('保存启动时打开设置失败:', e);
            }
          }}
          name="启动时打开"
          className="proxy-mode-group"
        />
      </FormRow>

      {/* 关闭按钮行为 */}
      <FormRow label="关闭按钮行为">
        <SegmentedControl
          value={closeBehavior}
          options={CLOSE_OPTIONS}
          onChange={async (v) => {
            setCloseBehavior(v);
            try {
              await updateAppSettings({ closeBehavior: v });
            } catch (e) {
              console.error('保存关闭行为设置失败:', e);
            }
          }}
          name="关闭按钮行为"
          className="proxy-mode-group"
        />
      </FormRow>

      {/* 点击已打开应用时的行为：跳转(默认) / 关闭 */}
      <FormRow label="点击已打开应用时">
        <SegmentedControl
          value={appClickBehavior}
          options={APP_CLICK_OPTIONS}
          onChange={async (v) => {
            setAppClickBehavior(v);
            try {
              await updateAppSettings({ appClickBehavior: v });
            } catch (e) {
              console.error('保存点击应用行为设置失败:', e);
            }
          }}
          name="点击已打开应用时"
          className="proxy-mode-group"
        />
      </FormRow>

      {/* Enter 键发送消息 */}
      <FormRow label="Enter 键发送消息">
        <Toggle
          checked={enterToSend}
          onChange={async (next) => {
            setEnterToSend(next);
            try {
              await updateAppSettings({ enterToSend: next });
            } catch (e) {
              console.error('保存 Enter 发送设置失败:', e);
              setEnterToSend(!next);
            }
          }}
          aria-label="Enter 键发送消息"
          data-name="settings.general.enter-to-send-toggle"
        />
      </FormRow>

      {/* 开机自启动 */}
      <FormRow label="开机自启动">
        <Toggle
          checked={autoLaunch}
          onChange={async (next) => {
            setAutoLaunchError(false);
            if (!next) {
              setDraft({ autoLaunch: next, silentStart: false });
            } else {
              setDraft({ autoLaunch: next });
            }
            try {
              await updateAppSettings({ autoLaunch: next, silentStart: next ? undefined : false });
            } catch (e) {
              console.error('保存开机自启动设置失败:', e);
              setDraft({ autoLaunch: !next });
              setAutoLaunchError(true);
            }
          }}
          aria-label="开机自启动"
          data-name="settings.general.auto-launch-toggle"
        />
      </FormRow>
      {autoLaunchError && (
        <div
          style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.4, padding: '0 0 6px 0' }}
          data-name="settings.general.auto-launch-error"
        >
          设置失败，请在系统设置中允许本应用修改自启动配置，或将程序快捷方式拖入「启动」文件夹。
        </div>
      )}

      {/* 静默启动：仅当开机自启动开启时显示 */}
      {autoLaunch && (
        <FormRow label="静默启动" hint="开机时不显示主窗口，仅在托盘运行">
          <Toggle
            checked={silentStart}
            onChange={async (next) => {
              setDraft({ silentStart: next });
              try {
                await updateAppSettings({ silentStart: next });
              } catch (e) {
                console.error('保存静默启动设置失败:', e);
                setDraft({ silentStart: !next });
              }
            }}
            aria-label="静默启动"
            data-name="settings.general.silent-start-toggle"
          />
        </FormRow>
      )}

      {/* 使用统计与操作日志：记录启动时间 + data-name 点击日志，完全本地存储 */}
      <FormRow label="使用统计与操作日志" hint="记录启动时间与按钮点击频次，完全本地存储">
        <Toggle
          checked={usageTrackingEnabled}
          onChange={async (next) => {
            setUsageTrackingEnabled(next);
            try {
              await updateAppSettings({ usageTrackingEnabled: next });
            } catch (e) {
              console.error('保存使用统计设置失败:', e);
              setUsageTrackingEnabled(!next);
            }
          }}
          aria-label="使用统计与操作日志"
          data-name="settings.general.usage-tracking-toggle"
        />
      </FormRow>
      {usageTrackingEnabled && (
        <FormRow label="清除统计记录" hint="清空所有启动时间与点击日志">
          <button
            type="button"
            className="ua-preset-select input-underline"
            style={{ cursor: 'pointer', padding: '4px 12px' }}
            data-name="settings.general.usage-clear-button"
            onClick={async () => {
              try {
                const result = await clearUsageTraces();
                if (result.ok) {
                  showUsageFeedback('success', `已清除 ${result.count} 条记录`);
                } else {
                  showUsageFeedback('error', '清除失败');
                }
              } catch (e) {
                showUsageFeedback('error', '清除失败: ' + String(e));
              }
            }}
          >
            清除
          </button>
        </FormRow>
      )}
      {usageClearMsg && (
        <div
          style={{
            fontSize: 12,
            color: usageClearType === 'success' ? 'var(--success, #22c55e)' : 'var(--danger)',
            lineHeight: 1.4,
            padding: '0 0 6px 0',
          }}
          data-name="settings.general.usage-clear-feedback"
        >
          {usageClearMsg}
        </div>
      )}
    </section>
  );
}
