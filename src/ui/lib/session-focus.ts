import { useEffect, useSyncExternalStore } from 'react';
import { type Activity, activityKey, runSessions } from './activities.js';

// The last agent session in focus per activity (#113): the design pane's recipient. shownRun is empty while the design tab itself shows, so
// the session is remembered while a run's tab is shown, before. In memory for the window's life, never stored.

let focused: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** `session` as the activity's last in focus (#113); activity: its activityKey. */
export function rememberFocus(activity: string, session: string): void {
  if (focused[activity] === session) return;
  focused = { ...focused, [activity]: session };
  for (const listener of listeners) listener();
}

/** The activity's last session in focus (#113), re-rendering on a change; undefined before any. */
export const useFocusedSession = (activity: string): string | undefined => useSyncExternalStore(subscribe, () => focused[activity]);

/** Remembers the session of the run in focus (#113), where MainDock reads it. A terminal, a run with no session yet or no run in focus leave
 *  the last one. */
export function useRememberFocus(activity: Activity | undefined, run: string | undefined): void {
  const key = activity === undefined ? undefined : activityKey(activity);
  const session = activity === undefined || run === undefined ? undefined : runSessions(activity)[run];
  useEffect(() => {
    if (key !== undefined && session !== undefined) rememberFocus(key, session);
  }, [key, session]);
}
