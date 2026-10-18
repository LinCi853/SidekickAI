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

/** 指定日期是否可用：两端都填写且起始早于结束（后者按次日 0 点计算） */
function isValidCustomRange(startDate: string, endDate: string): boolean {
  if (!startDate || !endDate) return false;
  try { logDateRange({ startDate, endDate }); return true; } catch { return false; }
}

export default function LogFolderSection() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState<'recent' | 'all' | 'custom'>('recent');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [notice, setNotice] = useState('');

  const customValid = isValidCustomRange(startDate, endDate);
  const dateInvalid = range === 'custom' && !!startDate && !!endDate && !customValid;
  const exportDisabled = opening || (range === 'custom' && !customValid);

  const openFolder = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError('');
    setNotice('');
    try {
      const options = range === 'all' ? {} : range === 'custom' ? { startDate, endDate } : recentRange(30);
      try { logDateRange(options); } catch { setError(range === 'custom' ? '开始日期不能晚于结束日期' : '日期范围无效'); return; }
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
            { value: 'custom' as const, label: '指定日期' },
          ]}
          onChange={(v) => { setRange(v); setError(''); setNotice(''); }}
          disabled={opening}
          name="日志导出范围"
          className="seg-control-row"
        />
        <Button
          type="button"
          variant="outline"
          className="btn-outline-sm"
          disabled={exportDisabled}
          onClick={() => void openFolder()}
          data-name="settings.advanced.logs.open-folder"
          aria-busy={opening}
        >
          <FolderOpen size={16} aria-hidden="true" />
          <span>导出并打开</span>
        </Button>
      </FormRow>
      {range === 'custom' && (
        <FormRow label="导出日期">
          <input
            type="date"
            className="input-underline"
            value={startDate}
            max={endDate || undefined}
            onChange={(e) => { setStartDate(e.target.value); setError(''); setNotice(''); }}
            disabled={opening}
            aria-label="导出开始日期"
            data-name="settings.advanced.logs.start-date"
          />
          <span className="form-row-hint" aria-hidden="true">至</span>
          <input
            type="date"
            className="input-underline"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => { setEndDate(e.target.value); setError(''); setNotice(''); }}
            disabled={opening}
            aria-label="导出结束日期"
            data-name="settings.advanced.logs.end-date"
          />
        </FormRow>
      )}
      {dateInvalid && <p className="feedback-text fail" data-name="settings.advanced.logs.date-error">开始日期不能晚于结束日期</p>}
      {error && <p className="feedback-text fail" role="alert" data-name="settings.advanced.logs.error">{error}</p>}
      {notice && <p className="feedback-text ok" role="status">{notice}</p>}
    </section>
  );
}
