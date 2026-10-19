import { activityOf, holdsSlug, keptActivity, recordsOf, taskOfActivity, terminalsIn, worktreeOwner, workersIn, type WorkState } from './activities.js';
import { staleRead } from './column-write.js';
import { parentOf } from './task-tree.js';
import type { Activity, SourceAction, SourceItem, Task, Session, TaskUsage, DeleteActivityScope, Stage, Config, Effect, Terminal, Transition, Worker, State, Item, WorktreeRow } from './types.js';

/** What a task's workers are read from (#629): the workers point at the activity, the activity's record lists the task. */
export type WorkersState = Pick<State, 'workers' | 'activities' | 'activityRecords'>;

const SLUG_MAX = 30;

/** "30m", "12h", "5d": what `after` accepts. Exported so config.ts and settings-form.ts validate with the same regex. */
export const DURATION = /^([1-9]\d*)([mhd])$/;
/** What `comb.prefix` accepts (#132): safe in a slug and in a branch name. Exported so config.ts and settings-form.ts validate with the same regex. */
export const COMB_PREFIX = /^[A-Za-z][A-Za-z0-9]{0,9}$/;
/** The prefix a first setup starts with. */
export const DEFAULT_PREFIX = 'HIVE';

/** What a workspace's name accepts (#179): safe in a URL segment and a select value. Exported so config.ts and settings-form.ts check with the same regex. */
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const WORKSPACE_NAME_MAX = 40;
const FALLBACK_WORKSPACE_NAME = 'workspace';

/** A source name no entry may take (#180): local task ids are `local:<n>`, so a source of that name would share their item ids. */
export const RESERVED_SOURCE = 'local';
/** The name the flow sidebar shows and picks the Hive's own tasks by (#665): they have no item.source. Reserved like RESERVED_SOURCE, so no
 * source can take it and one pick never matches both a source's tasks and the Hive's. */
export const HIVE_SOURCE = 'hive';

/** The source names no comb.sources entry may take (#180, #665). The config, the settings form and the new source dialog share this rule. */
export const isReservedSource = (name: string): boolean => name === RESERVED_SOURCE || name === HIVE_SOURCE;

/** What a source pick and a source count compare (#665): the item's source, or HIVE_SOURCE for a task created in the Hive. */
export const sourceOf = (task: Pick<Task, 'item'>): string => task.item.source ?? HIVE_SOURCE;

/** A column map's entry for one source (#180); own keys only, so a source named like an Object method reads nothing it did not set. */
export const onSource = <T>(map: Record<string, T> | undefined, source: string | undefined): T | undefined =>
  (map !== undefined && source !== undefined && Object.hasOwn(map, source) ? map[source] : undefined);

/** The source columns an action list writes (#286, #515): its moves' columns; the other actions leave the column as it is. */
const movesOf = (list: SourceAction[] | undefined): string[] => (list ?? []).flatMap((a) => (a.type === 'move' ? [a.column] : []));

/** A workspace name for a folder (#179): its last segment with every character WORKSPACE_NAME refuses turned into "-", no leading punctuation,
 * capped at 40; "workspace" when nothing is left. What the settings form proposes, never saved without the user seeing it. */
export function workspaceNameFor(path: string): string {
  const last = path.split('/').filter((s) => s !== '').pop() ?? '';
  const name = last.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[._-]+/, '').slice(0, WORKSPACE_NAME_MAX);
  return name === '' ? FALLBACK_WORKSPACE_NAME : name;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Milliseconds of a duration DURATION accepts; undefined otherwise (never throws: the reducer reads it, and the config already refused a bad one). */
export function durationMs(text: string): number | undefined {
  const match = DURATION.exec(text);
  return match ? Number(match[1]) * UNIT_MS[match[2]] : undefined;
}

/** A source column the config mentions and the Hive stage + field that cites it, for error messages. */
export interface Citation {
  column: string;
  by: string;
}

/** Every source column the config cites for `source` (#180: that source's entries of the maps only), once each, first citation wins: each
 * stage's from and onStart moves, then every transition's source moves (#134). What its adapter validates and lists. */
export function citedColumns(stages: Stage[], transitions: readonly Transition[], source: string): Citation[] {
  const mentions: Citation[] = [
    ...stages.flatMap((c) => [
      ...(onSource(c.from, source) ?? []).map((column) => ({ column, by: `${c.name}.from` })),
      ...movesOf(onSource(c.onStart, source)).map((column) => ({ column, by: `${c.name}.onStart` })),
    ]),
    ...transitions.flatMap((t) => movesOf(onSource(t.sources, source)).map((column) => ({ column, by: `${t.from} → ${t.to}.sources` }))),
  ];
  return mentions.filter((m, i) => mentions.findIndex((n) => n.column === m.column) === i);
}

