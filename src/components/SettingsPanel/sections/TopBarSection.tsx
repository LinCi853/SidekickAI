import type { TopBarButtonGroup } from '../../../lib/electron-api';
import { ALL_TOP_BAR_BUTTON_GROUPS } from '../../../lib/electron-api';
import Chip from '../../ui/Chip';

/** 可自定义按钮组的紧凑标签 */
const TOP_BAR_BUTTON_LABELS: Record<TopBarButtonGroup, string> = {
  uaToggle: 'UA 切换',
  navBack: '后退',
  navForward: '前进',
  navHome: '主页',
  themeToggle: '主题',
  pinToggle: '置顶',
};

interface TopBarSectionProps {
  visibleButtons: TopBarButtonGroup[];
  onToggle: (group: TopBarButtonGroup) => void;
}

export default function TopBarSection({ visibleButtons, onToggle }: TopBarSectionProps) {
  return (
    <section className="topbar-section-compact" data-name="settings.top-bar.section">
      <span className="topbar-section-compact-label" data-name="settings.top-bar.label">顶栏按钮</span>
      <div className="topbar-chip-row" data-name="settings.top-bar.chip-list">
        {ALL_TOP_BAR_BUTTON_GROUPS.map((group, idx) => {
          const checked = visibleButtons.includes(group);
          return (
            <Chip
              key={group}
              selected={checked}
              className="topbar-chip"
              onClick={() => onToggle(group)}
              data-name={`settings.top-bar.chip-${idx + 1}`}
              data-index={idx + 1}
              data-id={group}
            >
              {TOP_BAR_BUTTON_LABELS[group]}
            </Chip>
          );
        })}
      </div>
    </section>
  );
}
