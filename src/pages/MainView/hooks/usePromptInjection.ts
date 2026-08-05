import { useCallback, useEffect, useRef, useState } from 'react';
import { injectTextToWebview, type WebviewLike } from '../../../hooks/useWebViewControl';
import { findSimilarInjection, logInjection, onPromptInjectRequest, sendPromptInjectResult } from '../../../lib/electron-api';
import { composeFinalText } from '../../../lib/prompt-placeholders';
import { usePromptHotkeys } from '../../../hooks/usePromptHotkeys';
import type { AIPlatform, Profile, PromptTemplate, SimilarInjectionResult } from '../../../lib/electron-api';

interface Tab {
  id: string;
  profileId: string;
}

/**
 * Manages the prompt injection pipeline: composition, preview modal, similarity check,
 * injection execution, and history logging.
 */
export function usePromptInjection(
  activeTab: Tab | null,
  getProfile: (profileId: string) => Profile | null,
  platforms: AIPlatform[],
) {
  const [previewState, setPreviewState] = useState<{
    open: boolean;
    composedText: string;
    similarRecords: SimilarInjectionResult[];
  }>({ open: false, composedText: '', similarRecords: [] });

  const pendingInjectionRef = useRef<{
    template: PromptTemplate;
    source: 'inline' | 'detached';
    webview: WebviewLike;
    selector: string | null;
    platformName?: string;
    resolve: (result: { success: boolean; platformName?: string }) => void;
  } | null>(null);

  const handleInjectPrompt = useCallback(
    async (
      template: PromptTemplate,
      source: 'inline' | 'detached' = 'inline',
      skipPreview = false,
    ): Promise<{ success: boolean; platformName?: string }> => {
      if (!activeTab) return { success: false };
      const profile = getProfile(activeTab.profileId);
      const platform = profile?.aiPlatformUrl
        ? platforms.find((p) => p.url === profile.aiPlatformUrl)
        : undefined;
      const selector = profile?.aiInputSelector || platform?.inputSelector || null;
      const el = document.querySelector(`webview[data-tab-id="${activeTab.id}"]`) as WebviewLike | null;
      if (!el) return { success: false };

      let selection = '';
      try {
        const script = `(function(sel) {
          var el = null;
          if (sel) {
            var parts = sel.split(',');
            for (var i = 0; i < parts.length; i++) {
              var found = document.querySelector(parts[i].trim());
              if (found) { el = found; break; }
            }
          }
          if (!el) el = document.querySelector('textarea:not([disabled]):not([readonly])')
                 || document.querySelector('input[type=text]:not([disabled]):not([readonly])')
                 || document.querySelector('div[contenteditable=true]');
          if (!el) return '';
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
          if (el.isContentEditable) return el.innerText || el.textContent || '';
          return '';
        })(${JSON.stringify(selector)})`;
        const result = await el.executeJavaScript(script);
        selection = typeof result === 'string' ? result : '';
      } catch (e) {
        console.warn('[MainView] 读取 webview 输入框内容失败:', e);
      }

      const composedText = composeFinalText(template, { body: selection });

      if (skipPreview) {
        const ok = await injectTextToWebview(el, composedText, selector);
        try {
          await logInjection({
            composedText,
            templateId: template.id,
            windowId: source === 'detached' ? 'detached-prompt-window' : 'main',
          });
        } catch (e) {
          console.warn('[MainView] 记录注入历史失败:', e);
        }
        if (source === 'detached') {
          sendPromptInjectResult({ success: ok, platformName: platform?.name });
        }
        return { success: ok, platformName: platform?.name };
      }

      let similarRecords: SimilarInjectionResult[] = [];
      try {
        similarRecords = await findSimilarInjection(composedText, 20, 0.85);
      } catch (e) {
        console.warn('[MainView] 查询相似注入记录失败:', e);
      }

      return new Promise<{ success: boolean; platformName?: string }>((resolve) => {
        pendingInjectionRef.current = {
          template,
          source,
          webview: el,
          selector,
          platformName: platform?.name,
          resolve,
        };
        setPreviewState({ open: true, composedText, similarRecords });
      });
    },
    [activeTab, getProfile, platforms],
  );

  const handleConfirmInjection = useCallback(
    async (editedText: string) => {
      const pending = pendingInjectionRef.current;
      if (!pending) {
        setPreviewState((s) => ({ ...s, open: false }));
        return;
      }
      const { template, source, webview, selector, platformName, resolve } = pending;
      const ok = await injectTextToWebview(webview, editedText, selector);
      try {
        await logInjection({
          composedText: editedText,
          templateId: template.id,
          windowId: source === 'detached' ? 'detached-prompt-window' : 'main',
        });
      } catch (e) {
        console.warn('[MainView] 记录注入历史失败:', e);
      }
      if (source === 'detached') {
        sendPromptInjectResult({ success: ok, platformName });
      }
      resolve({ success: ok, platformName });
      pendingInjectionRef.current = null;
      setPreviewState({ open: false, composedText: '', similarRecords: [] });
    },
    [],
  );

  const handleCancelInjection = useCallback(() => {
    const pending = pendingInjectionRef.current;
    if (!pending) {
      setPreviewState({ open: false, composedText: '', similarRecords: [] });
      return;
    }
    if (pending.source === 'detached') {
      sendPromptInjectResult({ success: false });
    }
    pending.resolve({ success: false });
    pendingInjectionRef.current = null;
    setPreviewState({ open: false, composedText: '', similarRecords: [] });
  }, []);

  usePromptHotkeys({
    onTriggered: (template, options) => {
      void handleInjectPrompt(template, 'inline', options?.skipPreview);
    },
  });

  useEffect(() => {
    const off = onPromptInjectRequest((template) => {
      void (async () => {
        await handleInjectPrompt(template, 'detached');
      })();
    });
    return () => off();
  }, [handleInjectPrompt]);

  return {
    previewState,
    handleInjectPrompt,
    handleConfirmInjection,
    handleCancelInjection,
  };
}
