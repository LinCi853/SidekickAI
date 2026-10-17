import { useEffect, useState, type ReactNode } from 'react';

/** 首次选中时加载，此后保持页面挂载和运行状态。 */
export default function DeferredTab({ active, children }: { active: boolean; children: ReactNode }) {
  const [activated, setActivated] = useState(active);
  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  return active || activated ? children : null;
}
