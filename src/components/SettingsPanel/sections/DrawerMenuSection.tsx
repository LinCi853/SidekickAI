import type { DrawerMenuItem } from '../../../lib/electron-api';
import { ALL_DRAWER_MENU_ITEMS } from '../../../lib/electron-api';
import Chip from '../../ui/Chip';

/** 侧边菜单入口的紧凑标签 */
const DRAWER_ITEM_LABELS: Record<DrawerMenuItem, string> = {
  advancedPanel: '进阶面板',
  promptLibrary: 'AI资产',
  settings: '设置',
  network: '网络与代理',
  modules: '模块管理',
  manage: 'AI 应用管理',
  backup: '备份与导入',
  logs: '日志',
  detach: '浏览器打开',
  onboarding: '使用指南',
  shortcuts: '快捷键查看',
  themeToggle: '主题',
};

/** 「常用」组入口固定显示，设置中不可变动 */
const LOCKED_DRAWER_ITEMS: DrawerMenuItem[] = ['advancedPanel', 'promptLibrary', 'settings'];

interface DrawerMenuSectionProps {
  visibleItems: DrawerMenuItem[];
  onToggle: (item: DrawerMenuItem) => void;
}

/** 设置 → 外观：侧边菜单显示哪些入口（网格；「常用」组入口固定显示，不在此列出） */
export default function DrawerMenuSection({ visibleItems, onToggle }: DrawerMenuSectionProps) {
  const toggleableItems = ALL_DRAWER_MENU_ITEMS.filter((item) => !LOCKED_DRAWER_ITEMS.includes(item));
  return (
    <section className="topbar-section-compact" data-name="settings.drawer-menu.section">
      <span className="topbar-section-compact-label" data-name="settings.drawer-menu.label">侧边菜单</span>
      <div className="topbar-chip-row" data-name="settings.drawer-menu.chip-list">
        {toggleableItems.map((item, idx) => (
          <Chip
            key={item}
            selected={visibleItems.includes(item)}
            className="topbar-chip"
            onClick={() => onToggle(item)}
            data-name={`settings.drawer-menu.chip-${idx + 1}`}
            data-index={idx + 1}
            data-id={item}
          >
            {DRAWER_ITEM_LABELS[item]}
          </Chip>
        ))}
      </div>
    </section>
  );
}