function kebab(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The kebab title the slug carries: capped at SLUG_MAX, never ending in a hyphen. Extracted so {title} renders the same text. */
export function titleSlug(item: Item): string {
  return kebab(item.title).slice(0, SLUG_MAX).replace(/-+$/, '');
}

export function slugFor(item: Item): string {
  return `hive-${kebab(item.id)}-${titleSlug(item)}`;
}

/** The Hive's own namespace: nothing `claude --worktree` ever created (`worktree-<slug>`) can collide with it. */
export const DEFAULT_BRANCH_TEMPLATE = 'hive/{id}-{title}';

/** Why a branch template cannot be used, as a message key the form translates and parseConfig turns into a sentence. */
export type BranchProblem = 'settings.error.branch.unique' | 'settings.error.branch.invalid';

// A probe task: what the template renders for the smallest possible task, which is what the name rules are checked against.
const PROBE: Item = { itemId: 'probe', id: '1', title: 't', body: '', url: '' };
// git check-ref-format, only the part a template can break: an empty segment (leading, trailing or doubled `/`), a segment
// starting with `.` or ending in `.lock`, `..`, whitespace, a control character, and the characters git reserves.
// The control range is a comparison and not a regex class: Biome's noControlCharactersInRegex refuses one in a pattern.
const BAD_SEGMENT = /^$|^\.|\.lock$/;
const BAD_NAME = /\.\.|\s|[~^:?*[\\]/;
const isControl = (c: string): boolean => c < ' ' || c === '\u007f';

/** The branch for a task: `{id}`, `{title}` and `{slug}` replaced; anything else is left as typed, like renderPrompt. */
export function renderBranch(template: string, item: Item): string {
  const values: Record<string, string> = { id: item.id, title: titleSlug(item), slug: slugFor(item) };
  return template.replace(/\{(id|title|slug)\}/g, (_, key: string) => values[key]);
}

/** The branch every task's worktree gets, rendered from the saved template: the spawn creates it, both removals expect it, and a base
 * chosen by hand may never be it (#131). Here and not in server.ts because the task routes need it too. */
export const branchFor = (config: Pick<Config, 'branch'>, item: Item): string => renderBranch(config.branch ?? DEFAULT_BRANCH_TEMPLATE, item);

/** Pure, so the settings form and parseConfig share one rule. An empty template is not a problem: absent means the default. */
export function branchProblem(template: string): BranchProblem | undefined {
  if (template === '') return undefined;
  // Without {id} or {slug} two tasks render the same branch and the second `worktree add` fails on a branch already checked out.
  if (!template.includes('{id}') && !template.includes('{slug}')) return 'settings.error.branch.unique';
  const name = renderBranch(template, PROBE);
  const bad = BAD_NAME.test(name) || [...name].some(isControl) || name.split('/').some((s) => BAD_SEGMENT.test(s));
  return bad ? 'settings.error.branch.invalid' : undefined;
}

/** The only blocking rule: the adapter already filtered the list down to blockers that are still open. A wider parameter than `Item` so the
 * task filter's `blocked` rule (#441) can call it over a task-shaped value that carries no facets. */
export function isBlocked(item: Pick<Item, 'blockedBy'>): boolean {
  return (item.blockedBy?.length ?? 0) > 0;
}

export const taskId = (task: Task): string => task.item.itemId;
export const stageOf = (stages: Stage[], name: string): Stage | undefined => stages.find((c) => c.name === name);

/** The first Hive stage whose `from` names this column of `source` (#180): the only door a task enters (or is moved) through. A local task
 * (no source) has none. */
export const entryStage = (stages: Stage[], source: string | undefined, boardColumn: string): Stage | undefined =>
  stages.find((c) => onSource(c.from, source)?.includes(boardColumn));

/** Past the first door (#32): the task's stage comes later in `stages` than the first stage whose `from` names any column of the task's source.
 * The Hive has one ordered stage list, and the source's earliest door is where new work lands. A task with no source has no first stage. */
export function isPastFirstStage(stages: Stage[], task: Pick<Task, 'item' | 'stage'>): boolean {
  const first = stages.findIndex((s) => (onSource(s.from, task.item.source)?.length ?? 0) > 0);
  return first >= 0 && stages.findIndex((s) => s.name === task.stage) > first;
}

/** Whether the stage may act on the task now: no `after`, or `enteredAt` + `after` has passed. Without `enteredAt` (a task saved before the
 * field existed) never: the poll stamps it first, so nothing is cleaned the instant the Hive restarts on this version. */
export function isDue(task: Task, stage: Stage, now: number): boolean {
  if (stage.after === undefined) return true;
  const delay = durationMs(stage.after);
  return task.enteredAt !== undefined && delay !== undefined && Date.parse(task.enteredAt) + delay <= now;
}

/** A manual gate (#315): approval with nothing to run. A task awaits Aprovar from the moment it enters; the server and the UI share this rule. */
export const isGate = (stage: Stage | undefined): boolean => stage?.approval === true && stage.prompt === undefined && stage.action === undefined;

/** What a stage run of the task has to tell its worker: the stage's prompt (#134: a gate runs nothing, its feedback goes to another stage). The
 * fill and a start by hand share this rule. */
export const canRunIn = (stage: Pick<Stage, 'prompt'>): boolean => stage.prompt !== undefined;
/** The only way a task changes stage: `after` counts from this moment, and the pin goes with the old stage (a new queue is a new claim). What
 * the stage left behind on the work (a stopped mark, an awaited approval, queued feedback) is settleEntries' (#629). */
export const enter = ({ pinned: _pinned, ...task }: Task, stage: Stage): Task => ({ ...task, stage: stage.name, enteredAt: new Date().toISOString() });

/** A stage action in flight on the activity (#755, #834): a commands stage running or a wait for CI. It holds the task as a worker does: not due
 * again, not moved, no workspace change, no start. One rule, so the two never drift. */
export const inAction = (activity: Pick<Activity, 'commands' | 'ci'> | undefined): boolean => activity?.commands !== undefined || activity?.ci !== undefined;

/** A task a stage may act on: stopped, no delete activity in flight, still on the source, not carrying a failure that waits for a manual start, with
 * auto on (#164, #573) unless `nonAutoToo` (a wait-for-CI stage, #304: it holds no worker and runs nothing; a delete-activity stage under
 * nonAutoTasks, #496; the fill never passes it), not stopped by the
 * user or by a run that died (#283), not leaving the source (#286), not awaiting approval (#268), not running its worktree setup (#351) or a stage
 * action (#755, #834), and not a show epic (#31: its children run, it never does, by the fill or by a stage action). */
const isIdle = (task: Task, activity: Activity | undefined, nonAutoToo = false): boolean =>
  activity?.workerId === undefined && !activity?.deleting && !task.missing && activity?.error === undefined && (nonAutoToo || task.auto) && !activity?.stopped
  && !task.leaving && !activity?.approval && !activity?.setup && !inAction(activity) && task.item.epic === undefined;

/** Started (#727): the task has a live activity, whatever made it: a stage run, a free session, a first open. What a signal's resume picks up
 * when the task's auto is on and it is not stopped; a task without one is new. */
export const isStarted = (state: WorkState, task: Task): boolean => activityOf(state, taskId(task)) !== undefined;

/** What a task's workspace resolves against (#179): the Comb's names and each source's default (#180). */
export type WorkspaceNames = Pick<State, 'workspaces' | 'sourceWorkspaces'>;

// What a walk up the lineage resolves against (#32): the names, the defaults and the list the parent is read off
interface WorkspaceScope { workspaces: string[]; sourceWorkspaces: Record<string, string>; tasks: readonly Task[] }

/**
 * The workspace a task runs in (#179), first answer wins: task.workspace (by hand, or frozen with the worktree), the workspace the source's first
 * matching rule names (#293), the parent's resolved workspace (#32: read off `tasks`; omitted, nothing is inherited), the fixed workspace of the
 * task's own source (#180), the Comb's only workspace. An unknown task.workspace answers undefined and never falls through: a choice that no
 * longer exists is not silently replaced. An unknown hint is skipped.
 */
export function resolveWorkspace(task: Pick<Task, 'workspace' | 'item'>, workspaces: string[], sourceWorkspaces: Record<string, string> = {}, tasks: readonly Task[] = []): string | undefined {
  return resolveIn(task, { workspaces, sourceWorkspaces, tasks }, new Set());
}

function resolveIn(task: Pick<Task, 'workspace' | 'item'>, scope: WorkspaceScope, walked: ReadonlySet<string>): string | undefined {
  const { workspaces, sourceWorkspaces } = scope;
  if (task.workspace !== undefined) return workspaces.includes(task.workspace) ? task.workspace : undefined;
  const hint = task.item.workspaceHint;
  if (hint !== undefined && workspaces.includes(hint)) return hint;
  const inherited = parentWorkspace(task, scope, walked);
  if (inherited !== undefined) return inherited;
  const fallback = onSource(sourceWorkspaces, task.item.source); // the default of the source that listed the task (#180)
  if (fallback !== undefined && workspaces.includes(fallback)) return fallback;
  return workspaces.length === 1 ? workspaces[0] : undefined;
}

// The parent's own resolution, which already holds its parent's (#32). A repeat in the lineage ends the walk, as task-tree.ts's walks do:
// GitHub forbids cycles, but the wire is not trusted
function parentWorkspace(task: Pick<Task, 'item'>, scope: WorkspaceScope, walked: ReadonlySet<string>): string | undefined {
  const lineage = new Set([...walked, task.item.itemId]);
  const parent = parentOf(scope.tasks, task.item.itemId);
  return parent === undefined || lineage.has(parent.item.itemId) ? undefined : resolveIn(parent, scope, lineage);
}

// A known task seen again: the task fields refresh, the mark of a task that had gone missing drops, and a human move on the
// source (source column differs from the one the Hive last saw or wrote) follows into the Hive only while the task is stopped. A read from
// before the Hive's own column write (#889) refreshes everything but the column, so it can neither move the task back nor make shouldWrite
// compare against a value the source no longer holds; any other read confirms, overrides or outlives the write, and its mark goes.
function seenAgain(task: Task, seen: SourceItem, stages: Stage[], runs: WorkState, now: string): Task {
  if (task.orphan) return task;
  const { missing: _missing, ...present } = task;
  if (staleRead(task, seen.column, now)) return { ...present, item: seen.item };
  const { columnWrite: _columnWrite, ...rest } = present;
  const refreshed: Task = { ...rest, item: seen.item, boardColumn: seen.column };
  const held = activityOf(runs, taskId(task)); // #755, #834: a stage action in flight holds its stage as a worker does
  const entry = seen.column !== task.boardColumn && held?.workerId === undefined && !inAction(held) ? entryStage(stages, seen.item.source, seen.column) : undefined;
  return entry && entry.name !== task.stage ? enter(refreshed, entry) : refreshed; // same stage through another door: the clock keeps running
}

const entered = (seen: SourceItem, stages: Stage[]): Task[] => {
  const entry = entryStage(stages, seen.item.source, seen.column);
  // born with its source's auto (#688), on when the item carries none (#573); seenAgain never touches it again
  return entry ? [enter({ item: seen.item, stage: entry.name, boardColumn: seen.column, auto: seen.item.autoOnEntry ?? true }, entry)] : [];
};

// Gone from the source's listing: marked missing, unless the task never had a source to be listed by (local, #132), was kept (orphan), or is
// leaving through its own source action (#286): closeTask or sourceActionFailed answers that one.
const unlisted = (task: Task): Task => (task.orphan || task.missing || task.created || task.leaving ? task : { ...task, missing: true });

/** One source's poll (#180): which source listed what. */
export interface Listing { source: string; items: SourceItem[] }

// A task no current source can list (#180): a source task whose source was removed in Settings, or one saved before sources had names.
const sourceless = (task: Task, sources: string[]): boolean => !task.created && (task.item.source === undefined || !sources.includes(task.item.source));

/** What any poll does first (#180): a task whose source is no longer in the Comb is marked missing (close / keep as today); local tasks,
 * kept orphans and every current source's tasks are left as they are. */
export const markRemoved = (tasks: Task[], sources: string[]): Task[] => tasks.map((c) => (sourceless(c, sources) ? unlisted(c) : c));

/** The flat source order with `source`'s ids swapped for `ids` in place, or appended when that source shows up for the first time (#180). A
 * source's ids are the ones prefixed `<source>:`; a source name never holds a ":". */
export function replaceSegment(order: string[], source: string, ids: string[]): string[] {
  const own = (id: string): boolean => id.startsWith(`${source}:`);
  const at = order.findIndex(own);
  if (at < 0) return [...order, ...ids];
  const rest = order.filter((id) => !own(id));
  const before = order.slice(0, at).filter((id) => !own(id)).length;
  return [...rest.slice(0, before), ...ids, ...rest.slice(before)];
}

/** The source an item id belongs to (#180): the name before its first ":" (a source name never has one); undefined for an id with none.
 * Here and not in source.ts (#278): the reducer and the UI import this file, which has no Node imports. */
export function itemSource(itemId: string): string | undefined {
  const at = itemId.indexOf(':');
  return at < 0 ? undefined : itemId.slice(0, at);
}

/** An item id under its source's new name (#278): the `<old>:` prefix swapped for `<new>:`; another source's id, a local one or one with no
 * prefix as it is. What the workers and the source order are mapped through. */
export function renamedId(id: string, renames: Record<string, string>): string {
  const source = itemSource(id);
  const to = onSource(renames, source);
  return source === undefined || to === undefined ? id : `${to}${id.slice(source.length)}`;
}

/** A task of a renamed source under the new name (#278): item.source and the item id, the one place the id is rebuilt. Any other task, local
 * ones included, is the same object. The shown id waits for the next poll (seenAgain); the slug is frozen, so worktree and branch stay. */
export function renameSource(task: Task, renames: Record<string, string>): Task {
  const to = onSource(renames, task.item.source);
  return to === undefined ? task : { ...task, item: { ...task.item, source: to, itemId: renamedId(task.item.itemId, renames) } };
}

/** The state after a rename in Settings (#278), as one map (a swap rewrites each task once): every task of a renamed source (missing and
 * orphan ones too), the records' task ids (the workers point at activities, #629) and the source order under the new ids, and each status under its new key; a stale status already under a
 * new name (a removed source's) gives way. One event, so a running worker never sees an old id. An empty map: the same state. */
export function renameSources(state: State, renames: Record<string, string>): State {
  if (Object.keys(renames).length === 0) return state;
  const targets = new Set(Object.values(renames));
  const kept = Object.entries(state.syncs).filter(([name]) => onSource(renames, name) !== undefined || !targets.has(name));
  return {
    ...state,
    tasks: state.tasks.map((c) => renameSource(c, renames)),
    sourceOrder: state.sourceOrder.map((id) => renamedId(id, renames)),
    activityRecords: state.activityRecords.map((r) => (r.taskIds.some((id) => renamedId(id, renames) !== id) ? { ...r, taskIds: r.taskIds.map((id) => renamedId(id, renames)) } : r)),
    syncs: Object.fromEntries(kept.map(([name, sync]) => [onSource(renames, name) ?? name, sync])),
  };
}

/** One known task against its source's latest word (#180, #686): seen again when listed, else unlisted. What mergeTasks runs on each of the
 * polled source's tasks, and itemRead on the one item a field write re-read. seenAgain and unlisted keep their guards. */
export const seenOne = (task: Task, entry: SourceItem | undefined, stages: Stage[], runs: WorkState, now: string): Task =>
  (entry ? seenAgain(task, entry, stages, runs, now) : unlisted(task));

/** One source's poll (#180): that source's known tasks are updated (seen again) or marked missing (unlisted), its new items enter through its
 * `from`, and the tasks of every other source and the local ones are left alone, but for a removed source's (markRemoved). Every Hive stage
 * is then put back in `order` (the whole flat source order, this listing already swapped in) except for the tasks that hold their position
 * (`followSource`: pinned, live in `runs`, #356, or unlisted). A task without `enteredAt` (saved before the field existed) is stamped `now`,
 * the poll's time, which seenAgain also measures a column write's window by (#889). */
export function mergeTasks(tasks: Task[], stages: Stage[], { source, items: listed }: Listing, sources: string[], order: string[], runs: Runs, now: string): Task[] {
  const seen = new Map(listed.map((entry) => [entry.item.itemId, entry]));
  const known = new Set(tasks.map(taskId));
  const kept = markRemoved(tasks, sources).map((task) => (task.item.source === source ? seenOne(task, seen.get(taskId(task)), stages, runs, now) : task)); // another source's task, or a local one: this poll says nothing about it
  const merged = [...kept, ...listed.flatMap((entry) => (known.has(entry.item.itemId) ? [] : entered(entry, stages)))];
  const stamped = merged.map((c) => (c.enteredAt === undefined ? { ...c, enteredAt: now } : c));
  return followSource(stamped, order, runs);
}

/** In the queue (#15): its stage runs (a prompt or commands), the task is idle, held by no worker at all and unblocked. A task still waiting out
 * its stage's `after`, or with no workspace to run in, is queued too: candidates adds those two checks, an open PR's review does not. */
export function isQueued(task: Task, stages: Stage[], state: WorkersState): boolean {
  const stage = stageOf(stages, task.stage);
  return stage !== undefined && (canRunIn(stage) || stage.action === 'commands') && isIdle(task, activityOf(state, taskId(task)))
    && workersOf(state, task).length === 0 && !isBlocked(task.item);
}

/** Tasks a free worker may take, best first: stopped, present on the source, unblocked, without a failure, with auto on,
 * held by no worker at all (a free session may run on any task, #164, #283), in a stage with a prompt, or in a manual gate with queued feedback (HIVE-2), or a
 * commands stage, which holds a worker like a prompt stage (#727), and due (`after`
 * passed); a later stage wins, ties keep the Hive's order (#316). A task with `error` waits for a manual start: retrying would fail the same way. With a workspace to run in (#179). */
export function candidates(state: Pick<State, 'tasks' | 'stages'> & WorkersState & WorkspaceNames, now: number): Task[] {
  const { stages } = state;
  const position = (task: Task): number => stages.findIndex((s) => s.name === task.stage); // the array order is the pipeline order
  const runnable = state.tasks.filter((c) => {
    const stage = stageOf(stages, c.stage);
    return stage !== undefined && isQueued(c, stages, state) && isDue(c, stage, now) && resolveWorkspace(c, state.workspaces, state.sourceWorkspaces, state.tasks) !== undefined;
  });
  return [...runnable].sort((a, b) => position(b) - position(a)); // sort is stable: tasks in the same stage keep the Hive's order
}

/** The task before `before` (same stage), or at the end of its stage when `before` is absent, pinned there: unknown ids, a `before` in
 * another stage, or a move whose order and pin are already what they would be: the same list. */
export function moveTask(tasks: Task[], id: string, before?: string): Task[] {
  const moving = tasks.find((c) => taskId(c) === id);
  const target = before === undefined ? undefined : tasks.find((c) => taskId(c) === before);
  if (!moving || (before !== undefined && !target) || (target && target.stage !== moving.stage)) return tasks;
  const rest = tasks.filter((c) => c !== moving);
  // "End of its stage" is right after the last task of that stage: the array is global, a stage's tasks need not be contiguous
  const at = target ? rest.indexOf(target) : rest.reduce((end, c, i) => (c.stage === moving.stage ? i + 1 : end), -1);
  const moved = at < 0 ? tasks : [...rest.slice(0, at), moving, ...rest.slice(at)]; // dropped on itself, or alone in its stage: the order is already the one asked for
  // The gesture is the claim (#123): the task is pinned wherever it lands, so even a move that changes no order changes the list — unless the pin was already there
  const inStage = (list: Task[]): Task[] => list.filter((c) => c.stage === moving.stage);
  const was = inStage(tasks);
  const pin = (list: Task[]): Task[] => list.map((c) => (c === moving ? { ...moving, pinned: true } : c));
  // Same stage order as before: `moved` may still interleave other stages differently than `tasks` did, so pin onto `tasks` itself and leave them untouched
  if (inStage(moved).every((c, i) => c === was[i])) return moving.pinned === true ? tasks : pin(tasks);
  return pin(moved);
}

// Source index of a task; one the source no longer lists (orphan, missing) sorts after every listed one
function sourceIndex(sourceOrder: string[], task: Task): number {
  const index = sourceOrder.indexOf(taskId(task));
  return index < 0 ? sourceOrder.length : index;
}

// sort is stable: unindexed tasks keep their relative order
const bySource = (tasks: Task[], sourceOrder: string[]): Task[] => [...tasks].sort((a, b) => sourceIndex(sourceOrder, a) - sourceIndex(sourceOrder, b));

// The stage's tasks replaced by `sorted` at the positions the stage already holds: the array is global, other stages keep their indexes
function refill(tasks: Task[], stage: string, sorted: Task[]): Task[] {
  let next = 0;
  return tasks.map((c) => (c.stage === stage ? sorted[next++] : c));
}

/** What a task's place in its stage reads (#356): the workers, stage runs and free sessions alike, and the terminals. */
export type Runs = Pick<State, 'workers' | 'terminals' | 'activities' | 'activityRecords'>;

/** Whether the task has a live run (#356): its stage run, a free session or a terminal (a run command's too), the runs liveRuns lists in
 * the task's panel. What the stage's order, its reset and its paging call running. The activity's workerId counts on its own, as
 * removalBlocker reads it: a stage run's task is live whatever workers the caller holds. */
export const isLive = (task: Task, runs: Runs): boolean =>
  activityOf(runs, taskId(task))?.workerId !== undefined || workersOf(runs, task).length > 0 || terminalsOf(runs, task).length > 0;

// A task that holds the position it occupies through a poll: moved by hand, live (a run's start put it there, #117, #356), or absent from
// the source's listing (missing, orphan), which leaves it no order to follow and no reason to sink to the bottom.
const isAnchored = (task: Task, sourceOrder: string[], runs: Runs): boolean =>
  task.pinned === true || isLive(task, runs) || !sourceOrder.includes(taskId(task));

// Per Hive stage: the anchored tasks keep the positions they occupy and the remaining positions take the other tasks of that stage in the
// source's order. The array is global, so each stage is refilled at the indexes it already holds and the other stages keep theirs (#123).
function followSource(tasks: Task[], sourceOrder: string[], runs: Runs): Task[] {
  const anchored = (c: Task): boolean => isAnchored(c, sourceOrder, runs);
  const stages = [...new Set(tasks.map((c) => c.stage))];
  return stages.reduce((list, stage) => {
    const own = list.filter((c) => c.stage === stage);
    const free = bySource(own.filter((c) => !anchored(c)), sourceOrder);
    let next = 0;
    return refill(list, stage, own.map((c) => (anchored(c) ? c : free[next++])));
  }, tasks);
}

const unpinned = ({ pinned: _pinned, ...task }: Task): Task => task;

// That stage's tasks, the ones with a live run (#356) first in the order they currently have, then the stopped ones in the source's order
// (`sourceOrder` index; unknown ids last, relative order kept): the layout both resetOrder and differsFromSource agree on.
function runningThenSource(tasks: Task[], stage: string, sourceOrder: string[], runs: Runs): Task[] {
  const own = tasks.filter((c) => c.stage === stage);
  const live = own.filter((c) => isLive(c, runs));
  return [...live, ...bySource(own.filter((c) => !live.includes(c)), sourceOrder)];
}

/** That stage's tasks with the ones with a live run (#356) on top in their current order, followed by the stopped ones in the source's
 * order, and free of their pins, so the stage follows the source again on the next poll instead of freezing at today's order (a live task
 * dragged below the stopped ones goes back to the top, #117); other stages untouched. */
export function resetOrder(tasks: Task[], stage: string, sourceOrder: string[], runs: Runs): Task[] {
  return refill(tasks, stage, runningThenSource(tasks, stage, sourceOrder, runs).map(unpinned));
}

/** That stage's tasks with the ones with a live run (#356) first, in their order, `id` last among them, then the stopped ones in their
 * order; other stages untouched. What every start applies, a stage run's, a session's or a terminal's: the live tasks sit on top, the task
 * just started right below them (#117). */
export function runningFirst(tasks: Task[], id: string, runs: Runs): Task[] {
  const started = tasks.find((c) => taskId(c) === id);
  if (!started) return tasks;
  const live = (c: Task): boolean => isLive(c, runs);
  const stage = tasks.filter((c) => c.stage === started.stage);
  const others = stage.filter((c) => c !== started);
  const sorted = [...others.filter(live), started, ...others.filter((c) => !live(c))];
  return sorted.every((c, i) => c === stage[i]) ? tasks : refill(tasks, started.stage, sorted); // already on top: the same list, so nothing downstream sees a change
}

/** Whether the stage's tasks sit in a different order from what a reset would give them: a task with a live run (#356) below a stopped
 * one, or the stopped tasks the source lists out of the source's order (an unlisted stopped task is ignored, a live one counts whether
 * listed or not); what shows the reset button. A stage with no listed task does not differ. */
export function differsFromSource(tasks: Task[], stage: string, sourceOrder: string[], runs: Runs): boolean {
  const own = tasks.filter((c) => c.stage === stage);
  const live = (c: Task): boolean => isLive(c, runs);
  const stray = own.some((c, i) => live(c) && own.slice(0, i).some((d) => !live(d)));
  const stopped = own.filter((c) => !live(c) && sourceOrder.includes(taskId(c)));
  return stray || bySource(stopped, sourceOrder).some((c, i) => c !== stopped[i]);
}

/** Abrir sessão (#283): any task still on the source and not leaving it, whose worktree no git is removing and no setup is preparing (#351).
 * A blocker holds the stage run only (#491): the user opens a session or a terminal on a blocked task by hand. The reducer, the route and the
 * task menu share this one rule; a running stage, its auto setting or a stopped task changes nothing. */
export const canOpenSession = (task: Task, activity: Activity | undefined): boolean => !task.missing && !activity?.deleting && !task.leaving && !activity?.setup;

/** Why delete activity (#182, #210, #573) may not run, in the order the user would ask: a run holds the task (its stage run or a session,
 * #164; a terminal does not, #573), the activity is already being deleted, nothing the scope covers is on it (#236). */
export type RemovalBlocker = 'running' | 'deleting' | 'nothingToDelete';

/** Nothing deleting the activity would remove is on the task (#236, #573): no worktree, and no session while the scope drops them. A
 * delete-activity stage then just moves the task on. */
export const nothingToDelete = (state: WorkState, task: Task, scope: DeleteActivityScope): boolean => {
  // #629: every record's sessions, as main counted every session of the task: a kept one goes under scope.session too
  return activityOf(state, taskId(task))?.worktree === undefined && (!scope.session || sessionsOf(state, taskId(task)).length === 0);
};

/** The terminals open on the task (#283). */
export const terminalsOf = (state: Pick<State, 'terminals' | 'activities' | 'activityRecords'>, task: Task): Terminal[] =>
  terminalsIn(state.terminals, activityOf(state, taskId(task))?.id);

/** A session run holds the task (#573): its stage run or a session on it. Git never runs under one; a terminal holds nothing, since
 * deleting the activity closes it. */
const hasSessionRun = (task: Task, state: WorkersState): boolean => activityOf(state, taskId(task))?.workerId !== undefined || workersOf(state, task).length > 0;

/** The first RemovalBlocker the task hits, or undefined when delete activity may run. A missing task qualifies: its activity can be deleted
 * before it is closed. In a delete-activity stage nothing to delete never blocks (#236): the click moves the task on by hand. The reducer,
 * the route (its 409) and the menu item (its reason) share this one rule, so they never disagree. */
export function removalBlocker(task: Task, state: Pick<State, 'workers' | 'stages' | 'deleteActivity' | 'activities' | 'activityRecords'>): RemovalBlocker | undefined {
  if (hasSessionRun(task, state)) return 'running';
  if (activityOf(state, taskId(task))?.deleting) return 'deleting';
  const inStage = stageOf(state.stages, task.stage)?.action === 'deleteActivity';
  return !inStage && nothingToDelete(state, task, state.deleteActivity) ? 'nothingToDelete' : undefined;
}

/** A task whose activity the ⋯ menu may delete: nothing blocks it. */
export function canDeleteActivity(task: Task, state: Pick<State, 'workers' | 'stages' | 'deleteActivity' | 'activities' | 'activityRecords'>): boolean {
  return removalBlocker(task, state) === undefined;
}

/** Why a created task may not be removed (#132, #355), a run first: its stage run or a session (#164); a terminal does not hold it,
 * deleting closes it (#542, #573); or its activity is being deleted. What the task menu shows beside a disabled excluir task…. */
export function createdRemovalBlocker(task: Task, runs: Runs): 'running' | 'deleting' | undefined {
  if (hasSessionRun(task, runs)) return 'running';
  return activityOf(runs, taskId(task))?.deleting ? 'deleting' : undefined;
}

/** A created task the user may remove (#132): nothing blocks it. The reducer, the route and the task menu share this one rule (#355). */
export function canRemoveCreated(task: Task, runs: Runs): boolean {
  return task.created === true && createdRemovalBlocker(task, runs) === undefined;
}

/** A missing task the stage's close all may take (#279): stopped, not being deleted, held by no run, nor running a stage action, whose commands
 * run holds a worker (#755, #727). The reducer, the
 * route and the stage's strip share this one rule, so the count they show is what closes. */
export const canCloseMissing = (task: Task, state: WorkersState): boolean =>
  task.missing === true && !activityOf(state, taskId(task))?.deleting && activityOf(state, taskId(task))?.workerId === undefined && workersOf(state, task).length === 0
  && !inAction(activityOf(state, taskId(task)));

/** How a task is named on screen: `#12 Title` for a source task, `HIVE-3 Title` for a local one (#132): there is no issue number to point at. */
export const taskLabel = (task: Pick<Task, 'item' | 'created'>): string => {
  const id = `${task.created ? '' : '#'}${task.item.id}`;
  return task.item.title === '' ? id : `${id} ${task.item.title}`; // #191: a lean task before its first poll has no title
};

/** Stopped tasks in an action stage whose delay has passed (#755: was dueDeletions), in source order, that no session run holds: a manual
 * Claude session on a task that is not manual (#208) runs inside the worktree, and git never removes one with a session inside; a terminal
 * does not hold it: a delete-activity stage closes it (#573). A task without auto is taken by a wait-for-CI stage always (#304: auto governs whether a worker starts, and a wait holds none) and by a
 * delete-activity stage only when the scope's nonAutoTasks is on (#496). Blockers are about starting work, so they do not matter here; an orphan's activity is deleted like any other
 * (shouldWrite already keeps its source untouched). A workerless stage is due only while the signal's row runs them (#727). */
export function dueActions(state: Pick<State, 'tasks' | 'stages' | 'deleteActivity' | 'workspaces' | 'sourceWorkspaces'> & WorkersState, now: number, workerless: boolean): Task[] {
  return state.tasks.filter((c) => {
    const stage = stageOf(state.stages, c.stage);
    if (stage?.action === undefined || stage.action === 'commands' || !workerless) return false; // #727: a commands stage is the fill's; the others follow the workerless row
    const live = activityOf(state, taskId(c));
    const nonAuto = stage.action === 'waitForCi' || (stage.action === 'deleteActivity' && state.deleteActivity.nonAutoTasks); // #304; #755: the scope widens its own stage only
    const allowed = isIdle(c, live, nonAuto);
    const placed = stage.action === 'deleteActivity' || resolveWorkspace(c, state.workspaces, state.sourceWorkspaces, state.tasks) !== undefined;
    return allowed && placed && !hasSessionRun(c, state) && isDue(c, stage, now);
  });
}

/** Every session of the task, its records oldest first (#164, #629): a deleted activity's (repo) first, then the live one's. */
export const sessionsOf = (state: Pick<State, 'activityRecords'>, taskId: string): Session[] => recordsOf(state, taskId).flatMap((r) => r.sessions);

export const SESSION_ID_CHARS = 8; // characters of a session id shown as its identity (#346), what the session popup already showed
export const SHORT_SHA = 7; // characters of a commit shown as its identity: the diff header's base (#270) and Restart's start commit (#580)

/** A session's identity (#346): the first characters of its id, then the stages it ran in, oldest first. What the task's session list
 * (SessionsList, DetailPanel.tsx) shows before its own "last used" and repo suffix, and what the terminal panel's tooltip shows whole. */
export const sessionIdentity = (session: Session): string => `${session.id.slice(0, SESSION_ID_CHARS)} · ${session.stages.join(' → ')}`;

/** Whether the task has a worktree, or had one (#179): its path is recorded or a Claude session was started on it. The session lives in the
 * worktree's repo, so from then on the task's workspace is fixed. */
export const hasWorktree = (task: Task, state: WorkState): boolean => activityOf(state, taskId(task))?.worktree !== undefined || sessionsOf(state, taskId(task)).length > 0;

/** Whether the task's workspace may change (#179): stopped, nothing running git on it, and no worktree yet. The reducer, the
 * route and the menu share this one rule. */
export const canSetWorkspace = (task: Task, state: WorkState): boolean => {
  const live = activityOf(state, taskId(task));
  return live?.workerId === undefined && !inAction(live) && !live?.deleting && !hasWorktree(task, state); // #755, #834: nor while a stage action runs
};

/** Every worker running on the task: its automatic worker (its activity's workerId) and every Claude session the user opened on it (#164). */
export const workersOf = (state: WorkersState, task: Task): Worker[] => workersIn(state.workers, activityOf(state, taskId(task))?.id);

/** When shutdown-when-done closes this worker (#233), in epoch ms: the window after the later of its entry into waiting and the arming.
 * Undefined unless the mode is armed and the worker waits. The reducer closes the worker then; the footer chip shows the time. */
export function closesAt(worker: Worker, state: Pick<State, 'shutdown' | 'shutdownIdleMinutes'>): number | undefined {
  if (!state.shutdown || worker.status !== 'waiting') return undefined;
  const armedAt = Date.parse(state.shutdown.armedAt);
  const since = worker.waitingSince === undefined ? armedAt : Math.max(Date.parse(worker.waitingSince), armedAt);
  return since + state.shutdownIdleMinutes * UNIT_MS.m;
}

// ms from `from` (ISO) to `to`: never negative, and an unreadable date counts nothing (#248)
function msSince(from: string | undefined, to: number): number {
  const ms = to - Date.parse(from ?? '');
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** What a run adds to its task's time up to `end` (#248): the wall clock since it started, and the part spent waiting, the finished waits
 * plus one still open. The reducer folds it in when the worker frees; taskTotals adds it for the workers still running. */
export const runTime = (worker: Worker, end: number): Pick<TaskUsage, 'ms' | 'waitingMs'> =>
  ({ ms: msSince(worker.startedAt, end), waitingMs: (worker.waitedMs ?? 0) + msSince(worker.waitingSince, end) });

/** The worker's finished waits once the open one ends at `now` (#248): what it keeps as it leaves waiting. Not waiting: nothing changes. */
export const closeWait = (worker: Worker, now: number): Pick<Worker, 'waitedMs'> =>
  (worker.waitingSince === undefined ? {} : { waitedMs: runTime(worker, now).waitingMs });

/** What a task without `usage` reads as (#248): nothing recorded yet. */
export const NO_USAGE: TaskUsage = { tokens: 0, ms: 0, waitingMs: 0, parts: [] };

/** A session named by the title its turn end read (#489); none leaves its name as it was. */
export const titled = (session: Session, title?: string): Session => (title === undefined ? session : { ...session, name: title });

/** The task's sessions the popup may resume (#164): minus any a live worker holds, since two terminals on one transcript would corrupt it,
 * and minus the automatic worker's own while it runs (its worker learns the id only at SessionStart). The route, the reducer and the popup
 * share this one rule. */
export function continuable(task: Task, state: WorkersState): Session[] {
  const live = activityOf(state, taskId(task));
  const running = live?.workerId !== undefined && live.sessionId !== undefined ? [live.sessionId] : [];
  const held = new Set([...workersOf(state, task).flatMap((s) => (s.sessionId ? [s.sessionId] : [])), ...running]);
  return sessionsOf(state, taskId(task)).filter((s) => !held.has(s.id));
}

/** The sessions that open in the task's worktree (#208): continuable minus those whose worktree the Hive removed (`repo`: the sidebar opens
 * them in the main repo), and none while the worktree is gone from disk. What the popup lists, POST /open checks and defaultSession picks. */
export const worktreeSessions = (task: Task, state: WorkersState): Session[] =>
  (activityOf(state, taskId(task))?.worktreeGone ? [] : continuable(task, state).filter((s) => !s.repo));

/** The session a non-auto task's popup preselects (#237), the way a normal start picks one: a `continue` stage resumes the newest session
 * nothing holds; any other stage, or nothing to resume, is a new one (undefined). */
export function defaultSession(task: Task, state: WorkersState, stage: Stage | undefined): string | undefined {
  return stage?.session === 'continue' ? worktreeSessions(task, state).at(-1)?.id : undefined;
}

/** The session mesma da etapa anterior resumes (#290): the newest one a stage run used that opens in the task's worktree; a free session, which
 * has no stage, is never it. The start route and the Start dialog read this one rule. */
export const previousSession = (task: Task, state: WorkersState): Session | undefined =>
  worktreeSessions(task, state).filter((s) => s.stages.length > 0).at(-1);

/** A task whose error the user may dismiss (#354): what canMoveToStage asks, an epic included: its refused end action (#31) freezes it and
 * a dismiss unfreezes it without moving it. */
export const canDismissError = (task: Task, state: WorkersState): boolean =>
  !task.missing && !task.leaving && activityOf(state, taskId(task))?.workerId === undefined && !inAction(activityOf(state, taskId(task))) // #755, #834
  && !workersOf(state, task).some((s) => !s.freeSession);

/** A task the user may move to another stage (#164, #366, #708), by right-click → move to or by a drag, auto on or off: still on the
 * source, not leaving it, and held by no stage run. A free session or a terminal on it holds nothing: the session is the user's own and
 * has no stage (#283). The reducer, the route, the menu and the drag share it. */
export const canMoveToStage = (task: Task, state: WorkersState): boolean =>
  task.item.epic === undefined && canDismissError(task, state); // #31: its children decide its stage; the rule would move it back at the next reduction

/** What a workspace's shell (#292) is named by in place of a task's slug: its launch's slug, which the kill effect and the log name. */
export const LOCAL_SLUG = 'workspace';

/** The pty id of the run an openSession or openTerminal dispatch just started (#249, #570): its spawnSession or spawnTerminal effect.
 * Undefined when neither is there — canOpenSession already refused it, or a race did. What POST /tasks/:id/open and
 * POST /activities/:id/sessions/:session/open answer with, so the page can attach the run at once instead of one more click on terminal. */
export function spawnedRun(effects: Effect[]): { ptyId: string } | undefined {
  for (const effect of effects) {
    if (effect.type === 'spawnSession' && effect.worker.runId) return { ptyId: effect.worker.runId }; // a local session too (#587, #590)
    if (effect.type === 'spawnTerminal') return { ptyId: effect.terminal.terminalId }; // a workspace's shell (#292) too
  }
  return undefined;
}

// git refused a delete activity stage's removal (#58, #182): stopped in a delete activity stage, still holding its worktree, carrying the refusal, and no
// delete activity in flight. A task still waiting for the stage's `after` has no error and is not an orphan.
const isDeleteActivityFailed = (task: Task, state: Pick<State, 'stages'> & WorkState): boolean => {
  const live = activityOf(state, taskId(task));
  return stageOf(state.stages, task.stage)?.action === 'deleteActivity' && live?.workerId === undefined && live?.worktree !== undefined && live.error !== undefined && !live.deleting;
};

/** The other task of `workspace` whose live activity owns the slug `task`'s activity has, or would get (#180). Two unqualified sources feeding
 * one workspace with the same id and title would otherwise share one worktree and branch. */
export function slugOwner(state: Pick<State, 'tasks' | 'activities' | 'activityRecords' | 'workspaces' | 'sourceWorkspaces'>, task: Task, workspace: string): Task | undefined {
  const own = activityOf(state, taskId(task));
  const slug = own?.slug ?? slugFor(task.item);
  const owner = state.activities.find((a) => a !== own && a.kind === 'task' && a.workspace === workspace && a.slug === slug && holdsSlug(state, a));
  return owner ? taskOfActivity(state, owner.id) : keptSlugOwner(state, task, workspace, slug);
}

// A deleted activity's task still owns its slug while a record of its holds sessions (#629), as main's hasWorktree counted its kept sessions
function keptSlugOwner(state: Pick<State, 'tasks' | 'activityRecords' | 'workspaces' | 'sourceWorkspaces'>, task: Task, workspace: string, slug: string): Task | undefined {
  return state.activityRecords.flatMap((r) => {
    const other = r.slug === slug && r.sessions.length > 0 && !r.taskIds.includes(taskId(task)) ? taskOfActivity(state, r.id) : undefined;
    return other && resolveWorkspace(other, state.workspaces, state.sourceWorkspaces, state.tasks) === workspace ? [other] : [];
  })[0];
}

/** Why the task's worktree cannot be created (#180): what the reducer's refusal and the worktree route's 409 say. */
export const slugTakenMessage = (slug: string, owner: Task): string => `slug ${slug} is used by ${owner.item.id}`;

/** The Settings tab's rows (#181), per workspace (#179): each worktree git lists under .hive/worktrees with the task that owns its slug, if
 * any, and why it is an orphan. The branch is git's, never the task's. Derived from git plus the state: nothing about it is stored. */
export function worktreeRows(
  listed: Pick<WorktreeRow, 'slug' | 'path' | 'branch'>[], state: Pick<State, 'tasks' | 'stages' | 'workers' | 'workspaces' | 'sourceWorkspaces' | 'deleteActivity' | 'activities' | 'activityRecords'>, workspace: string,
): WorktreeRow[] {
  return listed.map((worktree): WorktreeRow => {
    const task = worktreeOwner(state, workspace, worktree.slug);
    if (!task) return { ...worktree, workspace, orphan: keptActivity(state, workspace, worktree.slug) ? 'kept' : 'noTask' }; // #861
    const live = activityOf(state, taskId(task));
    const error = live?.error;
    const owner = { id: taskId(task), activityId: live?.id ?? '', title: taskLabel(task), removable: canDeleteActivity(task, state), ...(error === undefined ? {} : { error }) };
    return isDeleteActivityFailed(task, state) ? { ...worktree, workspace, task: owner, orphan: 'deleteActivityFailed' } : { ...worktree, workspace, task: owner };
  });
}
