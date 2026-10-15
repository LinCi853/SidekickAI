import type { DrawerMenuItem } from '../../../lib/electron-api';
import { ALL_DRAWER_MENU_ITEMS } from '../../../lib/electron-api';
import Chip from '../../ui/Chip';

/** 侧边菜单入口的紧凑标签 */
const DRAWER_ITEM_LABELS: Record<DrawerMenuItem, string> = {
  advancedPanel: '进阶面板',
  promptLibrary: '提示词',
  settings: '设置',
  network: '网络',
  modules: '模块',
  manage: '管理',
  backup: '备份',
  logs: '日志',
  detach: '独立窗口',
  onboarding: '指南',
  shortcuts: '快捷键',
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
