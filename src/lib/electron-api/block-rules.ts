/* =====================================================================
   lib/electron-api/block-rules.ts —— 页面组件屏蔽规则
   ===================================================================== */

import type { BlockRule } from '../../../electron/shared/types';
import { requireElectron } from './core';

/** 读取全部屏蔽规则 */
export function listBlockRules(): Promise<BlockRule[]> {
  return requireElectron().blockRules.list();
}

/** 新增或更新屏蔽规则（upsert） */
export function saveBlockRule(rule: BlockRule): Promise<BlockRule> {
  return requireElectron().blockRules.save(rule);
}

/** 删除屏蔽规则（内置规则不可删除） */
export function deleteBlockRule(id: string): Promise<void> {
  return requireElectron().blockRules.delete(id);
}

/** 更新屏蔽规则（部分字段） */
export function updateBlockRule(
  id: string,
  patch: Partial<BlockRule>,
): Promise<BlockRule | null> {
  return requireElectron().blockRules.update(id, patch);
}
