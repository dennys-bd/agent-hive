// The benchmark run routes the execution tab and the header's run controls call (#465): api.benchmark.run-hive (#475) here, the control
// routes (#472) beside it. A refusal shows as the i18n line its code names; the server's own words never reach the screen.
import { type MessageKey, t } from '../i18n.js';
import { postJson } from './api.js'; // relative: the root tsc compiles this file too

const pathOf = (id: string, rest: string): string => `/benchmark/experiments/${encodeURIComponent(id)}/${rest}`;

/** abrir: the run's daemon, its frozen one booted when it ended; the answer sets the window's cookie for that port (#475). */
export const openRunHive = (id: string, token: string): Promise<{ port: number }> =>
  postJson<{ port: number }>(pathOf(id, `runs/${encodeURIComponent(token)}/open`));

/** The run's own Hive: this host, the answered port. */
export const runHiveUrl = (port: number, { protocol, hostname }: Pick<Location, 'protocol' | 'hostname'>): string => `${protocol}//${hostname}:${port}/`;

export function goToRunHive(port: number): void {
  window.location.assign(runHiveUrl(port, window.location));
}

export const runExperiment = (id: string): Promise<unknown> => postJson(pathOf(id, 'run'));
export const stopAfterRound = (id: string): Promise<unknown> => postJson(pathOf(id, 'stop-after-round'));
export const moreRounds = (id: string, pairs: number): Promise<unknown> => postJson(pathOf(id, 'more-rounds'), { pairs });

// The control routes' refusal codes (server-benchmark-control.ts, runner.ts's StartAnswer); a Map, so no code reaches a prototype key
const REFUSAL = new Map<string, MessageKey>([
  ['live', 'benchmark.execution.failed.live'], ['locked', 'benchmark.execution.failed.locked'],
  ['nothing_missing', 'benchmark.execution.failed.nothingMissing'], ['status', 'benchmark.execution.failed.status'],
]);
const BLIND_WHERE = / in (.+)$/; // blindnessMessage (run-home.ts): `blindness: "<word>" in <where>`

/** A refused control route's line: the blindness one names where the forbidden word sits, the others their own, else Erro inesperado. */
export function refusalText(err: unknown): string {
  const body = (err as { body?: { error?: unknown; message?: unknown } } | undefined)?.body;
  const code = typeof body?.error === 'string' ? body.error : '';
  if (code === 'blindness' && typeof body?.message === 'string') {
    return t('benchmark.execution.failed.blindness', { file: BLIND_WHERE.exec(body.message)?.[1] ?? body.message });
  }
  return t(REFUSAL.get(code) ?? 'benchmark.execution.failed.unknown');
}
