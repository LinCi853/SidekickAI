/* =====================================================================
   store/useProfileStore.ts —— Profile 状态管理
   维护 Profile 列表与当前选中 Profile id，通过 window.electron.profile IPC
   加载 / 创建 / 更新 / 删除 / 复制 Profile。
   替代旧的 usePlatformStore（Tauri 时代以 AI 平台为单元，现以 Profile 为单元）。
   ===================================================================== */

import { create } from 'zustand';
import type { Profile } from '../lib/electron-api';
import {
  listProfiles,
  createProfile as ipcCreateProfile,
  updateProfile as ipcUpdateProfile,
  deleteProfile as ipcDeleteProfile,
  duplicateProfile as ipcDuplicateProfile,
  reorderProfiles as ipcReorderProfiles,
  openWindow as ipcOpenWindow,
  closeWindow as ipcCloseWindow,
  getOpenWindowIds,
  onProfileUpdated,
  onProfileCreated,
  onProfileDeleted,
  onProfileReordered,
} from '../lib/electron-api';

/** 跨窗口 Profile 同步监听器（仅注册一次：updated/created/deleted/reordered 四类广播） */
let _profileSyncListenerSetUp = false;
function setupProfileSyncListeners() {
  if (_profileSyncListenerSetUp) return;
  _profileSyncListenerSetUp = true;
  try {
    // Profile 字段更新：就地替换对应 id 的 Profile
    onProfileUpdated((data) => {
      useProfileStore.setState((s) => ({
        profiles: s.profiles.map((p) => (p.id === data.id ? data.profile : p)),
      }));
    });
    // Profile 新建/复制：追加到 profiles 列表末尾
    onProfileCreated((profile) => {
      useProfileStore.setState((s) => {
        // 避免重复追加（同窗口发起 create 的调用方已本地追加）
        if (s.profiles.some((p) => p.id === profile.id)) return s;
        return { profiles: [...s.profiles, profile] };
      });
    });
    // Profile 删除：从 profiles 列表移除，并清理 openWindowIds / activeProfileId
    onProfileDeleted((profileId) => {
      useProfileStore.setState((s) => ({
        profiles: s.profiles.filter((p) => p.id !== profileId),
        openWindowIds: s.openWindowIds.filter((oid) => oid !== profileId),
        activeProfileId: s.activeProfileId === profileId ? null : s.activeProfileId,
      }));
    });
    // Profile 拖拽排序：按广播的 orderedIds 重排本地 profiles 数组
    onProfileReordered((orderedIds) => {
      useProfileStore.setState((s) => {
        const idToOrder = new Map<string, number>();
        orderedIds.forEach((id, index) => idToOrder.set(id, index));
        // 对每个 profile 按 orderedIds 中的新 order 排序；不在列表中的保持原顺序排到最后
        const sorted = [...s.profiles].sort((a, b) => {
          const oa = idToOrder.get(a.id);
          const ob = idToOrder.get(b.id);
          if (oa !== undefined && ob !== undefined) return oa - ob;
          if (oa !== undefined) return -1;
          if (ob !== undefined) return 1;
          return (a.order ?? 0) - (b.order ?? 0);
        });
        return { profiles: sorted };
      });
    });
  } catch (e) {
    console.error('[profile-store] 注册跨窗口同步监听器失败:', e);
  }
}

