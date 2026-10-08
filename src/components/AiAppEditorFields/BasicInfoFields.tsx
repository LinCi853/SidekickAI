import type { Dispatch, SetStateAction } from 'react';
import { Combobox } from '../ui';
import type { ComboboxOption } from '../ui';
import SegmentedControl from '../ui/SegmentedControl';
import type { AIPlatform, DevicePreset } from '../../lib/electron-api';
import { isValidHexColor } from '../../pages/AiAppEditor/domain';
import { FieldGroup } from './FieldGroup';

export interface BasicInfoFieldsProps {
  /** Platform defaults; null for a custom application. */
  platform: AIPlatform | null;
  desktopPresets: DevicePreset[];
  mobilePresets: DevicePreset[];
  aiPlatformName: string;
  setAiPlatformName: Dispatch<SetStateAction<string>>;
  aiPlatformUrl: string;
  setAiPlatformUrl: Dispatch<SetStateAction<string>>;
  browserHomePage: string;
  setBrowserHomePage: Dispatch<SetStateAction<string>>;
  aiDesktopPreset: string;
  setAiDesktopPreset: Dispatch<SetStateAction<string>>;
  aiMobilePreset: string;
  setAiMobilePreset: Dispatch<SetStateAction<string>>;
  aiInputSelector: string;
  setAiInputSelector: Dispatch<SetStateAction<string>>;
  aiSendSelector: string;
  setAiSendSelector: Dispatch<SetStateAction<string>>;
  aiThemeColor: string;
  setAiThemeColor: Dispatch<SetStateAction<string>>;
  aiPlatformRegion: 'cn' | 'global';
  setAiPlatformRegion: Dispatch<SetStateAction<'cn' | 'global'>>;
}

export function BasicInfoFields({
  platform,
  desktopPresets,
  mobilePresets,
  aiPlatformName,
  setAiPlatformName,
  aiPlatformUrl,
  setAiPlatformUrl,
  browserHomePage,
  setBrowserHomePage,
  aiDesktopPreset,
  setAiDesktopPreset,
  aiMobilePreset,
  setAiMobilePreset,
  aiInputSelector,
  setAiInputSelector,
  aiSendSelector,
  setAiSendSelector,
  aiThemeColor,
  setAiThemeColor,
  aiPlatformRegion,
  setAiPlatformRegion,
}: BasicInfoFieldsProps) {
  return (
    <>
      <FieldGroup label="应用名称">
        <input
          type="text"
          className="ai-editor-input"
          value={aiPlatformName}
          onChange={(e) => setAiPlatformName(e.target.value)}
          placeholder={platform?.name ?? '输入应用名称'}
          data-name="ai-app-editor.name-input"
        />
      </FieldGroup>

      <FieldGroup label="平台 URL">
        <input
          type="text"
          className="ai-editor-input"
          value={aiPlatformUrl}
          onChange={(e) => setAiPlatformUrl(e.target.value)}
          placeholder="https://chat.example.com"
          data-name="ai-app-editor.url-input"
        />
      </FieldGroup>

      <FieldGroup label="浏览器主页">
        <input
          type="text"
          className="ai-editor-input"
          value={browserHomePage}
          onChange={(e) => setBrowserHomePage(e.target.value)}
          placeholder="留空则使用平台 URL"
          data-name="ai-app-editor.browser-home-page-input"
        />
      </FieldGroup>

      <FieldGroup label="桌面端 UA 预设">
        <Combobox
          inputValue={desktopPresets.find((p) => p.id === aiDesktopPreset)?.name ?? ''}
          onInputChange={() => {}}
          inputPlaceholder="选择桌面端 UA 预设"
          inputClassName="ai-editor-input"
          inputReadOnly
          options={desktopPresets.map<ComboboxOption>((p) => ({
            value: p.id,
            label: p.name,
            selected: p.id === aiDesktopPreset,
          }))}
          onSelect={(v) => setAiDesktopPreset(v)}
          searchable
          searchPlaceholder="搜索 UA 预设…"
          emptyText="无匹配预设"
          dataName="ai-app-editor.desktop-preset"
        />
      </FieldGroup>

      <FieldGroup label="移动端 UA 预设">
        <Combobox
          inputValue={mobilePresets.find((p) => p.id === aiMobilePreset)?.name ?? ''}
          onInputChange={() => {}}
          inputPlaceholder="选择移动端 UA 预设"
          inputClassName="ai-editor-input"
          inputReadOnly
          options={mobilePresets.map<ComboboxOption>((p) => ({
            value: p.id,
            label: p.name,
            selected: p.id === aiMobilePreset,
          }))}
          onSelect={(v) => setAiMobilePreset(v)}
          searchable
          searchPlaceholder="搜索 UA 预设…"
          emptyText="无匹配预设"
          dataName="ai-app-editor.mobile-preset"
        />
      </FieldGroup>

      <FieldGroup label="输入框选择器（留空用平台默认）">
        <input
          type="text"
          className="ai-editor-input"
          value={aiInputSelector}
          onChange={(e) => setAiInputSelector(e.target.value)}
          placeholder={platform?.inputSelector ?? '如：textarea#prompt-textarea'}
          data-name="ai-app-editor.input-selector-input"
        />
      </FieldGroup>

      <FieldGroup label="发送按钮选择器（留空用平台默认）">
        <input
          type="text"
          className="ai-editor-input"
          value={aiSendSelector}
          onChange={(e) => setAiSendSelector(e.target.value)}
          placeholder={platform?.sendSelector ?? '如：button[data-testid="send-button"]'}
          data-name="ai-app-editor.send-selector-input"
        />
      </FieldGroup>

      <FieldGroup label="主题色">
        <div className="ai-app-editor-color-row" data-name="ai-app-editor.theme-color-row">
          <input
            type="color"
            value={isValidHexColor(aiThemeColor) ? aiThemeColor : '#000000'}
            onChange={(e) => setAiThemeColor(e.target.value)}
            className="ai-app-editor-color-picker"
            aria-label="主题色"
            data-name="ai-app-editor.theme-color-picker"
          />
          <input
            type="text"
            className="ai-editor-input"
            value={aiThemeColor}
            onChange={(e) => setAiThemeColor(e.target.value)}
            placeholder="#RRGGBB"
            data-name="ai-app-editor.theme-color-input"
          />
        </div>
      </FieldGroup>

      <FieldGroup label="区域">
        <SegmentedControl
          value={aiPlatformRegion}
          onChange={setAiPlatformRegion}
          options={[
            { value: 'cn', label: '国内' },
            { value: 'global', label: '国外' },
          ]}
          className="seg-control-row"
        />
      </FieldGroup>
    </>
  );
}
