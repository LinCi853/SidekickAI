/** Main-window menu: grouped list + bottom banner and utility bar. */

import { useCallback, useEffect, useRef, useState } from 'react'
import Sun from 'lucide-react/dist/esm/icons/sun'
import Moon from 'lucide-react/dist/esm/icons/moon'
import { useThemeStore } from '../store/useThemeStore'
import { useModuleStore } from '../store/useModuleStore'
import { useUiVersionStore } from '../store/useUiVersionStore'
import { useTabStore } from '../store/useTabStore'
import {
  openAdvancedPanelWindow,
  openExportWindow,
  openPromptWindow,
  openSettingsWindow,
  openLogsFolder,
  minimizeWindow,
  showOnboardingWindow,
  getAppSettings,
} from '../lib/electron-api'
import type { DrawerMenuItem } from '../lib/electron-api'
import { ALL_DRAWER_MENU_ITEMS } from '../lib/electron-api'
import { localLogDate } from '../../electron/shared/log-export'
import { IconButton } from './ui'
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow'
import bannerArt from '../assets/drawer-banner.svg'
import './DrawerPanel.css'

export interface DrawerPanelProps {
  open: boolean
  onClose: () => void
  onOpenSearch?: () => void
  onOpenShortcuts?: () => void
  onOpenSettings?: () => void
  onOpenPromptLibrary?: () => void
}

const LEGACY_ITEMS: DrawerMenuItem[] = [
  'advancedPanel',
  'onboarding',
  'shortcuts',
  'settings',
  'promptLibrary',
  'themeToggle',
]
/** 「常用」组入口固定显示，设置中不可调整 */
const LOCKED_ITEMS: DrawerMenuItem[] = ['advancedPanel', 'promptLibrary', 'settings']
const NEW_ITEMS = ALL_DRAWER_MENU_ITEMS.filter((id) => !LEGACY_ITEMS.includes(id))

function normalizeMenuItems(list: unknown): DrawerMenuItem[] {
  if (!Array.isArray(list) || list.length === 0) return [...ALL_DRAWER_MENU_ITEMS]
  const valid = list.filter((id): id is DrawerMenuItem =>
    ALL_DRAWER_MENU_ITEMS.includes(id as DrawerMenuItem),
  )
  if (valid.length === 0) return [...ALL_DRAWER_MENU_ITEMS]
  const isLegacy =
    valid.every((id) => LEGACY_ITEMS.includes(id)) && !valid.some((id) => NEW_ITEMS.includes(id))
  return isLegacy ? [...valid, ...NEW_ITEMS] : valid
}

type MenuGroup = 'common' | 'system' | 'help'

interface MenuItemDef {
  id: DrawerMenuItem
  label: string
  title: string
  icon: React.ReactNode
  onClick: () => void
  group: MenuGroup
  visible?: boolean
}

const GROUP_META: Array<{ key: MenuGroup; label?: string }> = [
  { key: 'common' },
  { key: 'system', label: '系统' },
  { key: 'help', label: '帮助' },
]

function recent30Options(): { startDate: string; endDate: string } {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 29)
  return { startDate: localLogDate(start), endDate: localLogDate(end) }
}

