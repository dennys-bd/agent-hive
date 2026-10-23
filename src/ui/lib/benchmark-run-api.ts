// The benchmark run routes the execution tab and the header's run controls call (#465): api.benchmark.run-hive (#475) here, the control
// routes (#472) beside it. A refusal shows as the i18n line its code names; the server's own words never reach the screen.
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
