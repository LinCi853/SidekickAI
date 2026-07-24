/* =====================================================================
   lib/electron-api/injection.ts —— 注入历史管理（需求 2：注入预览 + Jaccard 去重）
   ===================================================================== */

import type {
  InjectionRecord,
  SimilarInjectionResult,
} from '../../../electron/shared/types';
import { requireElectron } from './core';

/** 记录一次注入 */
export async function logInjection(
  record: Omit<InjectionRecord, 'id' | 'createdAt'>,
): Promise<InjectionRecord> {
  const api = requireElectron();
  return api.injection.log(record);
}

/** 在最近 limit 条记录中查找与 text 相似度 ≥ threshold 的记录 */
export async function findSimilarInjection(
  text: string,
  limit = 50,
  threshold = 0.85,
): Promise<SimilarInjectionResult[]> {
  const api = requireElectron();
  return api.injection.findSimilar(text, limit, threshold);
}
