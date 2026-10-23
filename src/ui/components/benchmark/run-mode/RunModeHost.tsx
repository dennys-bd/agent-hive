import { useEffect } from 'react';
import { InterventionPopover } from '@/components/benchmark/run-mode/InterventionPopover';
import { refreshRunHive, RUN_POLL_MS, usePendingAsk, useRunHive } from '@/components/benchmark/run-mode/run-hive';

/** Run mode's own parts of the dashboard (#469): the popover while a write waits on it, and the count's poll (terminal input grows it on the
 * daemon, with no write here to re-read after). Nothing in a normal Hive. */
export function RunModeHost() {
  const run = useRunHive();
  const ask = usePendingAsk();
  const isRun = run !== undefined;
  useEffect(() => {
    if (!isRun) return undefined;
    const id = setInterval(() => void refreshRunHive(), RUN_POLL_MS);
    return () => clearInterval(id);
  }, [isRun]);
  return run !== undefined && ask !== undefined ? <InterventionPopover run={run} ask={ask} /> : null;
}
