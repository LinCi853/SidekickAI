/* =====================================================================
   pages/BrowserView/cloud-pc-sites.ts —— 云电脑/云游戏网站识别
   检测到访问这类网站时提醒用户开启云电脑模式（设置内可手动开关）。
   域名匹配：主域或其子域命中即视为云电脑/云游戏站点。
   ===================================================================== */

/** 云电脑/云游戏平台域名（主域，匹配其任意子域） */
export const CLOUD_PC_SITES: { domain: string; name: string }[] = [
  // 云电脑平台（国内）
  { domain: 'yowa.qq.com', name: '腾讯先锋云游戏' },
  { domain: 'start.qq.com', name: '腾讯START云游戏' },
  { domain: 'cg.163.com', name: '网易云游戏' },
  { domain: 'ecloud.10086.cn', name: '中国移动云电脑' },
  { domain: 'desk.ctyun.cn', name: '天翼云电脑' },
  { domain: 'wuying.aliyun.com', name: '阿里无影云电脑' },
  { domain: 'yun.shunwang.com', name: '顺网云电脑' },
  { domain: 'dalongyun.com', name: '达龙云电脑' },
  { domain: 'migufun.com', name: '咪咕快游' },
  { domain: 'moguyou.com', name: '蘑菇云游' },
  { domain: 'huaweicloud.com', name: '华为云桌面' },
  // 云电脑/云游戏平台（国外）
  { domain: 'play.geforcenow.com', name: 'NVIDIA GeForce NOW' },
  { domain: 'luna.amazon.com', name: 'Amazon Luna' },
  { domain: 'xbox.com', name: 'Xbox Cloud Gaming' },
  { domain: 'shadow.tech', name: 'Shadow 云电脑' },
  { domain: 'parsec.app', name: 'Parsec' },
  { domain: 'web.parsec.gg', name: 'Parsec' },
  { domain: 'boosteroid.com', name: 'Boosteroid' },
];

/** 检测 URL 是否属于云电脑/云游戏站点；返回匹配的平台名或 null */
export function matchCloudPcSite(url: string): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const site of CLOUD_PC_SITES) {
      const d = site.domain.toLowerCase();
      if (host === d || host.endsWith('.' + d)) {
        return site.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}
