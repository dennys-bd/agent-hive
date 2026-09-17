import { useEffect, useState } from 'react';
import type { EventsPayload, State } from '../../types.js';

const RERENDER_MS = 30_000;

/** Owns the EventSource: one State per event, rendered whole. `tick` moves the elapsed() readings between events. */
export function useHiveState(): { state: State | undefined; connected: boolean; tick: number } {
  const [state, setState] = useState<State>();
  const [connected, setConnected] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const source = new EventSource('/events');
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as EventsPayload;
      if ('slots' in payload) setState(payload); // setup mode sends { configured: false }: nothing to show yet
    };
    source.onerror = () => setConnected(false); // the browser reconnects by itself
    const timer = setInterval(() => setTick((n) => n + 1), RERENDER_MS);
    return () => { source.close(); clearInterval(timer); };
  }, []);
  return { state, connected, tick };
}
