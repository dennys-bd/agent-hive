import { useEffect, useState } from 'react';
import type { TaskTimeline } from '../../server-timeline.js';
import { getJson } from '../lib/api.js';

/** What the timeline section shows (#961): the skeleton, the failed block (a 503, a 5xx or an answer of another shape alike), or the list. */
export type TimelineRead = { kind: 'loading' } | { kind: 'error' } | { kind: 'list'; timeline: TaskTimeline };
const LOADING: TimelineRead = { kind: 'loading' };

// The answer crosses the network: anything without an events list is the failed state, never a crash in the panel
const isTimeline = (answer: unknown): answer is TaskTimeline =>
  typeof answer === 'object' && answer !== null && Array.isArray((answer as { events?: unknown }).events);

/** The task's timeline (#961), read on mount, on retry and when runKey moves; never per broadcast, no polling. A re-read keeps the shown list
 * until its answer replaces it, so a stage end does not flicker; a late answer (another task, or a newer read started) is dropped, as
 * useComments drops it. DetailPanel keys the section by task, so a new task mounts a fresh hook and never shows the last task's list. */
export function useTimeline(itemId: string, runKey: string): { read: TimelineRead; retry(): void } {
  const [read, setRead] = useState<TimelineRead>(LOADING);
  const [attempt, setAttempt] = useState(0); // retry's only job: a new value re-runs the read
  // biome-ignore lint/correctness/useExhaustiveDependencies: runKey and attempt are the triggers of a new read, not values it uses
  useEffect(() => {
    let live = true;
    setRead((shown) => (shown.kind === 'list' ? shown : LOADING));
    getJson<unknown>(`/tasks/${encodeURIComponent(itemId)}/timeline`).then(
      (answer) => { if (live) setRead(isTimeline(answer) ? { kind: 'list', timeline: answer } : { kind: 'error' }); },
      () => { if (live) setRead({ kind: 'error' }); },
    );
    return () => { live = false; };
  }, [itemId, runKey, attempt]);
  return { read, retry: () => setAttempt((n) => n + 1) };
}
