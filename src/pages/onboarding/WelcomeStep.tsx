/* =====================================================================
   pages/onboarding/WelcomeStep.tsx —— 引导页 0：欢迎
   职责：视觉主图（主窗口 / 进阶面板浮窗 / 独立窗口 SVG）+ 一句话定位
   + 三大价值（聚合 / 安静 / 本地），通用文案不绑定内置平台数量；
   底部提示总步数与跳过/回顾方式。
   从 pages/OnboardingView.tsx 拆出，纯展示组件，不改变任何行为。
   ===================================================================== */

import { TOTAL_PAGES } from './onboardingData';
import { ICONS, OnboardIcon } from './OnboardIcon';

/** 欢迎页三大价值（通用文案，不绑定具体平台数量） */
const VALUE_POINTS = [
  {
    icon: 'layers',
    title: '聚合',
    desc: '内置常用 AI 平台，也支持手动添加任意 AI 服务；多账号互相隔离，可多开',
  },
  {
    icon: 'mute',
    title: '安静',
    desc: '自动屏蔽下载引导、升级横幅与原生弹窗，专注对话不被打断',
  },
  {
    icon: 'lock',
    title: '本地',
    desc: '对话、笔记、白板全部本地存储，语音识别数据不出本机',
  },
] as const;

export default function WelcomeStep() {
  return (
    <div className="onboarding-page onboarding-welcome" data-name="onboarding.page-welcome">
      <svg
        className="onboarding-welcome-hero-svg"
        viewBox="0 0 260 150"
        fill="none"
        aria-hidden="true"
        data-name="onboarding.welcome.hero"
      >
        {/* 主窗口（窄长形态） */}
        <rect x="40" y="12" width="100" height="126" rx="8" className="ob-hero-window" />
        <rect x="40" y="12" width="100" height="20" rx="8" className="ob-hero-titlebar" />
        <rect x="48" y="17" width="18" height="10" rx="3" className="ob-hero-chip" />
        <rect x="70" y="17" width="18" height="10" rx="3" className="ob-hero-chip is-active" />
        <rect x="92" y="17" width="18" height="10" rx="3" className="ob-hero-chip" />
        <rect x="50" y="42" width="80" height="54" rx="4" className="ob-hero-content" />
        <line x1="50" y1="104" x2="130" y2="104" className="ob-hero-line" />
        <line x1="50" y1="114" x2="112" y2="114" className="ob-hero-line" />
        <line x1="50" y1="124" x2="122" y2="124" className="ob-hero-line" />
        {/* 进阶面板浮窗 */}
        <rect x="158" y="56" width="86" height="64" rx="8" className="ob-hero-panel" />
        <rect x="158" y="56" width="86" height="16" rx="8" className="ob-hero-panel-bar" />
        <rect x="166" y="80" width="32" height="32" rx="4" className="ob-hero-panel-cell" />
        <rect x="204" y="80" width="32" height="32" rx="4" className="ob-hero-panel-cell" />
        {/* 独立窗口 + 脱离虚线 */}
        <rect x="168" y="14" width="56" height="26" rx="6" className="ob-hero-detached" />
        <rect x="168" y="14" width="56" height="9" rx="4.5" className="ob-hero-detached-bar" />
        <path d="M140 42 q14 16 28 16" className="ob-hero-link" strokeDasharray="3 3" />
      </svg>
      <div className="onboarding-welcome-hero">
        <h1 className="onboarding-welcome-title">工百窗</h1>
        <p className="onboarding-welcome-tagline">热键驱动的 AI 聚合工作台</p>
      </div>
      <div className="onboarding-welcome-points">
        {VALUE_POINTS.map((p) => (
          <div key={p.title} className="onboarding-welcome-point">
            <span className="onboarding-welcome-point-icon">
              <OnboardIcon>{ICONS[p.icon]}</OnboardIcon>
            </span>
            <strong>{p.title}</strong>
            <span>{p.desc}</span>
          </div>
        ))}
      </div>
      <p className="onboarding-welcome-hint">共 {TOTAL_PAGES} 步 · 可随时跳过 · 之后可从设置菜单再次打开本指南</p>
    </div>
  );
}
