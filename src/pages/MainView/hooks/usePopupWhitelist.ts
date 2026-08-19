import { useEffect } from 'react';
import {
  onPopupDenied,
  addToPopupWhitelist,
  addToProfilePopupWhitelist,
} from '../../../lib/electron-api';

/**
 * 弹窗被连续拦截 3 次后，主进程通过 onPopupDenied 通知渲染层：
 * 弹出 confirm 对话框询问用户是否将该 origin 加入白名单（登录/验证页通常需要弹独立窗口）。
 * 白名单写入策略：优先写入当前 tab 所属 Profile 的专属白名单（Profile.popupWhitelist），
 * 避免不同 AI 应用的关联域互相污染全局白名单；profileId 不可用时回退到全局白名单。
 */
export function usePopupWhitelist({
  profileId,
}: {
  profileId: string;
}) {
  useEffect(() => {
    const off = onPopupDenied(({ origin, count }) => {
      console.log(`[WebviewTab] 弹窗被拦截 ${count} 次，提示加白:`, origin);
      const ok = window.confirm(
        `检测到弹窗被多次拦截：\n${origin}\n\n是否允许该站点弹窗？（登录/验证页面通常需要）`,
      );
      if (ok) {
        // 优先写入 Profile 专属白名单（隔离不同 AI 应用的关联域）
        if (profileId) {
          void addToProfilePopupWhitelist(profileId, origin);
        } else {
          // 回退：无 profileId（异常情况）写入全局白名单
          void addToPopupWhitelist(origin);
        }
      }
    });
    return () => off();
  }, [profileId]);
}
