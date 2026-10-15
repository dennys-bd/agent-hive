import { basename, join, relative } from 'node:path';
import { pngsIn, readJson, writeText } from './files.js';
import { latest, runBranch, runOrder } from './plan.js';
import { type Arm, type Click, CRITERIA, type EvalResult, FILES, type Judge, type Manifest, type Metrics, type RunRef } from './types.js';

export interface RunRecord { ref: RunRef; token?: string; metrics?: Metrics; evaluation?: EvalResult; clicks?: Click[]; judge?: Judge; shots: string[] }
export interface Stat { mean: number; min: number; max: number; n: number }
export interface Rate { passed: number; total: number }
interface Measure { label: string; of(record: RunRecord): number | undefined }

const minutes = (ms: number): number => Math.round(ms / 60_000);
const percent = (part: number, whole: number): number => Math.round((100 * part) / whole);
const ARM_LINES = ['- Arm A: the repository commands, `/hive-spec`, `/hive-plan`, `/hive-build`.', '- Arm B: the plugin skills, `/hive:new-spec`, `/hive:new-plan`, `/hive:new-build`.'];
const RUN_HEAD = ['run', 'token', 'status', 'tests', 'tokens', 'worker minutes', 'Build restarts', 'diff lines', 'clicks', ...CRITERIA];

export function stat(values: readonly number[]): Stat | undefined {
  if (values.length === 0) return undefined;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values), n: values.length };
}

/** A value a run lacks is skipped, never read as 0. */
export const MEASURES: readonly Measure[] = [
  { label: 'tokens', of: (r) => r.metrics?.tokens },
  { label: 'worker minutes', of: (r) => (r.metrics ? minutes(r.metrics.ms) : undefined) },
  { label: 'waiting minutes', of: (r) => (r.metrics ? minutes(r.metrics.waitingMs) : undefined) },
  { label: 'wall clock minutes', of: (r) => (r.metrics ? minutes(Date.parse(r.metrics.endedAt) - Date.parse(r.metrics.startedAt)) : undefined) },
  { label: 'Build restarts', of: (r) => r.metrics?.buildRestarts },
  { label: 'diff lines', of: (r) => (r.metrics ? r.metrics.diff.insertions + r.metrics.diff.deletions : undefined) },
  { label: 'tests green (1/0)', of: (r) => (r.evaluation ? Number(r.evaluation.testsGreen) : undefined) },
  { label: 'clicks passed (%)', of: (r) => (r.clicks && r.clicks.length > 0 ? percent(r.clicks.filter((c) => c.passed).length, r.clicks.length) : undefined) },
  ...CRITERIA.map((c): Measure => ({ label: `score: ${c}`, of: (r) => r.judge?.scores[c].score ?? undefined })),
];

const byArm = <T>(f: (arm: Arm) => T): Record<Arm, T> => ({ a: f('a'), b: f('b') });
const valuesOf = (records: readonly RunRecord[], arm: Arm, measure: Measure): number[] =>
  records.filter((r) => r.ref.arm === arm).flatMap((r) => {
    const value = measure.of(r);
    return value === undefined ? [] : [value];
  });

export const aggregate = (records: readonly RunRecord[]): { label: string; arms: Record<Arm, Stat | undefined> }[] =>
  MEASURES.map((m) => ({ label: m.label, arms: byArm((arm) => stat(valuesOf(records, arm, m))) }));

function rate(records: readonly RunRecord[], arm: Arm, scenario: string): Rate {
  const clicks = records.filter((r) => r.ref.arm === arm).flatMap((r) => r.clicks?.filter((c) => c.scenario === scenario) ?? []);
  return { passed: clicks.filter((c) => c.passed).length, total: clicks.length };
}

export function clickRates(records: readonly RunRecord[]): { scenario: string; arms: Record<Arm, Rate> }[] {
  const scenarios = [...new Set(records.flatMap((r) => r.clicks?.map((c) => c.scenario) ?? []))].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
  return scenarios.map((scenario) => ({ scenario, arms: byArm((arm) => rate(records, arm, scenario)) }));
}

