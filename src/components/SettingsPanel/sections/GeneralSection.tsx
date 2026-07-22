import { updateAppSettings, listPresets, getAppSettings, clearUsageTraces } from '../../../lib/electron-api';
import type { DevicePreset } from '../../../lib/electron-api';
import { useEffect, useState } from 'react';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';

interface GeneralSectionProps {
  /** 启动时打开：home=平台首页 / lastConversation=最近对话地址 */
  startupOpen: 'home' | 'lastConversation';
  setStartupOpen: (v: 'home' | 'lastConversation') => void;
  /** 关闭按钮行为：close=直接关闭 / minimize=最小化到托盘 */
  closeBehavior: 'close' | 'minimize';
  setCloseBehavior: (v: 'close' | 'minimize') => void;
  /** Enter 键发送消息（Shift+Enter 换行） */
  enterToSend: boolean;
  setEnterToSend: (v: boolean) => void;
  /** 默认桌面端 UA 预设 id */
  defaultDesktopUaPreset: string;
  setDefaultDesktopUaPreset: (v: string) => void;
  /** 默认移动端 UA 预设 id */
  defaultMobileUaPreset: string;
  setDefaultMobileUaPreset: (v: string) => void;
  /** 点击已打开应用时的行为：switch=跳转 / close=关闭 */
  appClickBehavior: 'switch' | 'close';
  setAppClickBehavior: (v: 'switch' | 'close') => void;
  /** 使用统计与操作日志：记录启动时间 + data-name 点击日志（默认开） */
  usageTrackingEnabled: boolean;
  setUsageTrackingEnabled: (v: boolean) => void;
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

export default function GeneralSection({
  startupOpen,
  setStartupOpen,
  closeBehavior,
  setCloseBehavior,
  enterToSend,
  setEnterToSend,
  defaultDesktopUaPreset,
  setDefaultDesktopUaPreset,
  defaultMobileUaPreset,
  setDefaultMobileUaPreset,
  appClickBehavior,
  setAppClickBehavior,
  usageTrackingEnabled,
  setUsageTrackingEnabled,
}: GeneralSectionProps) {
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  // 开机自启动 / 静默启动（由本组件自行从主进程拉取，不经过父组件 props）
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [autoLaunchError, setAutoLaunchError] = useState(false);
  // 使用统计清除反馈
  const [usageClearFeedback, setUsageClearFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    listPresets().then(setPresets).catch((e) => console.error('[general] 加载预设失败:', e));
  }, []);

  useEffect(() => {
    getAppSettings()
      .then((cfg) => {
        setAutoLaunch(cfg.autoLaunch ?? false);
        setSilentStart(cfg.silentStart ?? false);
      })
      .catch((e) => console.error('[general] 加载自启动设置失败:', e));
  }, []);

  const desktopPresets = presets.filter((p) => p.platform === 'desktop');
  const mobilePresets = presets.filter((p) => p.platform === 'mobile');

