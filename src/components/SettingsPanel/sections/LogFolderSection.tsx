import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { openLogsFolder } from '../../../lib/electron-api';
import { Button, FormRow, SectionTitle } from '../../ui';
import SegmentedControl from '../../ui/SegmentedControl';
import { localLogDate, logDateRange } from '../../../../electron/shared/log-export';

/** 近 N 天导出范围（默认 30 天） */
function recentRange(days = 30): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { startDate: localLogDate(start), endDate: localLogDate(end) };
}

export default function LogFolderSection() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState<'recent' | 'all'>('recent');
  const [notice, setNotice] = useState('');

  const openFolder = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError('');
    setNotice('');
    try {
      const options = range === 'all' ? {} : recentRange(30);
      try { logDateRange(options); } catch { setError('日期范围无效'); return; }
      const result = await openLogsFolder(options);
      setNotice(result?.warnings ? `已导出，${result.warnings} 个来源未能读取` : '已保存并打开日志文件夹');
    } catch {
      setError('日志导出或打开失败，请检查日志目录后重试');
    } finally {
      pending.current = false;
      setOpening(false);
    }
  };

  return (
    <section data-name="settings.advanced.logs.section">
      <SectionTitle>日志</SectionTitle>
      <FormRow label="导出范围">
        <SegmentedControl
          value={range}
          options={[
            { value: 'recent' as const, label: '近 30 天' },
            { value: 'all' as const, label: '全部' },
          ]}
          onChange={(v) => setRange(v)}
          disabled={opening}
          name="日志导出范围"
          className="seg-control-row"
        />
        <Button
          type="button"
          variant="outline"
          className="btn-outline-sm"
          disabled={opening}
          onClick={() => void openFolder()}
          data-name="settings.advanced.logs.open-folder"
          aria-busy={opening}
        >
          <FolderOpen size={16} aria-hidden="true" />
          <span>导出并打开</span>
        </Button>
      </FormRow>
      {error && <p className="feedback-text fail" role="alert" data-name="settings.advanced.logs.error">{error}</p>}
      {notice && <p className="feedback-text ok" role="status">{notice}</p>}
    </section>
  );
}