/** An unpaired run ran alone, so its timing and plan pressure are not its pair's (#105, the user). */
export function runStatus(r: RunRecord): string {
  if (!r.metrics) return 'not run';
  const outcome = `${r.metrics.reason ? `${r.metrics.outcome} (${r.metrics.reason})` : r.metrics.outcome}${r.metrics.unpaired ? ', unpaired' : ''}`;
  if (!r.evaluation) return `${outcome}, not evaluated`;
  return r.evaluation.booted ? outcome : `${outcome}, did not boot`;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const cells = (s: Stat | undefined): string[] => (s ? [fmt(s.mean), `${fmt(s.min)}–${fmt(s.max)}`] : ['–', '–']);
const table = (head: readonly string[], rows: string[][]): string => [[...head], head.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');

function runRow(r: RunRecord): string[] {
  const m = r.metrics;
  const tests = r.evaluation ? (r.evaluation.testsGreen ? 'green' : 'red') : '–';
  const clicks = r.clicks ? `${r.clicks.filter((c) => c.passed).length}/${r.clicks.length}` : '–';
  const numbers = m ? [String(m.tokens), String(minutes(m.ms)), String(m.buildRestarts), String(m.diff.insertions + m.diff.deletions)] : ['–', '–', '–', '–'];
  return [r.ref.id.toUpperCase(), r.token ? `\`${r.token}\`` : '–', runStatus(r), tests, ...numbers, clicks, ...CRITERIA.map((c) => String(r.judge?.scores[c].score ?? '–'))];
}

function shotSection(records: readonly RunRecord[]): string {
  const lines = records.filter((r) => r.shots.length > 0).map((r) => `- ${r.ref.id.toUpperCase()}: ${r.shots.map((s) => `[${basename(s)}](${s})`).join(', ')}`);
  return lines.length === 0 ? '' : ['## Screenshots', '', ...lines].join('\n');
}

function interruptedSection(manifest: Manifest): string {
  const cut = manifest.attempts.filter((a) => a.outcome === 'interrupted');
  if (cut.length === 0) return '';
  return ['## Interrupted attempts', '', ...cut.map((a) => `- ${a.arm.toUpperCase()}${a.n} \`${a.token}\` started ${a.startedAt}: its branch \`${runBranch(a.token)}\` stays on origin`)].join('\n');
}

/** report.md: the only place that names the arms. */
export function renderReport(manifest: Manifest, records: readonly RunRecord[]): string {
  const head = [`# Skills A/B experiment ${manifest.id}`, '', `Source \`${manifest.source.slice(0, 12)}\` · baseline \`${manifest.baseline.slice(0, 12)}\` · docs baseline \`${manifest.docsBaseline.slice(0, 12)}\` · seed \`${manifest.seedHash.slice(0, 12)}\` · ${manifest.runs} pairs · created ${manifest.createdAt}`, '', ...ARM_LINES].join('\n');
  const perArm = table(['measure', 'A mean', 'A min–max', 'B mean', 'B min–max'], aggregate(records).map(({ label, arms }) => [label, ...cells(arms.a), ...cells(arms.b)]));
  const clicks = table(['scenario', 'A', 'B'], clickRates(records).map(({ scenario, arms }) => [scenario, `${arms.a.passed}/${arms.a.total}`, `${arms.b.passed}/${arms.b.total}`]));
  const sections = [head, `## Per arm\n\n${perArm}`, `## Click scenarios passed\n\n${clicks}`, `## Runs\n\n${table(RUN_HEAD, records.map(runRow))}`, shotSection(records), interruptedSection(manifest)];
  return `${sections.filter((s) => s !== '').join('\n\n')}\n`;
}

/** Each slot's latest attempt; an interrupted or open one counts as not run. */
export async function readRecords(dir: string, manifest: Manifest): Promise<RunRecord[]> {
  return Promise.all(runOrder(manifest.runs).map(async (ref): Promise<RunRecord> => {
    const attempt = latest(manifest, ref);
    if (!attempt || attempt.outcome === undefined || attempt.outcome === 'interrupted') return { ref, shots: [] };
    const base = join(dir, attempt.token);
    const [metrics, evaluation, clicks, judge, shots] = await Promise.all([
      readJson<Metrics>(join(base, FILES.metrics)), readJson<EvalResult>(join(base, FILES.evaluation)),
      readJson<Click[]>(join(base, FILES.clicks)), readJson<Judge>(join(base, FILES.judge)), pngsIn(join(base, FILES.screens)),
    ]);
    return { ref, token: attempt.token, metrics, evaluation, clicks, judge, shots: shots.map((path) => relative(dir, path)) };
  }));
}

export async function writeReport(dir: string, manifest: Manifest): Promise<void> {
  await writeText(join(dir, FILES.report), renderReport(manifest, await readRecords(dir, manifest)));
}
