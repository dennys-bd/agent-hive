import { vi } from 'vitest';
import type { RunHive } from '@/components/benchmark/run-mode/run-hive';
import type { Intervention } from '../../src/types';
import { runMarker } from '../benchmark/fixtures';
import { jsonResponse } from '../fakes';

/** benchmark-run.hv.html's run: arm B of skills: comandos × plugin, pair 2 of 3, nothing recorded yet. */
export const RUN: RunHive = {
  marker: runMarker({ experiment: { id: 'skills-20261001-2130', name: 'skills: comandos × plugin' }, arm: { letter: 'B', name: 'skills do plugin' }, round: 2, pairs: 3, token: 'k9f2a6d1' }),
  interventions: [], home: 'bench/runs/k9f2a6d1',
};
export const frozen = (run: RunHive): RunHive => ({ ...run, marker: { ...run.marker, frozen: true } });

export interface RunCall { method: string; path: string }
const isWrite = (c: RunCall): boolean => c.method !== 'GET' && !c.path.startsWith('/view-state/');
/** The writes that went out, as `METHOD /path`. */
export const writes = (calls: RunCall[]): string[] => calls.filter(isWrite).map((c) => `${c.method} ${c.path}`);

/** fetch for a run's Hive: GET /benchmark-run answers `run` (404 without one) with one intervention per write let through so far, as 3.5
 * records them; every other call answers {ok:true}. */
export function stubRunFetch(run: RunHive | undefined): RunCall[] {
  const calls: RunCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const call = { method: init?.method ?? 'GET', path: String(input) };
    calls.push(call);
    if (call.path !== '/benchmark-run') return jsonResponse({ ok: true });
    if (run === undefined) return jsonResponse({ error: 'Not Found' }, 404);
    const recorded = calls.filter(isWrite).map((c): Intervention => ({ at: '2026-10-22T12:00:00.000Z', action: `${c.method} ${c.path}`, detail: c.path, by: 'user' }));
    return jsonResponse({ ...run, interventions: recorded });
  }));
  return calls;
}
