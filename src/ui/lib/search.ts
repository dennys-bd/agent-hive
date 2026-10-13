// The search's pure part (#584): the scope a prefix picks, the fuzzy match and its ranges, and the rows each group shows, capped. Derived
// from the State the dashboard already holds, as home.ts is; nothing of it is stored.
import { activityOf as liveActivityOf } from '../../activities.js';
import { taskLabel, sessionsOf } from '../../tasks.js';
import type { Activity as LiveActivity, ActivityRecord, GitMark, Task, Session, Worker } from '../../types.js';
import { type Activity, isTask, type TaskActivity } from './activities.js';
import { pendingSessions, recentActivities } from './home.js';
import type { OperationView } from './operations.js';

export type Scope = 'all' | 'activities' | 'tasks' | 'commands' | 'files';
export const SCOPES: readonly Scope[] = ['all', 'activities', 'tasks', 'commands', 'files'];
/** What typed first switches the scope (the handoff): # tarefas, > comandos, / arquivos (#133). */
export const SCOPE_PREFIX: Partial<Record<Scope, string>> = { tasks: '#', commands: '>', files: '/' };
export const GROUP_LIMIT = 3; // each group in tudo
export const SCOPE_LIMIT = 20; // a filtered scope
const HIDDEN_FIELD_SCORE = 100; // a hit only in the branch or a session id ranks after every hit the row draws
const FOLDER_SCORE = 100; // a file hit that reaches the folders ranks after every hit within a file name (#133)

export type Range = readonly [start: number, end: number];
/** Where a query hit and how well: fewer ranges rank first. */
export interface Match { ranges: Range[]; score: number }

export type SearchRow =
  | { kind: 'activity'; activity: TaskActivity; ranges: Range[] }
  | { kind: 'task'; task: Task; ranges: Range[] }
  | { kind: 'operation'; view: OperationView; ranges: Range[] }
  | { kind: 'file'; path: string; mark?: GitMark; ranges: Range[] };
export type GroupId = 'recent' | 'pending' | 'activities' | 'tasks' | 'commands' | 'files';
export interface SearchGroup { id: GroupId; rows: SearchRow[] }
/** The open activity's files (#133): the paths its tree lists, relative, and their git marks. */
export interface SearchFiles { paths: readonly string[]; marks: Readonly<Record<string, GitMark>> }
// files: undefined with no activity open, or before its tree is read (#133)
export interface SearchInput { scope: Scope; query: string; tasks: Task[]; workers: Worker[]; liveActivities: LiveActivity[]; activityRecords: ActivityRecord[]; activities: Activity[]; operations: OperationView[]; files?: SearchFiles }

/** The field's text as a scope and a query: a prefix typed first switches the scope and leaves the field. */
export function parseQuery(text: string, scope: Scope): { scope: Scope; query: string } {
  const hit = SCOPES.find((s) => {
    const prefix = SCOPE_PREFIX[s];
    return prefix !== undefined && text.startsWith(prefix);
  });
  return hit === undefined ? { scope, query: text } : { scope: hit, query: text.slice(1) };
}

/** Tab and Shift+Tab: the next scope, around the end. */
export const nextScope = (scope: Scope, step: 1 | -1): Scope => SCOPES[(SCOPES.indexOf(scope) + step + SCOPES.length) % SCOPES.length];

// Each needle character in order; consecutive hits merge into one range
function subsequence(hay: string, needle: string): Range[] | undefined {
  const hits: number[] = [];
  let from = 0;
  for (const char of needle) {
    const at = hay.indexOf(char, from);
    if (at === -1) return undefined;
    hits.push(at);
    from = at + 1;
  }
  const ranges: Range[] = [];
  for (const at of hits) {
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === at) ranges[ranges.length - 1] = [last[0], at + 1];
    else ranges.push([at, at + 1]);
  }
  return ranges;
}

/** Where `query` matches `text`, case-insensitive: one range for a substring, else one per run of a subsequence; [] for a blank query,
 * undefined for no match. */
export function fuzzyRanges(text: string, query: string): Range[] | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hay = text.toLowerCase();
  const at = hay.indexOf(needle);
  return at === -1 ? subsequence(hay, needle) : [[at, at + needle.length]];
}

// The shown text first, with its ranges; a hit only in a hidden field still matches, with nothing to draw. A hidden field matches by
// substring alone: a subsequence of a branch or a session id is chance, and would match nearly every task
function matchFields(shown: string, hidden: string[], query: string): Match | undefined {
  const ranges = fuzzyRanges(shown, query);
  if (ranges !== undefined) return { ranges, score: ranges.length };
  return hidden.some((text) => text.toLowerCase().includes(query.trim().toLowerCase())) ? { ranges: [], score: HIDDEN_FIELD_SCORE } : undefined;
}

/** A task by its label (the number and the title), then its branch and its sessions' ids (the handoff). */
export const matchTask = (task: Task, branch: string, query: string, sessions: Session[]): Match | undefined =>
  matchFields(taskLabel(task), [branch, ...sessions.map((s) => s.id)], query);

// The items that match, best first; the sort is stable, so equal scores keep the State's order
function ranked<T>(items: readonly T[], match: (item: T) => Match | undefined): { item: T; match: Match }[] {
  const hits = items.flatMap((item) => {
    const found = match(item);
    return found === undefined ? [] : [{ item, match: found }];
  });
  return [...hits].sort((a, b) => a.match.score - b.match.score);
}

/** Operations by their label, then their target (the handoff). */
export const operationRows = (views: readonly OperationView[], query: string): SearchRow[] =>
  ranked(views, (view) => matchFields(view.label, [view.target ?? ''], query)).map(({ item, match }) => ({ kind: 'operation', view: item, ranges: match.ranges }));

