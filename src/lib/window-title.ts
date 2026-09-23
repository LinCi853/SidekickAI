const brand = '工百窗';

const windowNames: Record<string, string> = {
  settings: '设置',
  'advanced-panel': '进阶面板',
  chat: '对话',
  history: '历史搜索',
  prompts: '提示词库',
  'ai-app-editor': 'AI 应用配置',
  'data-export': '数据迁移',
  onboarding: '使用指南',
  browser: '浏览器',
  'history-download': '历史记录与下载管理',
};

export function formatWindowTitle(value?: string | null): string {
  const title = value?.trim();
  if (!title) return brand;
  return title.startsWith(brand) ? title : `${brand} - ${title}`;
}

export function getInitialWindowTitle(mode: string | null, windowId: string): string {
  if (windowId === 'preview' || mode === 'record-indicator') return '录音';
  return formatWindowTitle(windowNames[mode ?? windowId]);
}
