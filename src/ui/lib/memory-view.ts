import { formatCount, t, tPlural } from '../i18n.js';
import { MEMORY_REFUSALS, type MemoryEntry, type MemoryKind, type MemoryOrigin, type MemoryRefusalCode, type MemoryStats } from '../../types.js';

// How the memory section and dialog word a lesson and its numbers (#797). Pure, so the components stay layout.

export type KindFilter = MemoryKind | 'all';
const NONE = '—';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const kindLabel = (kind: MemoryKind): string => t(`settings.memory.kind.${kind}`);
/** `{n} de {max} caracteres`: the memory's usage, and an editing row's live counter. */
export const charactersText = (n: number, max: number): string => t('settings.memory.of', { n: formatCount(n), max: formatCount(max) });

/** `{n} lições · {m} vindas de tarefas` (#797). */
export const lessonsText = (entries: readonly MemoryEntry[]): string =>
  `${tPlural('settings.memory.lessons', entries.length, { n: formatCount(entries.length) })} · ${t('settings.memory.fromTasks', { m: entries.filter((e) => e.origin !== 'user').length })}`;

/** The filter's counts (#797). */
export function kindCounts(entries: readonly MemoryEntry[]): Record<KindFilter, number> {
  const count = (kind: MemoryKind): number => entries.filter((e) => e.kind === kind).length;
  return { all: entries.length, pref: count('pref'), fact: count('fact'), avoid: count('avoid') };
}

// Where a lesson came from (#797): the user, a local session (#256), or a task with its stage when a stage run saved it
function originText(origin: MemoryOrigin): string[] {
  if (origin === 'user') return [t('settings.memory.you')];
  if (origin === 'local') return [t('settings.memory.local')];
  return [t('settings.memory.task', { id: origin.task }), ...(origin.stage === undefined ? [] : [origin.stage])];
}

/** A lesson's meta line before its citations (#797): where it came from, its date and its size. */
export function metaText(entry: MemoryEntry): string {
  return [...originText(entry.origin), entry.at.slice(0, 10), t('settings.memory.characters', { n: formatCount(entry.text.length) })].join(' · ');
}

/** `citada {n} vezes` (#797): a floor, an agent may forget to cite. */
export const citedText = (uses: number): string => tPlural('settings.memory.citedTimes', uses, { n: uses });

/** A duration as the last-injection line says it (#797): minutes, hours, then days; never under a minute. */
export function agoText(ms: number): string {
  if (ms < HOUR_MS) return t('settings.memory.minutes', { n: Math.max(1, Math.floor(ms / MINUTE_MS)) });
  if (ms < DAY_MS) return t('settings.memory.hours', { n: Math.floor(ms / HOUR_MS) });
  const days = Math.floor(ms / DAY_MS);
  return tPlural('settings.memory.days', days, { n: days });
}

/** The telemetry's last-injection line (#797); a free session's run has no stage. */
export function lastText(last: NonNullable<MemoryStats['last']>, now: number): string {
  const vars = { time: agoText(now - Date.parse(last.at)), task: `#${last.task}`, cited: tPlural('settings.memory.lessonsCited', last.cited, { n: last.cited }) };
  return last.stage === undefined ? t('settings.memory.lastFree', vars) : t('settings.memory.last', { ...vars, stage: last.stage });
}

/** The telemetry's three numbers (#797): a dash with no run in the window (also what logLevel warn leaves) or while the stats are unread. */
export function statNumbers(stats: MemoryStats | undefined, total: number): { runs: string; cited: string; tokens: string } {
  if (stats === undefined || stats.runs === 0) return { runs: NONE, cited: NONE, tokens: NONE };
  return {
    runs: formatCount(stats.runs), cited: t('settings.memory.citedOf', { cited: stats.cited, total }),
    tokens: stats.tokensPerRun === undefined ? NONE : `~${formatCount(stats.tokensPerRun)}`,
  };
}

const isRefusalCode = (value: unknown): value is MemoryRefusalCode => typeof value === 'string' && (MEMORY_REFUSALS as readonly string[]).includes(value);

/** A refusal as the dialog shows it under its field (#797): the server's code in the user's language, else the error's own words. */
export function refusalText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (isRefusalCode(code)) return t(`settings.memory.refusal.${code}`);
  return err instanceof Error ? err.message : String(err);
}
