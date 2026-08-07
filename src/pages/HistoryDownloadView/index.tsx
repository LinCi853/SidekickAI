/* =====================================================================
   pages/HistoryDownloadView/index.tsx —— 历史记录与下载管理独立窗口
   架构：
   - 顶栏：StandaloneWindowHeader（标题 + 置顶 + 窗口控制）
   - 主体：左侧 SegmentedControl 切换「导航历史 / 下载管理」+ 右侧对应面板
   - ESC / Ctrl+W 关窗（useEscToCloseWindow）
   导航历史：SQLite 持久化（默认上限 1000 条），按时间分组 + 搜索 + 删除 + 清空
   下载管理：复用 browser-download-store，订阅 onDownloadUpdated 实时更新
   ===================================================================== */

import { useState } from 'react';
import WindowResizeHandles from '@/components/WindowResizeHandles';
import StandaloneWindowHeader from '@/components/StandaloneWindowHeader';
import { SegmentedControl } from '@/components/ui';
import { useEscToCloseWindow } from '@/hooks/useEscToCloseWindow';
import NavHistoryPanel from './NavHistoryPanel';
import DownloadPanel from './DownloadPanel';
import './styles.css';

type Tab = 'navHistory' | 'downloads';

export default function HistoryDownloadView() {
  const [tab, setTab] = useState<Tab>('navHistory');
  const [navCount, setNavCount] = useState(0);
  const [dlCount, setDlCount] = useState(0);

  // ESC / Ctrl+W 关窗
  useEscToCloseWindow();

  return (
    <>
      <WindowResizeHandles />
      <div
        className="history-download-view app-shell app-view-root hd-root"
        data-name="hd.container"
      >
        <StandaloneWindowHeader
          title="历史记录与下载管理"
          dataNamePrefix="hd.topbar"
          center={
            <span
              className="sw-header-title"
              data-name="hd.topbar.title"
            >
              历史记录与下载管理
            </span>
          }
        />

        <div className="hd-body" data-name="hd.body">
          {/* 左侧导航 */}
          <div className="hd-sidebar" data-name="hd.sidebar">
            <SegmentedControl<Tab>
              value={tab}
              onChange={setTab}
              data-name="hd.sidebar.segmented-control"
              name="hd-tab"
              className="hd-sidebar-segment"
              options={[
                { value: 'navHistory', label: '导航历史' },
                { value: 'downloads', label: '下载管理' },
              ]}
            />
            <div className="hd-sidebar-count" data-name="hd.sidebar.count">
              {tab === 'navHistory'
                ? `导航历史 ${navCount} 条`
                : `下载记录 ${dlCount} 条`}
            </div>
          </div>

          {/* 右侧内容区 */}
          {tab === 'navHistory' ? (
            <NavHistoryPanel onCountChange={setNavCount} />
          ) : (
            <DownloadPanel onCountChange={setDlCount} />
          )}
        </div>
      </div>
    </>
  );
}
