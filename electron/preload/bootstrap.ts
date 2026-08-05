import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const bootstrapApi = {
  /** 打开 AI 应用编辑窗口（多例；编辑模式按 profileId 单例，新建模式固定 'create' 单例） */
  openAiAppEditor: (opts: {
    platformId?: string;
    profileId?: string;
    mode?: 'edit' | 'create';
  }) => {
    return ipcRenderer.invoke(IPC_CHANNELS.AI_APP_EDITOR_OPEN, opts)
  },
  /** 打开设置独立窗口（单例） */
  openSettingsWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_OPEN)
  },
  /** 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话） */
  openAdvancedPanelWindow: (providerId?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADVANCED_PANEL_OPEN, providerId)
  },
  /** 切换 进阶面板显隐（单例） */
  toggleAdvancedPanelWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADVANCED_PANEL_TOGGLE)
  },
  /** 主→渲染：单例窗口复用时通知切换 tab/provider */
  onAdvancedPanelNavigate: (
    callback: (payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) => void,
  ) => {
    const handler = (_e: unknown, payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) =>
      callback(payload)
    ipcRenderer.on(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, handler)
  },
}

/**
 * DOM side-effects that must run once after contextBridge.exposeInMainWorld.
 * Called by the main preload.ts entry point.
 */
export function setupDomSideEffects() {
  // 在 <html> 标记平台，供 CSS 按平台调整拖拽区域（macOS 避让交通灯等）。
  // contextIsolation 下 preload 与渲染层共享 DOM，可直接写 document 属性。
  document.documentElement.setAttribute('data-platform', process.platform)

  // 监听窗口最大化/全屏状态，设置 html data 属性以控制窗口级圆角。
  // 普通窗口保持圆角；最大化/全屏时移除圆角，避免黑边。
  function updateWindowShapeAttributes() {
    ipcRenderer.invoke(IPC_CHANNELS.WIN_CONTROL_IS_MAXIMIZED).then((isMax: boolean) => {
      document.documentElement.setAttribute('data-maximized', String(isMax))
    }).catch(() => { /* ignore */ })
  }
  ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, (_e, isMax: boolean) => {
    document.documentElement.setAttribute('data-maximized', String(isMax))
  })
  ipcRenderer.on(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, (_e, isFs: boolean) => {
    document.documentElement.setAttribute('data-fullscreen', String(isFs))
  })
  updateWindowShapeAttributes()

  // ===== 使用统计：全局 data-name 点击日志监听器 =====
  // 监听主进程下发的窗口类型（main/chat/advanced-panel/history/prompt-library/...），
  // 写入 window.__ai_window_type__ 供点击日志的 windowType 字段使用。
  let windowType: string | null = null
  ;(window as unknown as { __ai_window_type__?: string | null }).__ai_window_type__ = null
  ipcRenderer.on(IPC_CHANNELS.SET_WINDOW_TYPE, (_e, type: string | null) => {
    windowType = type
    ;(window as unknown as { __ai_window_type__?: string | null }).__ai_window_type__ = type
  })

  // 全局捕获带 data-name 元素的点击事件，debounce 100ms，写入 SQLite click_logs。
  // 仅记录有 data-name 属性的元素（按钮/菜单/热键触发点），不记录无 data-name 的普通点击。
  ;(() => {
    let lastClickName = ''
    let lastClickTs = 0
    document.addEventListener(
      'click',
      (e: Event) => {
        try {
          const target = e.target as HTMLElement | null
          if (!target || !target.closest) return
          const el = target.closest('[data-name]') as HTMLElement | null
          if (!el) return
          const name = el.dataset.name
          if (!name) return
          const now = Date.now()
          // 同一元素 100ms 内的重复点击丢弃（防抖）
          if (name === lastClickName && now - lastClickTs < 100) return
          lastClickName = name
          lastClickTs = now
          ipcRenderer.invoke(IPC_CHANNELS.USAGE_TRACE_LOG_CLICK, name, windowType).catch(() => { /* ignore */ })
        } catch {
          // 点击日志失败不影响正常交互
        }
      },
      true, // capture: 在事件冒泡前捕获
    )
  })()
}
