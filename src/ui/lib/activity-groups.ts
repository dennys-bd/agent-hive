// How a workspace's activities group in the Activities tab (#586): by stage, by status or not at all, done always last in a group of its own.
// Pure: the tab renders what this answers.
import type { Task, Stage, Status } from '../../types';
import { statusText, t } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { isLive } from '@/lib/task-state';

export type GroupMode = 'stage' | 'status' | 'none';
export const GROUP_MODES: readonly GroupMode[] = ['stage', 'status', 'none'];

/** One group of a workspace (#586): `key` is what its collapse is saved under, `name` its header (empty for sem agrupamento's one list). */
export interface ActivityGroup { key: string; name: string; items: TaskActivity[]; isDone: boolean }

export const DONE_KEY = 'done';
const FLAT_KEY = 'all';

type StatusGroup = Exclude<Status, 'empty'> | 'stopped';
// The handoff's order of urgency; review and approval are the task's state once no session works (#663)
const STATUS_ORDER: StatusGroup[] = ['waiting', 'approval', 'backoff', 'working', 'review', 'stopped']; // #805: backoff before a run that moves
const SUMMARY_STATUSES = ['waiting', 'approval'] as const; // the two that need the user

/** Whether the task is done (#586): it sits in the flow's last stage and that stage runs no prompt. A last stage with a prompt never is: the
 * task leaves state.tasks when that stage ends (moveOn). A delete activity stage has no prompt either, since the parser keeps the two exclusive. */
export function isDone(task: Task, stages: Stage[]): boolean {
  const last = stages.at(-1);
  return last !== undefined && task.stage === last.name && last.prompt === undefined;
}

/** When the activity last moved (#586): the later of its newest worker's start and its task's entry into its stage, '' with neither. ISO strings
 * order as strings. */
export function recentOf(activity: TaskActivity): string {
  const started = activity.lastStartedAt ?? '';
  const entered = activity.task.enteredAt ?? '';
  return started > entered ? started : entered;
}

// The task's state groups it (#663): activitiesOf derived it, an open PR or an approval with no session at work included; empty is stopped (#647)
const statusOf = (activity: TaskActivity): StatusGroup => (activity.status === 'empty' ? 'stopped' : activity.status);
// A session working or waiting (#666); a held approval run is idle and does not count
const isAwake = (activity: TaskActivity): boolean => activity.sessions.some((s) => isLive(s.status));

// By status and with no grouping, an awake session keeps a done-stage activity out of done, so it is not hidden there (#666); by stage the
// group is the stage itself
const doneIn = (activity: TaskActivity, mode: GroupMode, stages: Stage[]): boolean =>
  isDone(activity.task, stages) && (mode === 'stage' || !isAwake(activity));

const statusName = (status: StatusGroup): string => (status === 'stopped' ? t('detail.stopped') : statusText(status));

// The flow's stages in order, then any stage a task still names after it left the flow
function byStage(items: TaskActivity[], stages: Stage[]): ActivityGroup[] {
  const names = new Set([...stages.map((stage) => stage.name), ...items.map((a) => a.task.stage)]);
  return [...names].map((name) => ({ key: `stage:${name}`, name, items: items.filter((a) => a.task.stage === name), isDone: false }));
}

function byStatus(items: TaskActivity[]): ActivityGroup[] {
  return STATUS_ORDER.map((status) => ({ key: `status:${status}`, name: statusName(status), items: items.filter((a) => statusOf(a) === status), isDone: false }));
}

// Every group but done: sem agrupamento's one list is kept even empty, the others only with something in them
function openGroups(items: TaskActivity[], mode: GroupMode, stages: Stage[]): ActivityGroup[] {
  if (mode === 'none') return [{ key: FLAT_KEY, name: '', items: [...items].sort((a, b) => recentOf(b).localeCompare(recentOf(a))), isDone: false }];
  const groups = mode === 'stage' ? byStage(items, stages) : byStatus(items);
  return groups.filter((group) => group.items.length > 0);
}

/** A workspace's activities in the groups `mode` makes (#586), done last: named after the last stage by stage, finalizado otherwise. */
export function groupActivities(activities: TaskActivity[], mode: GroupMode, stages: Stage[]): ActivityGroup[] {
  const done = activities.filter((a) => doneIn(a, mode, stages));
  const groups = openGroups(activities.filter((a) => !doneIn(a, mode, stages)), mode, stages);
  if (done.length === 0) return groups;
  const name = mode === 'stage' ? (stages.at(-1)?.name ?? t('activities.done')) : t('activities.done');
  return [...groups, { key: DONE_KEY, name, items: done, isDone: true }];
}

/** A collapsed workspace's summary (#586): its activity count, then how many wait on the user in the most urgent of waiting and approval,
 * when any; nothing for an empty workspace. */
export function workspaceSummary(activities: TaskActivity[]): string {
  const n = activities.length;
  if (n === 0) return '';
  for (const status of SUMMARY_STATUSES) {
    const k = activities.filter((a) => a.status === status).length;
    if (k > 0) return t('activities.summary', { n, k, status: statusText(status) });
  }
  return String(n);
}
