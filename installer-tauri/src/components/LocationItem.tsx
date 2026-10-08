// installer-tauri/src/components/LocationItem.tsx
// 已扫描安装位置的一条摘要

import type { InstallLocation } from '../global'
import { formatVersion } from '../../../installer-shared/presentation/version'

export interface LocationItemProps {
  loc: InstallLocation
  isTarget: boolean
}

export default function LocationItem({ loc, isTarget }: LocationItemProps) {
  return (
    <div key={loc.path} className="loc-item">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="loc-item__path">{loc.path}</div>
        <div className="loc-item__meta">
          {loc.version && <span title={loc.version}>v{formatVersion(loc.version)}</span>}
          {loc.registered && <span>已注册</span>}
          {loc.runningPid > 0 && <span className="loc-running">运行中 (PID {loc.runningPid})</span>}
          {isTarget && <span style={{ color: 'var(--brand-500)' }}>本次目标</span>}
        </div>
      </div>
    </div>
  )
}
