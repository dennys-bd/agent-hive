import { useEffect, useState } from 'react';

const TICK_MS = 1000; // a running clock must move

/** A re-render every second while `isTicking` (#914, #390), so a running clock moves; no timer otherwise. */
export function useTick(isTicking: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isTicking) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [isTicking]);
}