/** A path by its file name first, then the whole path (#133): "go to file" is by name. A name hit's ranges are shifted onto the whole path. */
export function matchFile(path: string, query: string): Match | undefined {
  const cut = path.lastIndexOf('/') + 1;
  const inName = fuzzyRanges(path.slice(cut), query);
  if (inName !== undefined) return { ranges: inName.map(([start, end]): Range => [start + cut, end + cut]), score: inName.length };
  const inPath = fuzzyRanges(path, query);
  return inPath === undefined ? undefined : { ranges: inPath, score: FOLDER_SCORE + inPath.length };
}

const fileRow = (files: SearchFiles, path: string, ranges: Range[]): SearchRow => ({ kind: 'file', path, mark: files.marks[path], ranges });

// ponytail: the match runs on the client over every path git lists, with no index and no cap; tens of thousands of paths is the ceiling, a
// server-side match route the upgrade (#133)
/** The paths that match, a hit within the file name first; the sort is stable, so equal scores keep git's path order (#133). */
export const fileRows = (files: SearchFiles, query: string): SearchRow[] =>
  ranked(files.paths, (path) => matchFile(path, query)).map(({ item, match }) => fileRow(files, item, match.ranges));

// The empty arquivos field (#133): the open activity's changed files, path order. A deleted path is in marks only, never in paths (#903), so
// it is not listed
function changedGroups(files: SearchFiles | undefined): SearchGroup[] {
  if (files === undefined) return [];
  const rows = files.paths.filter((path) => files.marks[path] !== undefined).slice(0, SCOPE_LIMIT).map((path) => fileRow(files, path, []));
  return rows.length === 0 ? [] : [{ id: 'files', rows }];
}

// A workspace's local activity (#590) holds no task, so only a task's activity is searched and shown here
const taskActivities = (activities: readonly Activity[]): TaskActivity[] => activities.filter(isTask);

const activityOf = (activities: readonly TaskActivity[], task: Task): TaskActivity | undefined => activities.find((a) => a.task.item.itemId === task.item.itemId);

// A task with an activity shows only as the activity (the handoff: no duplicates); a missing one waits for its close or keep
const tasksOf = (tasks: readonly Task[], activities: readonly TaskActivity[]): Task[] => tasks.filter((task) => !task.missing && activityOf(activities, task) === undefined);

// A task's live activity's branch (#629): what its search reads besides the label
const branchOf = (input: SearchInput, task: Task): string =>
  liveActivityOf({ activities: input.liveActivities, activityRecords: input.activityRecords }, task.item.itemId)?.branch ?? '';

/** The groups a query shows: in tudo atividades, tarefas, comandos and arquivos (#133), 3 each; in a scope its own group, 20 at most. Empty groups drop. */
export function searchGroups(input: SearchInput): SearchGroup[] {
  if (input.query.trim() === '') return emptyGroups(input);
  const { scope, query } = input;
  const activities = taskActivities(input.activities);
  const limit = scope === 'all' ? GROUP_LIMIT : SCOPE_LIMIT;
  const wants = (id: GroupId): boolean => scope === 'all' || scope === id;
  const groups: SearchGroup[] = [
    { id: 'activities', rows: wants('activities') ? ranked(activities, (a) => matchTask(a.task, a.activity.branch ?? '', query, sessionsOf(input, a.task.item.itemId))).map(({ item, match }): SearchRow => ({ kind: 'activity', activity: item, ranges: match.ranges })) : [] },
    { id: 'tasks', rows: wants('tasks') ? ranked(tasksOf(input.tasks, activities), (task) => matchTask(task, branchOf(input, task), query, sessionsOf(input, task.item.itemId))).map(({ item, match }): SearchRow => ({ kind: 'task', task: item, ranges: match.ranges })) : [] },
    { id: 'commands', rows: wants('commands') ? operationRows(input.operations, query) : [] },
    { id: 'files', rows: wants('files') && input.files !== undefined ? fileRows(input.files, query) : [] },
  ];
  return groups.map((group) => ({ ...group, rows: group.rows.slice(0, limit) })).filter((group) => group.rows.length > 0);
}

// The empty field (the handoff): recentes, the last activities or tasks worked on, then precisam de você, one row per activity; a scope
// keeps its kind. In comandos every available operation, in the group order
function emptyGroups({ scope, tasks, workers, liveActivities, activityRecords, activities: all, operations, files }: SearchInput): SearchGroup[] {
  const activities = taskActivities(all);
  if (scope === 'commands') return operations.length === 0 ? [] : [{ id: 'commands', rows: operationRows(operations, '') }];
  if (scope === 'files') return changedGroups(files); // #133: arquivos lists files only, never a recent task
  const rowOf = (task: Task): SearchRow => {
    const activity = activityOf(activities, task);
    return activity === undefined ? { kind: 'task', task, ranges: [] } : { kind: 'activity', activity, ranges: [] };
  };
  const wanted = (row: SearchRow): boolean => scope === 'all' || (scope === 'activities' ? row.kind === 'activity' : row.kind === 'task');
  const work = { tasks, workers, activities: liveActivities, activityRecords };
  const recent = recentActivities(work).map((row) => rowOf(row.task)).filter(wanted);
  const needing = pendingSessions(work).map((row) => row.task).filter((task, i, all) => all.findIndex((c) => c.item.itemId === task.item.itemId) === i);
  const pending = scope === 'tasks' ? [] : needing.map(rowOf).filter((row) => row.kind === 'activity');
  const groups: SearchGroup[] = [{ id: 'recent', rows: recent }, { id: 'pending', rows: pending }];
  return groups.filter((group) => group.rows.length > 0);
}
