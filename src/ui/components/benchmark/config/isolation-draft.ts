// The isolation form's draft (#463): every list and the env as the text its textarea shows, the limits as their fields, so typing a newline
// or a half-written number never loses what the user typed. Pure.
import type { BenchIsolation, IsolationRow } from '../../../../types.js';
import { type DurationFields, durationFields, durationMs, envText, linesOf, mapRow, parseEnv } from '@/components/benchmark/config/config-lib';
import type { MessageKey } from '@/i18n';

export interface LimitsDraft { turns: string; time: DurationFields }
export interface IsolationDraft {
  network: IsolationRow<string>; permissionMode: IsolationRow<string>; allowedTools: IsolationRow<string>; deniedTools: IsolationRow<string>;
  limits: IsolationRow<LimitsDraft>; env: IsolationRow<string>;
}
export type EditableKey = keyof IsolationDraft;

const listText = (list: string[]): string => list.join('\n');
const valuesOf = <T>(row: IsolationRow<T>): T[] => [row.all, ...Object.values(row.perArm ?? {})];
const isTurns = (text: string): boolean => text.trim() === '' || (/^\d+$/.test(text.trim()) && Number(text) >= 1);

export const isolationDraft = (iso: BenchIsolation): IsolationDraft => ({
  network: mapRow(iso.network, listText), permissionMode: iso.permissionMode, allowedTools: mapRow(iso.allowedTools, listText), deniedTools: mapRow(iso.deniedTools, listText),
  limits: mapRow(iso.limits, (l) => ({ turns: l.turns === undefined ? '' : String(l.turns), time: durationFields(l.ms) })), env: mapRow(iso.env, envText),
});

function limitsOf({ turns, time }: LimitsDraft): { turns?: number; ms?: number } {
  const ms = durationMs(time);
  return { ...(turns.trim() === '' ? {} : { turns: Number(turns) }), ...(ms === undefined ? {} : { ms }) };
}

/** The route's ISOLATION from the draft; ambiente and entre rodadas allow one value each, so they come from the experiment as they are. */
export const isolationFrom = (d: IsolationDraft, base: BenchIsolation): BenchIsolation => ({
  environment: base.environment, betweenRounds: base.betweenRounds, permissionMode: d.permissionMode,
  network: mapRow(d.network, linesOf), allowedTools: mapRow(d.allowedTools, linesOf), deniedTools: mapRow(d.deniedTools, linesOf),
  limits: mapRow(d.limits, limitsOf), env: mapRow(d.env, (text) => parseEnv(text).env),
});

// The route's limits, mirrored on every value of a row, each arm's included: an env name ENV_NAME refuses, turns below 1, a duration of 0
export function isolationErrors(d: IsolationDraft): Partial<Record<EditableKey, MessageKey>> {
  const isEnvBad = valuesOf(d.env).some((text) => parseEnv(text).bad.length > 0);
  const areLimitsBad = valuesOf(d.limits).some((l) => !isTurns(l.turns) || Number.isNaN(durationMs(l.time)));
  return { ...(isEnvBad ? { env: 'benchmark.config.error.env' as const } : {}), ...(areLimitsBad ? { limits: 'benchmark.config.error.limits' as const } : {}) };
}
