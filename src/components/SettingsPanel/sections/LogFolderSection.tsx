import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { openLogsFolder } from '../../../lib/electron-api';
import { Button, SectionTitle } from '../../ui';
import { logDateRange } from '../../../../electron/shared/log-export';

export default function LogFolderSection() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [notice, setNotice] = useState('');

  const openFolder = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError('');
    setNotice('');
    try {
      const options = range === 'all' ? {} : { startDate, endDate };
      try { logDateRange(options); } catch { setError('请填写有效的日期范围，开始日期不能晚于结束日期'); return; }
      const result = await openLogsFolder(options);
      setNotice(result?.warnings ? `已导出，${result.warnings} 个来源未能读取，详情见导出清单` : '已按日期保存并打开日志文件夹');
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
      <p className="section-hint">导出登录、窗口、启动、点击及现存运行和维护日志，每次独立保存。旧维护日志按文件修改日期筛选。</p>
      <div className="log-export-controls">
        <label>导出范围 <select aria-label="日志导出范围" value={range} disabled={opening} onChange={event => setRange(event.target.value)}><option value="all">全部现存日志</option><option value="dates">指定日期</option></select></label>
        {range === 'dates' && <><label>开始日期 <input type="date" aria-label="日志开始日期" value={startDate} disabled={opening} onChange={event => setStartDate(event.target.value)} /></label>
          <label>结束日期 <input type="date" aria-label="日志结束日期" value={endDate} disabled={opening} onChange={event => setEndDate(event.target.value)} /></label></>}
      </div>
      <Button type="button" variant="outline" disabled={opening} onClick={() => void openFolder()}
        data-name="settings.advanced.logs.open-folder" aria-busy={opening}>
        <FolderOpen size={16} aria-hidden="true" />
        <span>导出并打开日志文件夹</span>
      </Button>
      {error && <p className="section-hint" role="alert" data-name="settings.advanced.logs.error">{error}</p>}
      {notice && <p className="section-hint" role="status">{notice}</p>}
    </section>
  );
}
