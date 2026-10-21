// The macOS notifications' facts (#199): what changed between two /events payloads that needs the user. Pure and Electron-free, so
// node:test covers it; notify-viewer.ts shows the result. Derived from State, not from facts.jsonl: its records carry no titles (#742).
import { localWorkspaceOf, recordOf, taskOfActivity } from './activities.js';
import { taskId, taskLabel } from './tasks.js';
import { type Activity, type EventsPayload, NOTIFICATION_KINDS, type NotificationKind, type NotificationSettings, type State } from './types.js';
import { type MessageKey, t } from './ui/i18n.js';

/** One notification to show (#199): key names the fact; title is what the menu bar's worker line shows; taskId is what a click opens. */
export interface HiveNotification { kind: NotificationKind; key: string; title: string; body: string; taskId?: string }

const BODY: Record<NotificationKind, MessageKey> = { waiting: 'notify.waiting', approval: 'notify.approval', pr: 'notify.pr', failed: 'notify.failed' };

interface Subject { title: string; taskId?: string }

// What a notification names, as GET /ptys does (#192, #587): a local activity its workspace, a task's activity its task; none once no task holds it
function subjectOf(state: State, activityId: string): Subject | undefined {
  const workspace = localWorkspaceOf(activityId);
  if (workspace !== undefined) return { title: workspace };
  const task = taskOfActivity(state, activityId);
  return task && { title: taskLabel(task), taskId: taskId(task) };
}

const make = (kind: NotificationKind, key: string, { title, taskId: id }: Subject): HiveNotification =>
  ({ kind, key, title, body: t(BODY[kind]), ...(id === undefined ? {} : { taskId: id }) });

// A session that entered waiting since prev (by run), or waits again with a new waitingSince
function waitingOf(prev: State, next: State): HiveNotification[] {
  return next.workers.flatMap((worker) => {
    if (worker.status !== 'waiting' || worker.runId === undefined || worker.activityId === undefined) return [];
    const before = prev.workers.find((w) => w.runId === worker.runId);
    if (before?.status === 'waiting' && before.waitingSince === worker.waitingSince) return [];
    const subject = subjectOf(next, worker.activityId);
    return subject ? [make('waiting', `waiting:${worker.runId}:${worker.waitingSince}`, subject)] : [];
  });
}

// A live activity whose `read` value is set and differs from prev's for the same id: a new approval gate, a new error
function activityChanges(kind: NotificationKind, read: (a: Activity) => string | undefined): (prev: State, next: State) => HiveNotification[] {
  return (prev, next) => next.activities.flatMap((activity) => {
    const value = read(activity);
    const before = prev.activities.find((a) => a.id === activity.id);
    if (value === undefined || (before !== undefined && read(before) === value)) return [];
    const subject = subjectOf(next, activity.id);
    return subject ? [make(kind, `${kind}:${activity.id}:${value}`, subject)] : [];
  });
}

// One per PR URL a record gained since prev: a sliced delivery opening three PRs shows three
function prsOf(prev: State, next: State): HiveNotification[] {
  return next.activityRecords.flatMap((record) => {
    const seen = new Set((recordOf(prev, record.id)?.prs ?? []).map((p) => p.url));
    const subject = subjectOf(next, record.id);
    if (!subject) return [];
    return (record.prs ?? []).filter((p) => !seen.has(p.url)).map((p) => make('pr', `pr:${p.url}`, subject));
  });
}

const DERIVE: Record<NotificationKind, (prev: State, next: State) => HiveNotification[]> = {
  waiting: waitingOf,
  approval: activityChanges('approval', (a) => a.approval?.since), // held (status approval) or released (#321)
  pr: prsOf,
  failed: activityChanges('failed', (a) => a.error), // a spawn, a run, a commands stage, a CI wait or a source action that failed
};

/** The transitions from prev to next that need the user (#199), only the kinds `enabled` keeps, in NOTIFICATION_KINDS order and then the
 *  state's own: a standing state gives nothing, a re-sent identical one nothing. */
export function notificationsFor(prev: State, next: State, enabled: NotificationSettings): HiveNotification[] {
  return NOTIFICATION_KINDS.filter((kind) => enabled[kind]).flatMap((kind) => DERIVE[kind](prev, next));
}

/** Follows the /events stream (#199): each configured payload is diffed against the one before. The first after creation, after the stream
 *  ended (undefined) or after setup mode is only a baseline, so a boot, a Restart or a daemon that moved replays nothing. `enabled` is read
 *  at every payload: a saved toggle applies to the next event. */
export function notificationFeed(enabled: () => NotificationSettings): (payload: EventsPayload | undefined) => HiveNotification[] {
  let prev: State | undefined;
  return (payload) => {
    const next = payload !== undefined && 'effective' in payload ? payload : undefined;
    const found = prev !== undefined && next !== undefined ? notificationsFor(prev, next, enabled()) : [];
    prev = next;
    return found;
  };
}