export interface ProfileState {
  /** 全部 Profile 列表 */
  profiles: Profile[];
  /** 当前选中 Profile id（用于详情面板展示，null 表示未选中） */
  activeProfileId: string | null;
  /** 已打开窗口的 profileId 集合（来自主进程 WindowManager） */
  openWindowIds: string[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 加载 Profile 列表与已打开窗口 id */
  loadProfiles: () => Promise<void>;
  /** 刷新已打开窗口 id 列表 */
  refreshOpenWindows: () => Promise<void>;
  /** 设置当前选中 Profile */
  setActiveProfile: (id: string | null) => void;
  /** 创建 Profile */
  createProfile: (partial: Partial<Profile>) => Promise<Profile>;
  /** 更新 Profile */
  updateProfile: (id: string, patch: Partial<Profile>) => Promise<Profile>;
  /** 切换指定 Profile 的 UA 锁定模式（auto→mobile→desktop→auto 循环） */
  updateProfileUaLockMode: (id: string, mode: 'auto' | 'mobile' | 'desktop') => Promise<void>;
  /** 删除 Profile */
  deleteProfile: (id: string) => Promise<void>;
  /** 复制 Profile */
  duplicateProfile: (id: string) => Promise<Profile>;
  /**
   * 拖拽排序：按 orderedIds 顺序重置 Profile 的 order 字段。
   * 调用 IPC 持久化到主进程，主进程广播 PROFILE_REORDERED 通知所有窗口同步。
   * 本窗口的 onProfileReordered 监听器会接收广播并本地重排，无需在此手动重排。
   */
  reorderProfiles: (orderedIds: string[]) => Promise<void>;
  /** 打开 Profile 窗口（独立 BrowserWindow） */
  openProfile: (id: string) => Promise<void>;
  /** 关闭 Profile 窗口 */
  closeProfileWindow: (id: string) => Promise<void>;
  /** 按 id 获取 Profile（不存在返回 null） */
  getProfile: (id: string | null) => Profile | null;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  openWindowIds: [],
  loading: false,
  error: null,

  loadProfiles: async () => {
    set({ loading: true, error: null });
    // 注册跨窗口 Profile 同步监听器（仅一次：updated/created/deleted/reordered）
    setupProfileSyncListeners();
    try {
      const [profiles, openWindowIds] = await Promise.all([
        listProfiles(),
        getOpenWindowIds().catch(() => [] as string[]),
      ]);
      const prevId = get().activeProfileId;
      // 保留仍存在的选中项
      const stillExists = prevId != null && profiles.some((p) => p.id === prevId);
      set({
        profiles,
        openWindowIds,
        activeProfileId: stillExists ? prevId : null,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  refreshOpenWindows: async () => {
    try {
      const openWindowIds = await getOpenWindowIds();
      set({ openWindowIds });
    } catch (e) {
      console.error('[profile-store] 刷新已打开窗口失败:', e);
    }
  },

  setActiveProfile: (id) => set({ activeProfileId: id }),

  createProfile: async (partial) => {
    const profile = await ipcCreateProfile(partial);
    set((s) => {
      if (s.profiles.some((p) => p.id === profile.id)) return s;
      return { profiles: [...s.profiles, profile] };
    });
    return profile;
  },

  updateProfile: async (id, patch) => {
    const updated = await ipcUpdateProfile(id, patch);
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? updated : p)),
    }));
    return updated;
  },

  updateProfileUaLockMode: async (id, mode) => {
    // 仅更新本地状态 + 持久化，不触发窗口重建；WebviewTab 通过 profile.uaLockMode 依赖自动切换
    await ipcUpdateProfile(id, { uaLockMode: mode });
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, uaLockMode: mode } : p)),
    }));
  },

  deleteProfile: async (id) => {
    await ipcDeleteProfile(id);
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      openWindowIds: s.openWindowIds.filter((oid) => oid !== id),
      activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
    }));
  },

  duplicateProfile: async (id) => {
    const copy = await ipcDuplicateProfile(id);
    set((s) => {
      if (s.profiles.some((p) => p.id === copy.id)) return s;
      return { profiles: [...s.profiles, copy] };
    });
    return copy;
  },

  reorderProfiles: async (orderedIds) => {
    // 调用 IPC 持久化到主进程；主进程广播 PROFILE_REORDERED 后由 onProfileReordered 监听器本地重排
    await ipcReorderProfiles(orderedIds);
  },

  openProfile: async (id) => {
    await ipcOpenWindow(id);
    set((s) => ({
      openWindowIds: s.openWindowIds.includes(id)
        ? s.openWindowIds
        : [...s.openWindowIds, id],
    }));
  },

  closeProfileWindow: async (id) => {
    await ipcCloseWindow(id);
    set((s) => ({
      openWindowIds: s.openWindowIds.filter((oid) => oid !== id),
    }));
  },

  getProfile: (id) => {
    if (!id) return null;
    return get().profiles.find((p) => p.id === id) ?? null;
  },
}));
