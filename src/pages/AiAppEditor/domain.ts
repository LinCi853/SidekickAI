/** 从 URL 提取 hostname（用于屏蔽规则域名匹配） */
export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 简单 glob 域名匹配（支持 `*` 通配所有 / `*.domain.com` 匹配子域 / 精确域名）。
 * 仅用于屏蔽规则筛选，非安全敏感场景。
 */
export function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (!hostname) return false;
  if (pattern === hostname) return true;
  // *.domain.com → 匹配 domain.com 与任意子域
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .domain.com
    return hostname === pattern.slice(2) || hostname.endsWith(suffix);
  }
  return false;
}

/** 校验十六进制颜色（#RGB / #RRGGBB） */
export function isValidHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}
