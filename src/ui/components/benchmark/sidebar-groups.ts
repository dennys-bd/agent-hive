// The benchmark sidebar's pure parts (#461): which group an experiment sits in, in what order, and its sub line. Tested without rendering.
import type { Experiment, ExperimentStatus } from '../../../types';
import { currentLanguage, t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

export type GroupId = 'running' | 'draft' | 'done' | 'archived';
export interface ExperimentGroup { id: GroupId; experiments: Experiment[] }
/** The live groups (an empty one left out), the archived rows the search keeps, and every archived experiment's count for the footer. */
export interface SidebarGroups { groups: ExperimentGroup[]; archived: Experiment[]; archivedCount: number }

// sleeping is a running experiment paused: it stays under executando
const GROUP_OF: Record<ExperimentStatus, Exclude<GroupId, 'archived'>> = { running: 'running', sleeping: 'running', draft: 'draft', done: 'done' };
const ORDER = ['running', 'draft', 'done'] as const;
const LOCALE = { en: 'en-US', pt: 'pt-BR' } as const;

/** The screen's state dot (colour only for status): ok, queued, done. */
export const DOT_CLASS: Record<ExperimentStatus, string> = { running: 'text-working', sleeping: 'text-working', draft: 'text-empty', done: 'text-muted-foreground' };

const isArchived = (e: Experiment): boolean => e.archived === true;
const newestFirst = (a: Experiment, b: Experiment): number => b.createdAt.localeCompare(a.createdAt);

export function groupExperiments(experiments: readonly Experiment[], query: string): SidebarGroups {
  const q = query.trim().toLowerCase();
  const shown = experiments.filter((e) => e.name.toLowerCase().includes(q)).sort(newestFirst); // filter copies, so the sort mutates nothing shared
  const groups = ORDER
    .map((id): ExperimentGroup => ({ id, experiments: shown.filter((e) => !isArchived(e) && GROUP_OF[e.status] === id) }))
    .filter((group) => group.experiments.length > 0);
  return { groups, archived: shown.filter(isArchived), archivedCount: experiments.filter(isArchived).length };
}

/** `rodada N/M`: the rounds started of the pairs asked. */
export const roundOf = (e: Experiment): { n: number; m: number } => ({ n: e.rounds.filter((r) => r.startedAt !== undefined).length, m: e.pace.pairs });

export const roundsText = (n: number): string => (n === 1 ? t('benchmark.sidebar.rounds.one') : t('benchmark.sidebar.rounds.other', { n }));

/** `30 set` / `30 Sep`: the day and the short month, without the locale's dot. */
export function dayMonth(iso: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE[currentLanguage()], { day: 'numeric', month: 'short' }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value.replace('.', '') ?? '';
  return `${part('day')} ${part('month')}`;
}

/** The row's second line (spec decisions 2, 3): the round while it runs, the creation time of a draft, the end's day and the rounds once done. */
export function subLine(e: Experiment): string {
  const isMcp = e.createdBy.kind === 'mcp';
  if (e.status === 'running' || e.status === 'sleeping') {
    const round = t('benchmark.sidebar.round', roundOf(e));
    return isMcp ? `${round} · ${t('benchmark.sidebar.viaMcp')}` : round;
  }
  if (e.status === 'draft') return t(isMcp ? 'benchmark.sidebar.mcpAt' : 'benchmark.sidebar.createdAt', { time: clockOf(new Date(e.createdAt)) });
  return `${dayMonth(e.rounds.at(-1)?.endedAt ?? e.createdAt)} · ${roundsText(e.rounds.length)}`;
}
