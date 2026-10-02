import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { openLogsFolder } from '../../../lib/electron-api';
import { Button, SectionTitle } from '../../ui';

export default function LogFolderSection() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const openFolder = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError('');
    try {
      await openLogsFolder();
    } catch {
      setError('无法打开日志文件夹，请重试');
    } finally {
      pending.current = false;
      setOpening(false);
    }
  };

  return (
    <section data-name="settings.advanced.logs.section">
      <SectionTitle>日志</SectionTitle>
      <Button type="button" variant="outline" disabled={opening} onClick={() => void openFolder()}
        data-name="settings.advanced.logs.open-folder" aria-busy={opening}>
        <FolderOpen size={16} aria-hidden="true" />
        <span>打开日志文件夹</span>
      </Button>
      {error && <p className="section-hint" role="alert" data-name="settings.advanced.logs.error">{error}</p>}
    </section>
  );
}
