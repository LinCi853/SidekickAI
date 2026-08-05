/* =====================================================================
   store/useBookmarkStore.ts —— 书签状态管理（v0.0.9）
   全局书签（跨所有 AI 应用汇聚），记录来源应用信息。
   书签栏内的书签（inBookmarkBar=true）在书签栏展示，其余仅在书签管理器可见。
   ===================================================================== */

import { create } from 'zustand';
import type { Bookmark, BookmarkInput, BookmarkPatch } from '../lib/electron-api';
import {
  listBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  reorderBookmarks,
} from '../lib/electron-api';

export interface BookmarkStoreState {
  /** 全部书签（含书签栏 + 仅管理器） */
  bookmarks: Bookmark[];
  /** 书签栏是否显示 */
  barVisible: boolean;
  /** 是否已加载 */
  loaded: boolean;

  /** 加载书签列表（默认拉取全部，含书签栏 + 仅管理器） */
  load: () => Promise<void>;
  /** 新增书签；返回新增的 Bookmark */
  add: (input: BookmarkInput) => Promise<Bookmark>;
  /** 删除书签 */
  remove: (id: string) => Promise<void>;
  /** 更新书签（部分字段） */
  update: (id: string, patch: BookmarkPatch) => Promise<void>;
  /** 切换书签是否显示到书签栏 */
  toggleBar: (id: string, visible: boolean) => Promise<void>;
  /** 重排序书签栏 */
  reorder: (ids: string[]) => Promise<void>;
  /** 设置书签栏显示/隐藏（仅本地态，不持久化到书签数据） */
  setBarVisible: (visible: boolean) => void;
  /** 按 URL 查询书签（用于星标按钮判断是否已收藏） */
  findByUrl: (url: string) => Bookmark | undefined;
}

export const useBookmarkStore = create<BookmarkStoreState>((set, get) => ({
  bookmarks: [],
  barVisible: true,
  loaded: false,

  load: async () => {
    const list = await listBookmarks();
    set({ bookmarks: list, loaded: true });
  },

  add: async (input: BookmarkInput) => {
    const created = await addBookmark(input);
    set((s) => ({ bookmarks: [...s.bookmarks, created] }));
    return created;
  },

  remove: async (id: string) => {
    await deleteBookmark(id);
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
  },

  update: async (id: string, patch: BookmarkPatch) => {
    const updated = await updateBookmark(id, patch);
    if (updated) {
      set((s) => ({
        bookmarks: s.bookmarks.map((b) => (b.id === id ? updated : b)),
      }));
    }
  },

  toggleBar: async (id: string, visible: boolean) => {
    await updateBookmark(id, { inBookmarkBar: visible });
    set((s) => ({
      bookmarks: s.bookmarks.map((b) =>
        b.id === id ? { ...b, inBookmarkBar: visible } : b,
      ),
    }));
  },

  reorder: async (ids: string[]) => {
    await reorderBookmarks(ids);
    // 按返回的 ids 顺序重排本地 state 的 order 字段
    set((s) => ({
      bookmarks: s.bookmarks.map((b) => {
        const idx = ids.indexOf(b.id);
        return idx === -1 ? b : { ...b, order: idx };
      }),
    }));
  },

  setBarVisible: (visible: boolean) => {
    set({ barVisible: visible });
  },

  findByUrl: (url: string) => {
    return get().bookmarks.find((b) => b.url === url);
  },
}));
