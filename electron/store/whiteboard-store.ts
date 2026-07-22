// electron/store/whiteboard-store.ts — 白板 AI 窗口持久化存储 + IPC 注册（需求 12）
//
// 全局白板单例：整个应用共享一块白板（不做多白板），简化实现。
// 持久化到 whiteboard.json（electron-store），结构：
//   { cards: WhiteboardCard[], arrows: WhiteboardArrow[], strokes: WhiteboardStroke[], viewport, version: 1 }
//
// WhiteboardStore 类提供 load/save/clear；registerWhiteboardIPC() 注册 5 个 handler。

import Store from 'electron-store'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import type {
  WhiteboardState,
  WhiteboardCard,
  WhiteboardCardInput,
} from '../shared/whiteboard.types.js'
import { getStoreCwd } from './store-paths.js'

// re-export 共享类型
export type { WhiteboardState, WhiteboardCard, WhiteboardCardInput }

type WhiteboardStoreShape = WhiteboardState & {
  version: number
}

const DEFAULT_STATE: WhiteboardState = {
  cards: [],
  arrows: [],
  strokes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
}

const store = new Store<WhiteboardStoreShape>({
  name: 'whiteboard',
  cwd: getStoreCwd(),
  defaults: { ...DEFAULT_STATE, version: 1 },
})

export class WhiteboardStore {
  /** 加载完整白板状态 */
  load(): WhiteboardState {
    return {
      cards: store.get('cards') ?? [],
      arrows: store.get('arrows') ?? [],
      strokes: store.get('strokes') ?? [],
      viewport: store.get('viewport') ?? DEFAULT_STATE.viewport,
    }
  }

  /** 保存完整白板状态（全量覆盖） */
  save(state: WhiteboardState): void {
    store.set('cards', state.cards)
    store.set('arrows', state.arrows)
    store.set('strokes', state.strokes)
    store.set('viewport', state.viewport)
  }

  /** 清空白板 */
  clear(): void {
    store.set('cards', [])
    store.set('arrows', [])
    store.set('strokes', [])
    store.set('viewport', DEFAULT_STATE.viewport)
  }

  /** 仅更新视口（高频调用，单独优化） */
  saveViewport(viewport: WhiteboardState['viewport']): void {
    store.set('viewport', viewport)
  }
}

export const whiteboardStore = new WhiteboardStore()

/** 注册白板相关 IPC handler（在 app.whenReady() 后调用） */
export function registerWhiteboardIPC(): void {
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.WHITEBOARD_GET_STATE, () => whiteboardStore.load())
  ipcMain.handle(ipc.WHITEBOARD_SAVE_STATE, (_e, state: WhiteboardState) => {
    whiteboardStore.save(state)
    return { ok: true }
  })
  ipcMain.handle(ipc.WHITEBOARD_CLEAR, () => {
    whiteboardStore.clear()
    return { ok: true }
  })
}
