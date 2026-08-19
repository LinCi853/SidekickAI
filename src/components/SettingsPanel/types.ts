export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts?: () => void;
}

export interface VoiceSettings {
  confirmMode: 'auto' | 'manual' | 'clipboard';
  inputMethod: 'layered' | 'clipboard' | 'type';
  enterToSend: boolean;
  sttMode: 'ai' | 'local';
  aiProvider: string;
  language: string;
  localExePath: string;
  localArgs: string;
  inputDeviceId: string;
  ttsMode: 'disable' | 'ai';
  ttsProvider: string;
}

export interface GeneralSettings {
  startupOpen: 'home' | 'lastConversation';
  closeBehavior: 'close' | 'minimize';
  enterToSend: boolean;
  defaultDesktopUaPreset: string;
  defaultMobileUaPreset: string;
  appClickBehavior: 'switch' | 'close';
  usageTrackingEnabled: boolean;
}

export interface ProxySettings {
  proxyMode: 'system' | 'direct' | 'custom';
  customProxy: string;
  proxyUsername: string;
  proxyPassword: string;
  proxyBypass: string;
  proxyFallbackEnabled: boolean;
  proxyFallbackMode: 'direct' | 'system';
}
