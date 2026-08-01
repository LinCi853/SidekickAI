/* =====================================================================
   AdvancedSection —— 进阶配置面板
   仅收纳零散的高级设置：默认 UA 预设、Alt+Space 触发阈值、
   下载与缓存清理。
   AI 应用、供应商、平台 URL、语音、代理、设备预设、Cookie 等
   折叠子 section 已移至设置面板顶层作为独立 section。
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import type { DevicePreset } from '../../../lib/electron-api';
import { updateAppSettings } from '../../../lib/electron-api';
import { SectionTitle, FormRow, Combobox } from '../../ui';
import type { ComboboxOption } from '../../ui';
import StorageSection from './StorageSection';
import ProxySection from './ProxySection';
import CookieSection from './CookieSection';
import type { ProxySettings } from '../types';

interface AdvancedSectionProps {
  // 设备预设（用于 UA 选择器选项）
  presets: DevicePreset[];
  // Alt+Space 阈值
  altSpaceResetThreshold: number;
  onAltSpaceThresholdChange: (value: number) => Promise<void>;
  // 默认 UA 预设
  defaultDesktopUaPreset: string;
  defaultMobileUaPreset: string;
  onDefaultDesktopUaPresetChange: (value: string) => void;
  onDefaultMobileUaPresetChange: (value: string) => void;
  // 区域与代理（compact 模式下不渲染，由外部独立分类承载）
  proxy?: ProxySettings;
  onProxyChange?: (patch: Partial<ProxySettings>) => void;
  // compact 模式：跳过 ProxySection/CookieSection，避免与独立分类重复
  compact?: boolean;
}

export default function AdvancedSection({
  presets,
  altSpaceResetThreshold,
  onAltSpaceThresholdChange,
  defaultDesktopUaPreset,
  defaultMobileUaPreset,
  onDefaultDesktopUaPresetChange,
  onDefaultMobileUaPresetChange,
  proxy,
  onProxyChange,
  compact = false,
}: AdvancedSectionProps) {
  const [collapsed, setCollapsed] = useState(true);

  // ===== 默认 UA 预设 =====
  const desktopPresets = useMemo(() => presets.filter((p) => p.platform === 'desktop'), [presets]);
  const mobilePresets = useMemo(() => presets.filter((p) => p.platform === 'mobile'), [presets]);
  const desktopPlaceholder = desktopPresets.some((p) => p.id === defaultDesktopUaPreset)
    ? null
    : { id: defaultDesktopUaPreset, name: '（已失效，请重选）' };
  const mobilePlaceholder = mobilePresets.some((p) => p.id === defaultMobileUaPreset)
    ? null
    : { id: defaultMobileUaPreset, name: '（已失效，请重选）' };

  // ===== Alt+Space 阈值 =====
  const [thresholdDraft, setThresholdDraft] = useState<string>(String(altSpaceResetThreshold));
  useEffect(() => {
    setThresholdDraft(String(altSpaceResetThreshold));
  }, [altSpaceResetThreshold]);

  const handleThresholdBlur = () => {
    const parsed = parseInt(thresholdDraft, 10);
    if (!Number.isFinite(parsed)) {
      setThresholdDraft(String(altSpaceResetThreshold));
      return;
    }
    const clamped = Math.max(3, Math.min(20, parsed));
    setThresholdDraft(String(clamped));
    if (clamped !== altSpaceResetThreshold) {
      void onAltSpaceThresholdChange(clamped);
    }
  };

  return (
    <section data-name="settings.advanced.section">
      <SectionTitle
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      >
        进阶配置
      </SectionTitle>

      {!collapsed && (
        <div className="advanced-section-content" data-name="settings.advanced.content">
          {/* 默认 UA 预设 */}
          <FormRow label="默认桌面端 UA" mutedLabel>
            <Combobox
              inputValue={
                desktopPlaceholder
                  ? desktopPlaceholder.name
                  : desktopPresets.find((p) => p.id === defaultDesktopUaPreset)?.name ?? ''
              }
              onInputChange={() => {}}
              inputPlaceholder="选择桌面端 UA"
              inputClassName="input-underline ua-preset-select"
              inputReadOnly
              options={desktopPresets.map<ComboboxOption>((p) => ({
                value: p.id,
                label: p.name,
                selected: p.id === defaultDesktopUaPreset,
              }))}
              onSelect={async (v) => {
                onDefaultDesktopUaPresetChange(v);
                try {
                  await updateAppSettings({ defaultDesktopUaPreset: v });
                } catch (err) {
                  console.error('保存默认桌面端 UA 失败:', err);
                }
              }}
              searchable
              searchPlaceholder="搜索 UA 预设…"
              emptyText="无匹配预设"
              dataName="settings.advanced.desktop-ua-select"
            />
          </FormRow>
          <FormRow label="默认移动端 UA" mutedLabel>
            <Combobox
              inputValue={
                mobilePlaceholder
                  ? mobilePlaceholder.name
                  : mobilePresets.find((p) => p.id === defaultMobileUaPreset)?.name ?? ''
              }
              onInputChange={() => {}}
              inputPlaceholder="选择移动端 UA"
              inputClassName="input-underline ua-preset-select"
              inputReadOnly
              options={mobilePresets.map<ComboboxOption>((p) => ({
                value: p.id,
                label: p.name,
                selected: p.id === defaultMobileUaPreset,
              }))}
              onSelect={async (v) => {
                onDefaultMobileUaPresetChange(v);
                try {
                  await updateAppSettings({ defaultMobileUaPreset: v });
                } catch (err) {
                  console.error('保存默认移动端 UA 失败:', err);
                }
              }}
              searchable
              searchPlaceholder="搜索 UA 预设…"
              emptyText="无匹配预设"
              dataName="settings.advanced.mobile-ua-select"
            />
          </FormRow>

          {/* 下载与缓存清理 */}
          <StorageSection />

          {/* 区域与代理（compact 模式下由独立分类承载，不在此渲染） */}
          {!compact && proxy && onProxyChange && (
            <ProxySection proxy={proxy} onChange={onProxyChange} />
          )}

          {/* Cookie 弹窗处理（compact 模式下由独立分类承载，不在此渲染） */}
          {!compact && <CookieSection />}

          {/* Alt+Space 位置恢复触发次数 */}
          <FormRow label="Alt+Space 位置恢复触发次数" mutedLabel>
            <input
              type="number"
              className="input-underline hotkey-threshold-input"
              min={3}
              max={20}
              value={thresholdDraft}
              onChange={(e) => setThresholdDraft(e.target.value)}
              onBlur={handleThresholdBlur}
              data-name="settings.advanced.alt-space-threshold-input"
            />
          </FormRow>
        </div>
      )}
    </section>
  );
}
