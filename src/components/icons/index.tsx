/* =====================================================================
   icons/index.tsx —— 统一 SVG 图标库
   所有图标：viewBox 0 0 16 16，fill="none" + stroke="currentColor" 描边风格
   通过父元素 CSS color 控制颜色，沿用 TitleBar.tsx 内联 SVG 函数组件风格
   不引入第三方图标库
   ===================================================================== */

type IconProps = { className?: string };

/** 锁形图标（HTTPS 安全指示） */
function LockIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

/** 警告三角图标（非 HTTPS / 错误提示） */
function AlertIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5 L14 13 L2 13 Z" />
      <line x1="8" y1="6.5" x2="8" y2="9.5" />
      <line x1="8" y1="11.5" x2="8.01" y2="11.5" />
    </svg>
  );
}

/** 放大镜图标（搜索） */
function SearchIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4" />
      <line x1="9.8" y1="9.8" x2="13.5" y2="13.5" />
    </svg>
  );
}

/** 喇叭图标（音频播放中） */
function VolumeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6 V10 H6 L10 13 V3 L6 6 Z" />
      <path d="M12 5.5 a3.5 3.5 0 0 1 0 5" />
    </svg>
  );
}

/** 图钉图标（标签固定） */
function PinIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 6 L8 2.5 L11 6 L10 7.5 V10 H6 V7.5 Z" />
      <line x1="8" y1="10" x2="8" y2="14" />
    </svg>
  );
}

/** 循环箭头图标（恢复最近关闭） */
function RotateIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8 a5 5 0 1 1 -1.5 -3.5" />
      <polyline points="13 3 13 8 8 8" />
    </svg>
  );
}

/** 地球图标（URL/网页） */
function GlobeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <ellipse cx="8" cy="8" rx="2.3" ry="5.5" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
    </svg>
  );
}

/** 房屋图标（主页） */
function HomeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 8 L8 2.5 L14 8" />
      <path d="M4 7 V13 H12 V7" />
    </svg>
  );
}

/** 刷新箭头图标 */
function RefreshIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8 a5 5 0 1 1 1.5 3.5" />
      <polyline points="3 3 3 8 8 8" />
    </svg>
  );
}

/** 左箭头图标（后退） */
function ArrowLeftIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="13" y1="8" x2="3" y2="8" />
      <polyline points="7 4 3 8 7 12" />
    </svg>
  );
}

/** 右箭头图标（前进） */
function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="8" x2="13" y2="8" />
      <polyline points="9 4 13 8 9 12" />
    </svg>
  );
}

/** 加号图标（新建） */
function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

/** 垃圾桶图标（删除） */
function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <path d="M5 4 V3 a1 1 0 0 1 1-1 H10 a1 1 0 0 1 1 1 V4" />
      <path d="M4 4 L4.7 13 a1 1 0 0 0 1 0.9 H10.3 a1 1 0 0 0 1-0.9 L12 4" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="11" />
      <line x1="8" y1="6.5" x2="8" y2="11" />
      <line x1="9.5" y1="6.5" x2="9.5" y2="11" />
    </svg>
  );
}

/** 下载箭头图标 */
function DownloadIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="2" x2="8" y2="10" />
      <polyline points="4 7 8 11 12 7" />
      <line x1="3" y1="13.5" x2="13" y2="13.5" />
    </svg>
  );
}

/** 时钟图标（历史） */
function HistoryIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <polyline points="8 5 8 8 10 9.5" />
    </svg>
  );
}

/** 书签图标 */
function BookmarkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5 H12 V13.5 L8 10 L4 13.5 Z" />
    </svg>
  );
}

/** 齿轮图标（设置） */
function SettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" />
      <line x1="8" y1="1.5" x2="8" y2="3.5" />
      <line x1="8" y1="12.5" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3.5" y2="8" />
      <line x1="12.5" y1="8" x2="14.5" y2="8" />
      <line x1="3.2" y1="3.2" x2="4.6" y2="4.6" />
      <line x1="11.4" y1="11.4" x2="12.8" y2="12.8" />
      <line x1="3.2" y1="12.8" x2="4.6" y2="11.4" />
      <line x1="11.4" y1="4.6" x2="12.8" y2="3.2" />
    </svg>
  );
}

/** 三横线图标（菜单） */
function MenuIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
    </svg>
  );
}

/** X 关闭图标 */
function CloseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/** 横线图标（最小化） */
function MinimizeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

/** 方框图标（最大化） */
function MaximizeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </svg>
  );
}

/** 还原图标（四个角） */
function RestoreIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 3 V5 H3" />
      <path d="M11 3 V5 H13" />
      <path d="M3 11 H5 V13" />
      <path d="M13 11 H11 V13" />
    </svg>
  );
}

/** 文件夹图标（打开所在文件夹） */
function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5.5 V12 a1 1 0 0 0 1 1 H13 a1 1 0 0 0 1 -1 V5.5 a1 1 0 0 0 -1 -1 H8 L6.5 3 H3 a1 1 0 0 0 -1 1 Z" />
    </svg>
  );
}

/** 外部链接图标（打开文件 / 在外部打开） */
function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 3 H4 a1 1 0 0 0 -1 1 V12 a1 1 0 0 0 1 1 H12 a1 1 0 0 0 1 -1 V9.5" />
      <path d="M9 3 H13 V7" />
      <line x1="13" y1="3" x2="7.5" y2="8.5" />
    </svg>
  );
}

export {
  LockIcon, AlertIcon, SearchIcon, VolumeIcon, PinIcon, RotateIcon,
  GlobeIcon, HomeIcon, RefreshIcon, ArrowLeftIcon, ArrowRightIcon,
  PlusIcon, TrashIcon, DownloadIcon, HistoryIcon, BookmarkIcon,
  SettingsIcon, MenuIcon, CloseIcon, MinimizeIcon, MaximizeIcon, RestoreIcon,
  FolderIcon, ExternalLinkIcon,
};
