import { useEffect, useState, type ReactNode } from 'react';

export default function DeferredTab({ active, children }: { active: boolean; children: ReactNode }) {
  const [activated, setActivated] = useState(active);
  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  return active || activated ? children : null;
}
