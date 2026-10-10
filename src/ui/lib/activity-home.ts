// What an activity's home lists when no tab is open (#759): its agent sessions, most urgent first, and its kept terminals. Derived from the
// Activity the center already has, like activities.ts; nothing of it is stored.
import { type LiveRun, sessionLabel } from '../../task-runs.js';
import { t } from '../i18n.js';
import type { Session, Status, Worker } from '../../types.js';
import type { Activity, KeptTerminal, LocalActivity, TaskActivity } from './activities.js';
import { relativeTime } from './home.js';
import { urgencyIndex } from './status.js';

/** What a session row's click reaches (#759): a live run's tab, or a kept session (a task's continued, a local one through the local line's
 * own open, with the run that holds it if any). */
export type HomeTarget = { kind: 'run'; ptyId: string } | { kind: 'session'; session: Session; live?: Pick<Worker, 'runId' | 'terminalId'> };

/** One agent session as the home lists it (#759): `{name or short id} · {free session, last stage} · {time}` as parts, its status and its action. */
export interface HomeSession { key: string; meta: string[]; status: Status; action: 'open' | 'continue'; target: HomeTarget }

// A row and what it sorts by within its status: the kept session's last use, undefined for a live run not kept yet
interface Ranked { row: HomeSession; at?: string }

/** A meta's time (#759): HH:MM when `iso` falls today, else relativeTime's text (ontem / yesterday, then days). */
export function metaTime(iso: string, now: number): string {
  const at = new Date(iso);
  return at.toDateString() === new Date(now).toDateString() ? at.toTimeString().slice(0, 5) : relativeTime(iso, now);
}

// The parts with a value, in order: a free session is named before any stage a feedback run gave it (#812), a local session has no stage, a
// live run not kept yet has neither stage nor time, and a session saved before its dates were kept ('') has no time
function metaOf(name: string | undefined, session: Session | undefined, now: number): string[] {
  const time = session === undefined || session.lastUsedAt === '' ? undefined : metaTime(session.lastUsedAt, now);
  return [name, session?.free ? t('detail.freeSession') : undefined, session?.stages.at(-1), time].filter((part): part is string => part !== undefined);
}

// A live run's tab: a captured session's run lives in its terminal's pty, so its row opens the terminal, as its sidebar line does (#696)
const runTarget = (run: LiveRun): HomeTarget => ({ kind: 'run', ptyId: run.terminalId ?? run.ptyId });

// A task's sessions as its sidebar lines list them (#614): a run holding one opens it, whatever its status word reads (a held approval run
// reads sleeping but is live); a session no run holds continues
function taskRows(activity: TaskActivity, now: number): Ranked[] {
  return activity.sessions.flatMap(({ session, run, status }): Ranked[] => {
    const meta = metaOf(session === undefined ? run?.session : sessionLabel(session), session, now);
    if (run !== undefined) return [{ row: { key: session?.id ?? run.ptyId, meta, status, action: 'open', target: runTarget(run) }, at: session?.lastUsedAt }];
    if (session === undefined) return [];
    return [{ row: { key: session.id, meta, status: 'empty', action: 'continue', target: { kind: 'session', session } }, at: session.lastUsedAt }];
  });
}

// A local activity's kept sessions, each through the local line's own open, then its live agent runs not kept yet, which open their tab
function localRows(activity: LocalActivity, now: number): Ranked[] {
  const kept = activity.kept.map(({ session, run, status }): Ranked => ({
    row: {
      key: session.id, meta: metaOf(sessionLabel(session), session, now), status, action: run === undefined ? 'continue' : 'open',
      target: { kind: 'session', session, ...(run === undefined ? {} : { live: { runId: run.ptyId, terminalId: run.terminalId } }) },
    },
    at: session.lastUsedAt,
  }));
  const unkept = activity.sessions
    .filter(({ run }) => !activity.kept.some((k) => k.run?.ptyId === run.ptyId))
    .map(({ run, status }): Ranked => ({ row: { key: run.ptyId, meta: metaOf(run.session, undefined, now), status, action: 'open', target: runTarget(run) } }));
  return [...kept, ...unkept];
}

// Most urgent first as mostUrgent ranks, sleeping last; within one status a live run not kept yet first, then the most recent last use
const byUrgency = (a: Ranked, b: Ranked): number =>
  urgencyIndex(a.row.status) - urgencyIndex(b.row.status) || Number(a.at !== undefined) - Number(b.at !== undefined) || (b.at ?? '').localeCompare(a.at ?? '');

/** The activity's agent sessions as its home lists them (#759), most urgent first. */
export const homeSessions = (activity: Activity, now: number): HomeSession[] =>
  (activity.kind === 'task' ? taskRows(activity, now) : localRows(activity, now)).sort(byUrgency).map((ranked) => ranked.row);

/** The activity's kept terminals as its home lists them (#759): live ones first, then by their number. They have no status or time to sort by. */
export const homeTerminals = (activity: Activity): KeptTerminal[] =>
  [...(activity.terminals ?? [])].sort((a, b) => Number(a.asleep) - Number(b.asleep) || (a.n ?? 0) - (b.n ?? 0));