export default function DrawerPanel({
  open,
  onClose,
  onOpenSearch,
  onOpenShortcuts,
  onOpenSettings,
  onOpenPromptLibrary,
}: DrawerPanelProps) {
  const resolved = useThemeStore((s) => s.resolved)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)
  const promptEnabled = useModuleStore((s) => s.isEnabled('prompt-library'))
  const advancedPanelAvailable = useModuleStore(
    (s) => s.isEnabled('custom-chat') || s.isEnabled('whiteboard') || s.isEnabled('notes'),
  )
  const isOxy = useUiVersionStore((s) => s.version) === 'oxy'

  const [enabledItems, setEnabledItems] = useState<DrawerMenuItem[]>([...ALL_DRAWER_MENU_ITEMS])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getAppSettings()
      .then((cfg) => {
        if (cancelled) return
        setEnabledItems(normalizeMenuItems(cfg.drawerMenuItems))
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (panelRef.current) {
      if (open) panelRef.current.removeAttribute('inert')
      else panelRef.current.setAttribute('inert', '')
    }
  }, [open])

  const run = useCallback(
    (fn: () => Promise<unknown> | void, tag: string) => {
      void Promise.resolve(fn()).catch((e) => console.error(`[DrawerPanel] ${tag}失败:`, e))
      onClose()
    },
    [onClose],
  )

  const handleItemClick = useCallback(
    (action: 'search' | 'shortcuts' | 'settings' | 'prompt') => {
      switch (action) {
        case 'search':
          onOpenSearch?.()
          break
        case 'shortcuts':
          onOpenShortcuts?.()
          break
        case 'settings':
          onOpenSettings?.()
          break
        case 'prompt':
          onOpenPromptLibrary?.()
          break
      }
      onClose()
    },
    [onOpenSearch, onOpenShortcuts, onOpenSettings, onOpenPromptLibrary, onClose],
  )

  useEscToCloseOverlay(open, onClose)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const key = e.key.toLowerCase()
      const on = (id: DrawerMenuItem) => enabledItems.includes(id)
      if (key === 'k' && on('promptLibrary') && promptEnabled) {
        e.preventDefault()
        handleItemClick('prompt')
      } else if ((key === '?' || key === '/') && on('shortcuts')) {
        e.preventDefault()
        handleItemClick('shortcuts')
      } else if (key === ',' && on('settings')) {
        e.preventDefault()
        handleItemClick('settings')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleItemClick, promptEnabled, enabledItems])

  const detachActiveTab = useCallback(() => {
    const { activeTabId, detachTab } = useTabStore.getState()
    if (activeTabId)
      void detachTab(activeTabId).catch((e) => console.error('[DrawerPanel] 独立窗口失败:', e))
    onClose()
  }, [onClose])

  const exportLogs = useCallback(() => {
    run(() => openLogsFolder(recent30Options()), '日志导出')
  }, [run])

  // 「空格」：外观像提示文案，点击等效 Alt+Space 隐藏主窗口
  const handleHideWindow = useCallback(() => {
    void minimizeWindow().catch((e: unknown) => console.error('[DrawerPanel] 隐藏窗口失败:', e))
    onClose()
  }, [onClose])

  const showSettingsShortcut = enabledItems.includes('settings')

  const items: MenuItemDef[] = [
    {
      id: 'advancedPanel',
      label: '进阶面板',
      title: '打开进阶面板（Alt+Q）',
      group: 'common',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      ),
      onClick: () => run(() => openAdvancedPanelWindow(), '打开进阶面板'),
      visible: advancedPanelAvailable,
    },
    {
      id: 'promptLibrary',
      label: 'AI资产',
      title: '打开 AI 资产',
      group: 'common',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      ),
      onClick: () => run(() => openPromptWindow(), '打开 AI资产'),
      visible: promptEnabled,
    },
    {
      id: 'settings',
      label: '设置',
      title: '打开设置',
      group: 'common',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
      onClick: () => run(() => openSettingsWindow(), '打开设置'),
    },
    {
      id: 'network',
      label: '网络与代理',
      title: '网络与代理',
      group: 'system',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
      onClick: () => run(() => openSettingsWindow('network'), '打开网络设置'),
    },
    {
      id: 'modules',
      label: '模块管理',
      title: '管理模块的打开与关闭',
      group: 'system',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
        </svg>
      ),
      onClick: () => run(() => openSettingsWindow('modules'), '打开模块管理'),
    },
    {
      id: 'manage',
      label: 'AI 应用管理',
      title: '对当前的 AI 应用进行管理',
      group: 'system',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
      onClick: () => run(() => openSettingsWindow('ai'), '打开应用管理'),
    },
    {
      id: 'backup',
      label: '备份与导入',
      title: '备份与导入',
      group: 'system',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" x2="12" y1="3" y2="15" />
        </svg>
      ),
      onClick: () => run(() => openExportWindow(), '打开备份'),
    },
    {
      id: 'detach',
      label: '浏览器打开',
      title: '当前页以浏览器窗口打开',
      group: 'system',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      ),
      onClick: detachActiveTab,
    },
    {
      id: 'onboarding',
      label: '使用指南',
      title: '查看功能介绍与使用指南',
      group: 'help',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      ),
      onClick: () => run(() => showOnboardingWindow(), '打开指南'),
    },
    {
      id: 'shortcuts',
      label: '快捷键查看',
      title: '查看快捷键提示',
      group: 'help',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
      onClick: () => handleItemClick('shortcuts'),
    },
    // 日志 / 主题沉底，不进分组列表
  ]

  // 「常用」组入口固定显示，不受设置勾选影响
  const visibleItems = items.filter(
    (it) => (LOCKED_ITEMS.includes(it.id) || enabledItems.includes(it.id)) && it.visible !== false,
  )
  const showLogs = enabledItems.includes('logs')
  const showTheme = enabledItems.includes('themeToggle') && !isOxy

  return (
    <>
      <div
        className={`drawer-overlay${open ? ' active' : ''}`}
        data-name="component.drawer-panel.overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`drawer-panel${open ? ' active' : ''}`}
        data-dom-id="aw-main-drawer"
        data-name="component.drawer-panel.container"
        role="dialog"
        aria-label="菜单"
      >
        <div className="drawer-header" data-name="component.drawer-panel.header">
          <span className="drawer-header-title" data-name="component.drawer-panel.title">
            菜单
          </span>
          <IconButton
            type="button"
            variant="close"
            className="drawer-close-btn"
            data-name="component.drawer-panel.close-button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </IconButton>
        </div>

        <div className="drawer-body" data-name="component.drawer-panel.body">
          {GROUP_META.map((g) => {
            const groupItems = visibleItems.filter((it) => it.group === g.key)
            if (groupItems.length === 0) return null
            return (
              <section
                key={g.key}
                className={`drawer-section${g.key === 'common' ? ' drawer-section--top' : ''}`}
                data-name={`component.drawer-panel.section-${g.key}`}
              >
                {g.label && (
                  <div className="drawer-section-label" aria-hidden="true">
                    {g.label}
                  </div>
                )}
                <div className={g.key === 'common' ? 'drawer-top-row' : 'drawer-rows'}>
                  {groupItems.map((it, idx) => (
                    <button
                      key={it.id}
                      type="button"
                      className={g.key === 'common' ? 'drawer-top-cell' : 'drawer-row'}
                      data-name={`component.drawer-panel.item-${it.id}`}
                      data-index={idx + 1}
                      data-id={it.id}
                      title={it.title}
                      onClick={it.onClick}
                    >
                      <span className="drawer-item-icon" aria-hidden="true">
                        {it.icon}
                      </span>
                      <span className="drawer-item-label">{it.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
          {visibleItems.length === 0 && (
            <div className="drawer-empty" data-name="component.drawer-panel.empty">
              菜单为空，可在设置中勾选入口
            </div>
          )}

          <div className="drawer-banner" data-name="component.drawer-panel.banner">
            <img
              className="drawer-banner-img"
              src={bannerArt}
              alt=""
              aria-hidden="true"
              data-name="component.drawer-panel.banner-image"
            />
          </div>
        </div>

        <div className="drawer-footer" data-name="component.drawer-panel.footer">
          <div className="drawer-footer-actions" data-name="component.drawer-panel.footer-actions">
            {showSettingsShortcut && (
              <button
                type="button"
                className="drawer-icon-btn"
                data-name="component.drawer-panel.footer-settings"
                title="设置"
                onClick={() => run(() => openSettingsWindow(), '打开设置')}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
            {showLogs && (
              <button
                type="button"
                className="drawer-icon-btn"
                data-name="component.drawer-panel.footer-logs"
                title="导出近 30 天日志"
                onClick={exportLogs}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                  <path d="M10 9H8" />
                  <path d="M16 13H8" />
                  <path d="M16 17H8" />
                </svg>
              </button>
            )}
          </div>
          <button
            type="button"
            className="drawer-space-hint"
            data-name="component.drawer-panel.footer-space"
            tabIndex={-1}
            onClick={handleHideWindow}
          >
            使用alt+空格显隐主窗口
          </button>
          {showTheme && (
            <button
              type="button"
              className="drawer-theme-btn"
              data-name="component.drawer-panel.theme-button"
              title={resolved === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
              onClick={() => {
                toggleTheme()
                onClose()
              }}
            >
              {resolved === 'dark' ? (
                <Moon size={15} aria-hidden="true" />
              ) : (
                <Sun size={15} aria-hidden="true" />
              )}
              <span>{resolved === 'dark' ? '暗色' : '亮色'}</span>
            </button>
          )}
        </div>
      </div>
    </>
  )
}
