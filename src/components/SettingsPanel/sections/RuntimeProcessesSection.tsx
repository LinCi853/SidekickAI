import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getRuntimeProcesses } from '../../../lib/electron-api';
import type { RuntimeProcessRole, RuntimeProcessSnapshot } from '../../../../electron/shared/runtime-processes';
import { IconButton, SectionTitle } from '../../ui';
import './RuntimeProcessesSection.css';

const roles: Record<RuntimeProcessRole, string> = {
  main: '主程序', interface: '应用界面', webpage: '网页', renderer: '页面渲染',
  gpu: 'GPU 渲染', network: '网络服务', audio: '音频服务', video: '视频服务',
  utility: '后台服务', other: '其他进程',
};

export default function RuntimeProcessesSection({ active = true }: { active?: boolean }) {
  const [snapshot, setSnapshot] = useState<RuntimeProcessSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    setRefreshing(false);
    refresh.current = async () => {
      if (disposed || !active || document.hidden || pending.current) return;
      pending.current = true;
      setRefreshing(true);
      try {
        const value = await getRuntimeProcesses();
        if (!disposed && !document.hidden) {
          setSnapshot(value);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        pending.current = false;
        if (!disposed) setRefreshing(false);
      }
    };
    const visibilityChanged = () => {
      clearInterval(timer);
      if (!active || document.hidden) return;
      void refresh.current();
      timer = setInterval(() => { void refresh.current(); }, 2000);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active]);

  return (
    <section className="runtime-processes" data-name="settings.developer.processes.section">
      <SectionTitle actions={
        <IconButton type="button" aria-label="刷新进程信息" title="刷新进程信息" disabled={refreshing || !active}
          onClick={() => void refresh.current()} data-name="settings.developer.processes.refresh">
          <RefreshCw size={16} aria-hidden="true" />
        </IconButton>
      }>运行进程</SectionTitle>
      <div className="runtime-process-summary">
        <span data-name="settings.developer.processes.count">{snapshot ? `${snapshot.processes.length} 个进程` : error ? '未获取进程信息' : '正在读取'}</span>
        {snapshot && <time dateTime={new Date(snapshot.capturedAt).toISOString()}>
          {new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })}
        </time>}
      </div>
      {error && <p className="section-hint" role="alert">进程信息读取失败</p>}
      <div className="runtime-process-scroll" tabIndex={0} aria-label="运行进程列表">
        <table className="runtime-process-table" aria-label="运行进程" aria-busy={refreshing}>
          <colgroup><col className="process-role-column" /><col /><col className="process-pid-column" /><col className="process-cpu-column" /><col className="process-memory-column" /></colgroup>
          <thead><tr><th scope="col">职责</th><th scope="col">窗口与页面</th><th scope="col">PID</th><th scope="col">CPU</th><th scope="col" title="工作集内存">内存</th></tr></thead>
          <tbody>
            {snapshot?.processes.map(item => (
              <tr key={`${item.pid}:${item.creationTime}`} data-process-pid={item.pid} data-process-role={item.role}>
                <td>{roles[item.role]}</td>
                <td>{item.targets.length ? item.targets.map(target => (
                  <div className="runtime-process-target" key={`${target.webContentsId}:${target.kind}`}>
                    <span>{target.title || target.windowTitle || '未命名页面'}</span>
                    {target.kind === 'subframe' ? <small>页面子框架</small>
                      : target.windowTitle && target.windowTitle !== target.title && <small>{target.windowTitle}</small>}
                  </div>
                )) : item.name || 'SidekickAI'}</td>
                <td className="runtime-process-number">{item.pid}</td>
                <td className="runtime-process-number">{item.cpuPercent === null ? '--' : `${item.cpuPercent.toFixed(1)}%`}</td>
                <td className="runtime-process-number">{item.memoryBytes === null ? '--' : `${(item.memoryBytes / 1048576).toFixed(1)} MB`}</td>
              </tr>
            ))}
            {!snapshot && <tr><td colSpan={5}>{error ? '无法读取进程信息' : '正在读取进程信息'}</td></tr>}
            {snapshot?.processes.length === 0 && <tr><td colSpan={5}>暂无运行进程</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