  return (
    <section data-name="settings.general.section">
      <div className="settings-section-title" data-name="settings.general.title">通用</div>

      {/* 默认 UA 预设（用户自选桌面端 / 移动端 UA，数据来源于设备预设） */}
      <div className="voice-config-row" data-name="settings.general.desktop-ua-row">
        <label className="voice-config-label" data-name="settings.general.desktop-ua-label">
          <span className="voice-config-name" data-name="settings.general.desktop-ua-name">默认桌面端 UA</span>
        </label>
        <select
          className="ua-preset-select"
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
      </div>

      <div className="voice-config-row" data-name="settings.general.mobile-ua-row">
        <label className="voice-config-label" data-name="settings.general.mobile-ua-label">
          <span className="voice-config-name" data-name="settings.general.mobile-ua-name">默认移动端 UA</span>
        </label>
        <select
          className="ua-preset-select"
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
      </div>

      {/* 启动时打开：首页 / 最近对话 */}
      <div className="voice-config-row" data-name="settings.general.startup-open-row">
        <label className="voice-config-label" data-name="settings.general.startup-open-label">
          <span className="voice-config-name" data-name="settings.general.startup-open-name">启动时打开</span>
        </label>
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
      </div>

      {/* 关闭按钮行为 */}
      <div className="voice-config-row" data-name="settings.general.close-behavior-row">
        <label className="voice-config-label" data-name="settings.general.close-behavior-label">
          <span className="voice-config-name" data-name="settings.general.close-behavior-name">关闭按钮行为</span>
        </label>
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
      </div>

      {/* 点击已打开应用时的行为：跳转(默认) / 关闭 */}
      <div className="voice-config-row" data-name="settings.general.app-click-behavior-row">
        <label className="voice-config-label" data-name="settings.general.app-click-behavior-label">
          <span className="voice-config-name" data-name="settings.general.app-click-behavior-name">点击已打开应用时</span>
        </label>
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
      </div>

      {/* Enter 键发送消息 */}
      <div className="voice-config-row" data-name="settings.general.enter-to-send-row">
        <label className="voice-config-label" data-name="settings.general.enter-to-send-label">
          <span className="voice-config-name" data-name="settings.general.enter-to-send-name">Enter 键发送消息</span>
        </label>
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
      </div>

      {/* 开机自启动 */}
      <div className="voice-config-row" data-name="settings.general.auto-launch-row">
        <label className="voice-config-label" data-name="settings.general.auto-launch-label">
          <span className="voice-config-name" data-name="settings.general.auto-launch-name">开机自启动</span>
        </label>
        <Toggle
          checked={autoLaunch}
          onChange={async (next) => {
            setAutoLaunch(next);
            setAutoLaunchError(false);
            if (!next) setSilentStart(false);
            try {
              await updateAppSettings({ autoLaunch: next, silentStart: next ? undefined : false });
            } catch (e) {
              console.error('保存开机自启动设置失败:', e);
              setAutoLaunch(!next);
              setAutoLaunchError(true);
            }
          }}
          aria-label="开机自启动"
          data-name="settings.general.auto-launch-toggle"
        />
      </div>
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
        <div className="voice-config-row" data-name="settings.general.silent-start-row">
          <label className="voice-config-label" data-name="settings.general.silent-start-label">
            <span className="voice-config-name" data-name="settings.general.silent-start-name">静默启动</span>
            <span className="voice-config-hint" data-name="settings.general.silent-start-hint">开机时不显示主窗口，仅在托盘运行</span>
          </label>
          <Toggle
            checked={silentStart}
            onChange={async (next) => {
              setSilentStart(next);
              try {
                await updateAppSettings({ silentStart: next });
              } catch (e) {
                console.error('保存静默启动设置失败:', e);
                setSilentStart(!next);
              }
            }}
            aria-label="静默启动"
            data-name="settings.general.silent-start-toggle"
          />
        </div>
      )}

      {/* 使用统计与操作日志：记录启动时间 + data-name 点击日志，完全本地存储 */}
      <div className="voice-config-row" data-name="settings.general.usage-tracking-row">
        <label className="voice-config-label" data-name="settings.general.usage-tracking-label">
          <span className="voice-config-name" data-name="settings.general.usage-tracking-name">使用统计与操作日志</span>
          <span className="voice-config-hint" data-name="settings.general.usage-tracking-hint">记录启动时间与按钮点击频次，完全本地存储</span>
        </label>
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
      </div>
      {usageTrackingEnabled && (
        <div className="voice-config-row" data-name="settings.general.usage-clear-row">
          <label className="voice-config-label" data-name="settings.general.usage-clear-label">
            <span className="voice-config-name" data-name="settings.general.usage-clear-name">清除统计记录</span>
            <span className="voice-config-hint" data-name="settings.general.usage-clear-hint">清空所有启动时间与点击日志</span>
          </label>
          <button
            type="button"
            className="ua-preset-select"
            style={{ cursor: 'pointer', padding: '4px 12px' }}
            data-name="settings.general.usage-clear-button"
            onClick={async () => {
              try {
                const result = await clearUsageTraces();
                if (result.ok) {
                  setUsageClearFeedback({ type: 'success', msg: `已清除 ${result.count} 条记录` });
                } else {
                  setUsageClearFeedback({ type: 'error', msg: '清除失败' });
                }
                setTimeout(() => setUsageClearFeedback(null), 3000);
              } catch (e) {
                setUsageClearFeedback({ type: 'error', msg: '清除失败: ' + String(e) });
                setTimeout(() => setUsageClearFeedback(null), 3000);
              }
            }}
          >
            清除
          </button>
        </div>
      )}
      {usageClearFeedback && (
        <div
          style={{
            fontSize: 12,
            color: usageClearFeedback.type === 'success' ? 'var(--success, #22c55e)' : 'var(--danger)',
            lineHeight: 1.4,
            padding: '0 0 6px 0',
          }}
          data-name="settings.general.usage-clear-feedback"
        >
          {usageClearFeedback.msg}
        </div>
      )}
    </section>
  );
}
