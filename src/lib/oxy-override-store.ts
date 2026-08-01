/* =====================================================================
   Oxy Override Store — Auto/Manual 参数覆盖存储管理器
   管理用户手动调整的参数持久化，auto 参数每次重算。
   ===================================================================== */

import { OXY_STORAGE_KEYS } from './oxy-config';

/** 覆盖条目（仅 manual 项持久化） */
export interface OxyOverrideEntry {
  value: number | string;
  source: 'manual';
  updatedAt: number;
}

/** 覆盖存储类型 */
export type OxyOverrideStore = Record<string, OxyOverrideEntry>;

/* ===== 读取/写入 ===== */

/** 读取整个覆盖存储 */
export function readOverrides(): OxyOverrideStore {
  try {
    const raw = localStorage.getItem(OXY_STORAGE_KEYS.overrides);
    if (!raw) return {};
    return JSON.parse(raw) as OxyOverrideStore;
  } catch {
    return {};
  }
}

/** 写入整个覆盖存储 */
function writeOverrides(store: OxyOverrideStore): void {
  try {
    localStorage.setItem(OXY_STORAGE_KEYS.overrides, JSON.stringify(store));
  } catch { /* 忽略 */ }
}

/* ===== 单参数操作 ===== */

/**
 * 获取参数值：优先 manual 覆盖，否则返回 autoValue。
 * @param key 参数 key（如 'mainWindow.width'）
 * @param autoValue auto 计算的默认值
 * @returns 最终使用的值
 */
export function resolveParam<T extends number | string>(key: string, autoValue: T): T {
  const store = readOverrides();
  const entry = store[key];
  if (entry && entry.source === 'manual') {
    return entry.value as T;
  }
  return autoValue;
}

/**
 * 标记参数为 manual 并持久化。
 * 用户手动调整某参数后调用。
 */
export function setManualOverride(key: string, value: number | string): void {
  const store = readOverrides();
  store[key] = { value, source: 'manual', updatedAt: Date.now() };
  writeOverrides(store);
}

/**
 * 删除指定参数的 manual 覆盖，使其回到 auto。
 */
export function clearOverride(key: string): void {
  const store = readOverrides();
  delete store[key];
  writeOverrides(store);
}

/**
 * 清除所有 manual 覆盖，全部回到 auto。
 * 切换到 Oxy 模式时调用。
 */
export function clearAllOverrides(): void {
  try {
    localStorage.removeItem(OXY_STORAGE_KEYS.overrides);
  } catch { /* 忽略 */ }
}

/**
 * 检查某参数是否为 manual 覆盖。
 */
export function isManual(key: string): boolean {
  const store = readOverrides();
  return !!store[key] && store[key].source === 'manual';
}
