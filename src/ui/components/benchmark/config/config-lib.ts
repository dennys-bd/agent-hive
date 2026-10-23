// The config tab's pure parts (#463): the read rows' texts, the isolation scope and its risk, the env and scenario helpers, the evaluate rows.
import type { Arm, BenchIsolation, BenchRunStatus, BenchScenario, EvaluateRow, Experiment, IsolationRow } from '../../../../types.js';
import { ENV_NAME } from '../../../../types.js';
import { t, tPlural } from '@/i18n';
import { emptyRow, type EvaluateRowDraft, optional } from '@/lib/settings-stages';

export type SectionId = 'seed' | 'pace' | 'isolation' | 'blindness' | 'evaluation';
/** The route's COMMIT (src/state-guards.ts, which imports the orchestrator), mirrored: the form refuses what the PATCH would. */
export const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;
const RISKY_MODE = 'bypassPermissions';
// ponytail: the evaluate route's ENDED (server-benchmark-evaluate.ts), copied; interrupted runs are not judged again
const JUDGEABLE: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const THOUSAND = 1_000;
const MILLION = 1_000_000;

export interface DurationFields { hours: string; minutes: string }

export function durationText(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  if (hours === 0) return `${minutes}min`;
  return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}`;
}

export function durationFields(ms: number | undefined): DurationFields {
  if (ms === undefined) return { hours: '', minutes: '' };
  return { hours: String(Math.floor(ms / HOUR)), minutes: String(Math.round((ms % HOUR) / MINUTE)) };
}

const isWhole = (text: string): boolean => /^\d+$/.test(text.trim());

/** The two fields as ms: undefined when both are empty; NaN when either is not a whole number, or when they add up to 0. */
export function durationMs({ hours, minutes }: DurationFields): number | undefined {
  if (hours.trim() === '' && minutes.trim() === '') return undefined;
  const [h, m] = [hours, minutes].map((part) => (part.trim() === '' ? '0' : part));
  if (!isWhole(h) || !isWhole(m)) return Number.NaN;
  const ms = Number(h) * HOUR + Number(m) * MINUTE;
  return ms > 0 ? ms : Number.NaN;
}

export function tokenText(n: number): string {
  const short = (value: number, unit: string): string => `${Number(value.toFixed(1))}${unit}`;
  if (n >= MILLION) return short(n / MILLION, 'M');
  return n >= THOUSAND ? short(n / THOUSAND, 'k') : String(n);
}

export const resolve = <T>(row: IsolationRow<T>, armId: string): T => row.perArm?.[armId] ?? row.all;

/** The arms that run with no question asked and nothing denied: the spec's warning, never a block. */
export const riskyArms = (arms: readonly Arm[], isolation: Pick<BenchIsolation, 'permissionMode' | 'deniedTools'>): Arm[] =>
  arms.filter((arm) => resolve(isolation.permissionMode, arm.id) === RISKY_MODE && resolve(isolation.deniedTools, arm.id).length === 0);

/** varia por braço gives every arm the row's value; todos os braços drops perArm and keeps all. */
export function toggleScope<T>(row: IsolationRow<T>, armIds: readonly string[]): IsolationRow<T> {
  if (row.perArm !== undefined) return { all: row.all };
  return { all: row.all, perArm: Object.fromEntries(armIds.map((id) => [id, row.all])) };
}

export const mapRow = <A, B>(row: IsolationRow<A>, f: (value: A) => B): IsolationRow<B> => ({
  all: f(row.all),
  ...(row.perArm === undefined ? {} : { perArm: Object.fromEntries(Object.entries(row.perArm).map(([id, value]) => [id, f(value)])) }),
});

export const linesOf = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

export interface ParsedEnv { env: Record<string, string>; bad: string[] }

/** One NAME=value per line; a line whose name fails ENV_NAME (the route's check) is bad, kept as typed for the error. */
export function parseEnv(text: string): ParsedEnv {
  const lines = linesOf(text).map((line) => {
    const at = line.indexOf('=');
    return { line, name: at < 0 ? '' : line.slice(0, at).trim(), value: line.slice(at + 1) };
  });
  const good = lines.filter((l) => ENV_NAME.test(l.name));
  return { env: Object.fromEntries(good.map((l) => [l.name, l.value])), bad: lines.filter((l) => !ENV_NAME.test(l.name)).map((l) => l.line) };
}

export const envText = (env: Record<string, string>): string => Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n');

export function scenariosText(scenarios: readonly BenchScenario[]): string {
  const first = scenarios[0];
  const last = scenarios.at(-1);
  if (first === undefined || last === undefined) return t('benchmark.config.scenarios.none');
  const range = first === last ? first.id : `${first.id}–${last.id}`;
  return tPlural('benchmark.config.scenarios', scenarios.length, { n: scenarios.length, range });
}

export function nextScenarioId(scenarios: readonly BenchScenario[]): string {
  const taken = new Set(scenarios.map((s) => s.id.trim()));
  let n = 1;
  while (taken.has(`S${n}`)) n += 1;
  return `S${n}`;
}

export function scenarioIdsValid(scenarios: readonly BenchScenario[]): boolean {
  const ids = scenarios.map((s) => s.id.trim());
  return ids.every((id) => id !== '') && new Set(ids).size === ids.length;
}

export const rowText = (row: EvaluateRow): string => (row.model === undefined ? row.agent : `${row.agent} · ${row.model}`);
export const collectorText = (row: EvaluateRow): string => row.specializedAgent ?? rowText(row);

/** #877's EvaluateRow as the reviewer grid edits it, and back: '' is absent; focus stays only where the row has one. */
export const rowDraft = (row: EvaluateRow): EvaluateRowDraft => ({
  ...emptyRow(row.agent), model: row.model ?? '', specializedAgent: row.specializedAgent ?? '', focus: row.focus ?? '',
});
export const rowFrom = (draft: EvaluateRowDraft): EvaluateRow => ({
  agent: draft.agent, ...optional('model', draft.model), ...optional('specializedAgent', draft.specializedAgent), ...optional('focus', draft.focus),
});

export const judgeableRuns = (experiment: Experiment): number => experiment.rounds.flatMap((r) => r.runs).filter((r) => JUDGEABLE.includes(r.status)).length;
