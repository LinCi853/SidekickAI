// electron/store/cookie-copy.ts — Session Cookie 复制工具
//
// 从源 session 复制全部 Cookie 到目标 session。
// 用于浏览器窗口（persist:${profileId}-browser）从主窗口 session（persist:${profileId}）
// 继承登录态。

import type { Session } from 'electron'

/**
 * 从源 session 复制全部 Cookie 到目标 session。
 * 静默跳过单个 cookie 写入失败（如 domain 不合法、过期等）。
 */
export async function copySessionCookies(source: Session, target: Session): Promise<void> {
  const cookies = await source.cookies.get({})
  for (const cookie of cookies) {
    try {
      if (!cookie.domain) continue
      const scheme = cookie.secure ? 'https' : 'http'
      const domain = cookie.domain.replace(/^\./, '')
      const url = `${scheme}://${domain}${cookie.path || '/'}`
      await target.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite as 'no_restriction' | 'lax' | 'strict' | 'unspecified',
      })
    } catch {
      // skip individual cookie failures silently
    }
  }
}
