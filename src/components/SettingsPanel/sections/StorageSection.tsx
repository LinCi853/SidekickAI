import { useEffect, useState } from 'react';
import {
  estimateCacheSize,
  cleanCache,
  updateAppSettings,
  selectDownloadDir,
  openDownloadDir,
} from '../../../lib/electron-api';
import SegmentedControl from '../../ui/SegmentedControl';
import { SectionTitle, FormRow } from '../../ui';
import { useSettingsDraft } from '../../../hooks/useSettingsData';
import { useFeedbackToast } from '../../../hooks/useFeedbackToast';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString();
}

export default function StorageSection() {
  const { draft, setDraft } = useSettingsDraft();
  const { feedback: cleanFeedback, showFeedback, clearFeedback } = useFeedbackToast(3000);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [lastCleaned, setLastCleaned] = useState<number>(0);
  const [selectingDir, setSelectingDir] = useState(false);

  // 从草稿派生设置值
  const autoClean = draft?.cacheAutoClean || 'never';
  const downloadDir = draft?.downloadDir || '';
  const downloadBehavior = draft?.downloadBehavior || 'ask';

  useEffect(() => {
    void estimateCacheSize().then(setCacheSize).catch(() => {});
  }, []);

  // 当草稿加载/变化时同步 lastCleaned
  useEffect(() => {
    setLastCleaned(draft?.lastCacheCleanAt || 0);
  }, [draft?.lastCacheCleanAt]);

  const handleClean = async () => {
    setCleaning(true);
    clearFeedback();
    try {
      const result = await cleanCache();
      setCacheSize(0);
      setLastCleaned(Date.now());
      showFeedback(`已清理 ${formatBytes(result.cleanedBytes)}`);
    } catch (err) {
      console.error('[StorageSection] 缓存清理失败:', err);
      showFeedback('清理失败，请查看日志');
    } finally {
      setCleaning(false);
    }
  };

  const handleAutoCleanChange = async (value: 'never' | 'daily' | 'weekly' | 'monthly') => {
    const prev = autoClean;
    setDraft({ cacheAutoClean: value });
    try {
      await updateAppSettings({ cacheAutoClean: value });
    } catch (err) {
      console.error('[StorageSection] 更新自动清理频率失败:', err);
      setDraft({ cacheAutoClean: prev });
    }
  };

  const handleSelectDownloadDir = async () => {
    if (selectingDir) return;
    setSelectingDir(true);
    try {
      const dir = await selectDownloadDir();
      if (!dir) return;
      setDraft({ downloadDir: dir });
      try {
        await updateAppSettings({ downloadDir: dir });
      } catch (err) {
        console.error('[StorageSection] 保存下载目录失败:', err);
        setDraft({ downloadDir: '' });
      }
    } catch (err) {
      console.error('[StorageSection] 选择下载目录失败:', err);
    } finally {
      setSelectingDir(false);
    }
  };

  const handleBehaviorChange = async (value: 'ask' | 'auto') => {
    const prev = downloadBehavior;
    setDraft({ downloadBehavior: value });
    try {
      await updateAppSettings({ downloadBehavior: value });
    } catch (err) {
      console.error('[StorageSection] 更新下载行为失败:', err);
      setDraft({ downloadBehavior: prev });
    }
  };

  return (
    <section data-name="settings.storage.section">
      <SectionTitle>缓存清理</SectionTitle>
      <div className="about-row" data-name="settings.storage.cache-size-row">
        <span data-name="settings.storage.cache-size-label">当前缓存体积</span>
        <span data-name="settings.storage.cache-size-value">{cacheSize === null ? '计算中…' : formatBytes(cacheSize)}</span>
      </div>
      <div className="about-row" data-name="settings.storage.last-cleaned-row">
        <span data-name="settings.storage.last-cleaned-label">上次清理</span>
        <span data-name="settings.storage.last-cleaned-value">{formatRelativeTime(lastCleaned)}</span>
      </div>
      <FormRow label="自动清理">
        <SegmentedControl
          value={autoClean}
          options={[
            { value: 'never' as const, label: '从不' },
            { value: 'daily' as const, label: '每天' },
            { value: 'weekly' as const, label: '每周' },
            { value: 'monthly' as const, label: '每月' },
          ]}
          onChange={(v) => void handleAutoCleanChange(v)}
          name="自动清理"
          className="proxy-mode-group"
        />
      </FormRow>
      <div className="proxy-actions" data-name="settings.storage.cache-actions">
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleClean()}
          disabled={cleaning}
          data-name="settings.storage.clean-button"
        >
          {cleaning ? '清理中…' : '立即清理'}
        </button>
        {cleanFeedback && (
          <span className="settings-feedback feedback-text ok" data-name="settings.storage.clean-feedback">{cleanFeedback}</span>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionTitle>下载</SectionTitle>
      </div>
      <div className="about-row" data-name="settings.storage.download-dir-row">
        <span data-name="settings.storage.download-dir-label">下载目录</span>
        <span
          style={{
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
          title={downloadDir || '系统下载目录'}
          data-name="settings.storage.download-dir-value"
        >
          {downloadDir || '系统下载目录'}
        </span>
      </div>
      <FormRow label="下载行为">
        <SegmentedControl
          value={downloadBehavior}
          options={[
            { value: 'ask' as const, label: '每次询问' },
            { value: 'auto' as const, label: '自动保存到目录' },
          ]}
          onChange={(v) => void handleBehaviorChange(v)}
          name="下载行为"
          className="proxy-mode-group"
        />
      </FormRow>
      <div className="proxy-actions" data-name="settings.storage.download-actions">
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void handleSelectDownloadDir()}
          disabled={selectingDir}
          data-name="settings.storage.select-dir-button"
        >
          {selectingDir ? '选择中…' : '修改目录'}
        </button>
        <button
          type="button"
          className="btn-text"
          style={{ padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6, fontWeight: 600 }}
          onClick={() => void openDownloadDir()}
          data-name="settings.storage.open-dir-button"
        >
          打开目录
        </button>
      </div>
    </section>
  );
}
