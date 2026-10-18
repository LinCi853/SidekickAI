import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { dropFiles, onDownloadDone } from '../../../lib/electron-api';
import { useTabStore } from '../../../store/useTabStore';
import { useProfileStore } from '../../../store/useProfileStore';
import { buildFileDropScript, type DroppedFileInfo } from '../file-drop-script';
import type { WebviewElement } from '../../../lib/webview';
import type { AIPlatform } from '../../../lib/electron-api';

/** chat file-drop 脚本回执：成功/失败都由 guest 侧返回，避免"没导入却提示已导入" */
export interface FileDropResult { success?: boolean; method?: string; error?: string }

/** 把 guest 侧错误码翻译成用户能看懂的原因。
 *  只翻译白名单错误码：guest 返回的任意字符串不能直接进提示，
 *  否则页面内部异常（栈、内部 API 名）会外泄到界面，也可被用来伪造提示文案。 */
export function describeFileDropFailure(error?: string): string {
  switch (error) {
    case 'no-valid-files': return '文件无法读取，未导入';
    case 'no-target-found': return '未找到可接收文件的输入区域，请手动拖入或粘贴';
    default: return '导入失败，请手动拖入或粘贴';
  }
}

/**
 * Manages file drag-and-drop import from OS into the active webview,
 * plus download-done toast notifications.
 */
export function useFileDragDrop(platforms: AIPlatform[]) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const platformsRef = useRef<AIPlatform[]>(platforms);
  useEffect(() => { platformsRef.current = platforms; }, [platforms]);
  const { toast: downloadToast, showToast: showDownloadToast } = useToast(3000);

  // File drag-drop listeners
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.isTrusted || !hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!e.dataTransfer) return;
      const activeTabIdNow = useTabStore.getState().activeTabId;
      if (!activeTabIdNow) {
        showDownloadToast('没有激活的标签');
        return;
      }
      const wv = document.querySelector(
        `webview[data-tab-id="${activeTabIdNow}"]`,
      ) as WebviewElement | null;
      if (!wv) {
        showDownloadToast('未找到当前标签');
        return;
      }
      try {
        const fileInfos: DroppedFileInfo[] = await dropFiles();
        if (fileInfos.length === 0) {
          showDownloadToast('读取文件失败');
          return;
        }
        const activeTabNow = useTabStore.getState().tabs.find((t) => t.id === activeTabIdNow);
        const profileNow = activeTabNow
          ? useProfileStore.getState().profiles.find((p) => p.id === activeTabNow.profileId)
          : null;
        const platformNow = profileNow
          ? platformsRef.current.find((p) => p.id === profileNow.aiPlatformId || p.url === profileNow.aiPlatformUrl)
          : null;
        const dropOptions = platformNow
          ? { fileInputSelector: platformNow.fileInputSelector, dropZoneSelector: platformNow.dropZoneSelector }
          : undefined;
        const script = buildFileDropScript(fileInfos, dropOptions);
        // 脚本返回 Promise<{success, method|error}>；executeJavaScript 会等待它，
        // 因此「派发失败」不会再被当成「已导入」。
        const result = await wv.executeJavaScript(script) as FileDropResult | undefined;
        if (result?.success) {
          showDownloadToast(`已导入 ${fileInfos.length} 个文件到当前应用`);
        } else {
          showDownloadToast(describeFileDropFailure(result?.error));
        }
      } catch (err) {
        console.error('[MainView] 文件拖拽导入失败:', err);
        showDownloadToast('导入失败');
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [showDownloadToast]);

  // Download done toast
  useEffect(() => {
    const off = onDownloadDone(({ filename }) => {
      showDownloadToast(`下载完成：${filename}`);
    });
    return () => off();
  }, [showDownloadToast]);

  return { isDragOver, downloadToast };
}
