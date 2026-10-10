import type { Worker } from './types.js';

/** The server's timers for the runs waiting out an API error (#805): one per run, for the `until` it was set for. In memory, like the
 * approval hold: a restart closes every run anyway. */
export interface BackoffTimers {
  /** After every dispatch: a timer for each new wait, a new one for a wait whose `until` moved, none left for a run no longer waiting. */
  sync(workers: readonly Worker[]): void;
  /** close(): every timer goes. */
  close(): void;
}

export function createBackoffTimers(onDue: (ptyId: string, until: string) => void): BackoffTimers {
  const timers = new Map<string, { until: string; timer: NodeJS.Timeout }>();
  const clear = (ptyId: string): void => {
    clearTimeout(timers.get(ptyId)?.timer);
    timers.delete(ptyId);
  };
  // The timer hands back the `until` it read, so retryDue acts only on the wait it was armed for
  const arm = (ptyId: string, until: string): void => {
    const timer = setTimeout(() => {
      timers.delete(ptyId);
      onDue(ptyId, until);
    }, Math.max(0, Date.parse(until) - Date.now()));
    timers.set(ptyId, { until, timer });
  };
  return {
    sync(workers) {
      const waits = new Map(workers.flatMap((w): [string, string][] => (w.status === 'backoff' && w.runId !== undefined && w.backoff ? [[w.runId, w.backoff.until]] : [])));
      for (const [ptyId, armed] of [...timers]) {
        if (waits.get(ptyId) !== armed.until) clear(ptyId);
      }
      for (const [ptyId, until] of waits) {
        if (!timers.has(ptyId)) arm(ptyId, until);
      }
    },
    close() {
      for (const ptyId of [...timers.keys()]) clear(ptyId);
    },
  };
}
