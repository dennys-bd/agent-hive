import { useEffect, useState } from 'react';
import { emitConsoleChange } from '@/lib/console-events';
import { emitEditorInstall } from '@/lib/editor-install-events';
import { emitPrReviewEvent, emitReadModelEvent, emitReviewEvent } from '@/lib/review-events';
import type { EditorInstallEvent, EffectiveLimits, EventsPayload, State } from '../../types.js';

const RERENDER_MS = 30_000;

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
    source.addEventListener('review', (event) => { // a task's review file changed (#591): the panes showing it read it again
      const { taskId } = JSON.parse((event as MessageEvent<string>).data) as { taskId?: unknown };
      if (typeof taskId === 'string') emitReviewEvent(taskId);
    });
    source.addEventListener('prReview', (event) => { // a PR's review file changed (#592): the PR page on that link reads it again
      const { url } = JSON.parse((event as MessageEvent<string>).data) as { url?: unknown };
      if (typeof url === 'string') emitPrReviewEvent(url);
    });
    source.addEventListener('readModel', (event) => { // #765 spike: a repository's rows changed: its lists and its open issue read again
      const { repository } = JSON.parse((event as MessageEvent<string>).data) as { repository?: unknown };
      if (typeof repository === 'string') emitReadModelEvent(repository);
    });
    source.addEventListener('editorInstall', (event) => { // an install's state changed (#780): Settings and the language servers follow it
      const parsed = JSON.parse((event as MessageEvent<string>).data) as Partial<EditorInstallEvent>;
      if (typeof parsed.kind === 'string' && typeof parsed.id === 'string' && typeof parsed.state === 'object') emitEditorInstall(parsed as EditorInstallEvent);
    });
    source.addEventListener('console', () => emitConsoleChange()); // a console channel or a run's status changed (#780): the channel list reads again
    source.onerror = () => setConnected(false); // the browser reconnects by itself
    const timer = setInterval(() => setTick((n) => n + 1), RERENDER_MS);
    return () => { source.close(); clearInterval(timer); };
  }, []);
  return { state, effective, connected, tick };
}
