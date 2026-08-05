import { useEffect, useRef } from 'react';
import {
  logLoginTrace,
  createConversation,
  saveMessageWithMerge,
  notifyConversationPersisted,
} from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';
import { simpleHash } from '../utils';
import { SCRAPE_CHAT_SCRIPT, DETECT_LOGIN_SCRIPT } from '../scripts';

export function useConversationScrape({
  webviewRef,
  profile,
  tab,
  remountKey,
  domReadyRef,
  loggedLoginUrlsRef,
  lastLoginCheckedUrlRef,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  profile: Profile;
  tab: { id: string };
  remountKey: number;
  domReadyRef: React.MutableRefObject<boolean>;
  loggedLoginUrlsRef: React.MutableRefObject<Set<string>>;
  lastLoginCheckedUrlRef: React.MutableRefObject<string>;
}) {
  // 抓取状态：稳定性计数、上次持久化哈希、当前会话 id
  const stableCountRef = useRef(0);
  const lastPersistedHashRef = useRef<string>('');
  const conversationIdRef = useRef<string | null>(null);
  // 上次抓取到的对话 pairs 的哈希（用于稳定性判定，替代旧的 userText/assistantText 字段比较）
  const lastScrapedHashRef = useRef<string>('');
  // 上次抓取时的 URL pathname（pathname 变化视为切换到不同对话，重置 conversationId）
  const lastUrlPathRef = useRef<string>('');

  // 定期抓取网页对话内容并持久化到 SQLite（仅 AI 平台 Profile）
  // 策略：每 8 秒通过 executeJavaScript 取回「全量对话 pairs」{ pairs: [{user, assistant}], title, url }；
  //   连续两次抓取 pairs 哈希相同才视为「完成」并入库，避免在 AI 流式输出过程中存入半截回复；
  //   URL pathname 变化（切换到不同对话）时重置 conversationId，开启新会话；
  //   数据库 UNIQUE INDEX (conversation_id, content_hash) 兜底去重，全量重写也安全；
  //   同时监测 SPA 内 URL 变化（pushState 导航），变化时补做一次登录痕迹检测。
  useEffect(() => {
    if (!profile.isAIPlatform) return;
    const webview = webviewRef.current;
    if (!webview) return;
    let cancelled = false;

    // 持久化多轮对话（全量 pairs），按需创建会话。
    // 数据库 UNIQUE INDEX (conversation_id, content_hash) 自动去重，
    // 因此全量重写同一对话也安全，不会出现 DeepSeek 重复保存问题。
    const persistPairs = async (
      pairs: Array<{ user: string; assistant: string }>,
      title: string,
    ) => {
      console.log('[WebviewTab] persistPairs 开始, pairs=', pairs.length, 'title=', title, 'isNew=', !conversationIdRef.current);
      try {
        const isNewConversation = !conversationIdRef.current;
        if (isNewConversation) {
          // 记录对话发生时的页面 URL，用于"启动时打开最近对话"功能
          const currentUrl = webview.getURL();
          console.log('[WebviewTab] 创建新对话记录, profileId=', profile.id, 'url=', currentUrl);
          const conv = await createConversation(profile.id, 'webview', title || profile.name, currentUrl);
          if (cancelled) { console.log('[WebviewTab] persistPairs 取消（effect 已销毁）'); return; }
          conversationIdRef.current = conv.id;
          console.log('[WebviewTab] 新对话已创建, convId=', conv.id);
        }
        const cid = conversationIdRef.current;
        if (!cid) { console.log('[WebviewTab] persistPairs 跳过: cid 为空'); return; }
        let savedCount = 0;
        let skippedShort = 0;
        for (const pair of pairs) {
          // 需求 5：过滤 <15 字符的单方面文本（仅含标点/空白也过滤）
          if (pair.user && pair.user.trim().length >= 15) {
            await saveMessageWithMerge({ conversationId: cid, role: 'user', content: pair.user, autoGrabbed: true });
            savedCount++;
          } else if (pair.user) {
            skippedShort++;
          }
          if (pair.assistant && pair.assistant.trim().length >= 15) {
            await saveMessageWithMerge({ conversationId: cid, role: 'assistant', content: pair.assistant, autoGrabbed: true });
            savedCount++;
          } else if (pair.assistant) {
            skippedShort++;
          }
        }
        console.log('[WebviewTab] persistPairs 完成, convId=', cid, '已保存=', savedCount, '过滤短消息=', skippedShort);
        // 入库后通知主进程广播给其他窗口（HistoryView 订阅以实时刷新侧边栏）
        // 避免重复广播：仅新建对话或内容变化时触发（persistPairs 本身仅在哈希变化时调用）
        void notifyConversationPersisted(profile.id).catch((e) => {
          console.warn('[WebviewTab] 广播入库事件失败:', e);
        });
      } catch (e) {
        console.error('[WebviewTab] 对话持久化失败:', e);
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (!domReadyRef.current) return; // webview 未 ready 时跳过，避免 executeJavaScript 同步抛错
      try {
        const ret = await webview.executeJavaScript(SCRAPE_CHAT_SCRIPT);
        if (cancelled) return;
        const parsed = JSON.parse(String(ret)) as {
          pairs?: Array<{ user?: string; assistant?: string }>;
          title?: string;
          url?: string;
          error?: string;
        };
        if (parsed.error) return;

        const url = parsed.url || '';
        // URL pathname 变化 → 视为切换到不同对话：重置会话 id 与稳定性哈希
        let currentPath = '';
        try {
          currentPath = url ? new URL(url).pathname : '';
        } catch { /* 无效 URL 时保持空串 */ }
        if (currentPath && currentPath !== lastUrlPathRef.current) {
          console.log('[WebviewTab] URL pathname 变化, 旧=', lastUrlPathRef.current, '新=', currentPath);
          lastUrlPathRef.current = currentPath;
          conversationIdRef.current = null;
          lastScrapedHashRef.current = '';
          stableCountRef.current = 0;
          console.log('[WebviewTab] 已重置会话: convId=null, path=', currentPath);
        }

        // 截断每条 pair 的文本，避免单条消息过大
        const pairs = (parsed.pairs || [])
          .map((p) => ({
            user: (p.user || '').slice(0, 8000),
            assistant: (p.assistant || '').slice(0, 8000),
          }))
          .filter((p) => p.user || p.assistant);
        const title = parsed.title || '';

        // 稳定性判定：连续两次抓取 pairs 哈希相同 → 视为完成
        const currentHash = pairs.length > 0 ? simpleHash(JSON.stringify(pairs)) : '';
        if (currentHash && currentHash === lastScrapedHashRef.current) {
          stableCountRef.current += 1;
          console.log('[WebviewTab] 抓取稳定, stableCount=', stableCountRef.current, 'pairs=', pairs.length, 'path=', currentPath);
        } else {
          stableCountRef.current = 0;
          lastScrapedHashRef.current = currentHash;
        }

        // 连续第二次相同且与上次入库不同 → 入库
        if (
          stableCountRef.current === 1 &&
          pairs.length > 0 &&
          currentHash !== lastPersistedHashRef.current
        ) {
          console.log('[WebviewTab] 触发入库, pairs=', pairs.length, 'hash=', currentHash, '上次入库hash=', lastPersistedHashRef.current);
          lastPersistedHashRef.current = currentHash;
          void persistPairs(pairs, title);
        }

        // SPA 内 URL 变化时补做登录检测（覆盖 pushState/replaceState 导航，dom-ready 不触发的情况）
        if (url && url !== lastLoginCheckedUrlRef.current && !loggedLoginUrlsRef.current.has(url)) {
          lastLoginCheckedUrlRef.current = url;
          try {
            const lret = await webview.executeJavaScript(DETECT_LOGIN_SCRIPT);
            if (cancelled) return;
            const lp = JSON.parse(String(lret)) as {
              url?: string;
              cookie?: string;
              isLoggedIn?: boolean;
              error?: string;
            };
            if (!lp.error && lp.isLoggedIn && lp.url && !loggedLoginUrlsRef.current.has(lp.url)) {
              loggedLoginUrlsRef.current.add(lp.url);
              await logLoginTrace({
                profileId: profile.id,
                platform: profile.aiPlatformId,
                loginUrl: lp.url,
                sessionData: lp.cookie,
              });
            }
          } catch (e) {
            console.error('[WebviewTab] SPA 登录检测失败:', e);
          }
        }
      } catch (e) {
        console.error('[WebviewTab] 抓取失败:', e);
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.name, profile.isAIPlatform, profile.aiPlatformId, tab.id, remountKey]);
}
