import { useEffect, useState } from 'react';
import { emitConsoleChange } from '@/lib/console-events';
import { emitEditorInstall } from '@/lib/editor-install-events';
import { emitPrReviewEvent, emitReadModelEvent, emitReviewEvent, localReview, taskReview } from '@/lib/review-events';
import { emitTreeEvent } from '@/lib/tree-events';
import type { EditorInstallEvent, EffectiveLimits, EventsPayload, State } from '../../types.js';

const RERENDER_MS = 30_000;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Owns the EventSource: one State per event, rendered whole. `tick` moves the elapsed() readings between events. */
export function useHiveState(): { state: State | undefined; effective: EffectiveLimits | undefined; connected: boolean; tick: number } {
  const [state, setState] = useState<State>();
  const [effective, setEffective] = useState<EffectiveLimits>();
  const [connected, setConnected] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const source = new EventSource('/events');
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as EventsPayload;
      if ('workers' in payload) { // setup mode sends { configured: false }: nothing to show yet
        setState(payload);
        setEffective(payload.effective);
      }
    };
    source.addEventListener('review', (event) => { // a task's review file changed (#591), or a workspace's local one (#344): the panes showing it read it again
      const { taskId, workspace } = JSON.parse((event as MessageEvent<string>).data) as { taskId?: unknown; workspace?: unknown };
      if (typeof taskId === 'string') emitReviewEvent(taskReview(taskId));
      else if (typeof workspace === 'string') emitReviewEvent(localReview(workspace));
    });
    source.addEventListener('prReview', (event) => { // a PR's review file changed (#592): the PR page on that link reads it again
      const { url } = JSON.parse((event as MessageEvent<string>).data) as { url?: unknown };
      if (typeof url === 'string') emitPrReviewEvent(url);
    });
    source.addEventListener('readModel', (event) => { // a sync changed a repository's rows (#182): the views on it read again
      const { repository, kinds } = JSON.parse((event as MessageEvent<string>).data) as { repository?: unknown; kinds?: unknown };
      if (typeof repository === 'string' && isStrings(kinds)) emitReadModelEvent({ repository, kinds });
    });
    source.addEventListener('editorInstall', (event) => { // an install's state changed (#780): Settings and the language servers follow it
      const parsed = JSON.parse((event as MessageEvent<string>).data) as Partial<EditorInstallEvent>;
      if (typeof parsed.kind === 'string' && typeof parsed.id === 'string' && typeof parsed.state === 'object') emitEditorInstall(parsed as EditorInstallEvent);
    });
    source.addEventListener('console', () => emitConsoleChange()); // a console channel or a run's status changed (#780): the channel list reads again
    source.addEventListener('tree', (event) => { // a leased tree changed (#502): its activity's sidebar decides what to read again
      const { activityId, paths } = JSON.parse((event as MessageEvent<string>).data) as { activityId?: unknown; paths?: unknown };
      if (typeof activityId !== 'string') return;
      if (paths === undefined) emitTreeEvent({ type: 'tree', activityId });
      else if (isStrings(paths)) emitTreeEvent({ type: 'tree', activityId, paths });
    });
    source.onerror = () => setConnected(false); // the browser reconnects by itself
    const timer = setInterval(() => setTick((n) => n + 1), RERENDER_MS);
    return () => { source.close(); clearInterval(timer); };
  }, []);
  return { state, effective, connected, tick };
}
