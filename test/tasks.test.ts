import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchProblem, candidates, canRunIn, taskId, canMoveToStage, canCloseMissing, citedColumns, closeWait, entryStage, canRemoveCreated, canSetWorkspace, DEFAULT_BRANCH_TEMPLATE, defaultSession, differsFromSource, DURATION, dueActions, durationMs, enter, hasWorktree, isDue, isGate, isLive, isPastFirstStage, isStarted, createdRemovalBlocker, markRemoved, mergeTasks, moveTask, LOCAL_SLUG, type WorkspaceNames, renameSource, renamedId, renderBranch, replaceSegment, resetOrder, resolveWorkspace, continuable, runTime, runningFirst, type Runs, sessionIdentity, sessionsOf, slugFor, slugOwner, slugTakenMessage, spawnedRun, titleSlug, worktreeRows, worktreeSessions, HIVE_SOURCE, isReservedSource, sourceOf } from '../src/tasks.js';
import { COLUMN_WRITE_TIMEOUT_MS } from '../src/column-write.js';
import { taskTotals, touchSession } from '../src/record-kit.js';
import { initialState } from '../src/orchestrator.js';
import { localActivityId } from '../src/activities.js';
import { activityIdOf, bareTask, movedWork, withKeptRecord, withWork, type WithWork } from './fixtures/work.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, ActivityRecord, SourceItem, State, Task, Session, DeleteActivityScope, Stage, Effect, Terminal, Transition, Worker, Item } from '../src/types.js';
import { DELETE_ACTIVITY_DEFAULTS } from '../src/types.js';
import { move } from './fakes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const AT_NOW = new Date(NOW).toISOString(); // a poll's fixed clock (#889)
const item = (n: number): Item => ({ itemId: `item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const DEV: LegacyStage = { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}', after: '12h' };
const DONE: LegacyStage = { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity', after: '5d' };
const AT_ONCE: LegacyStage = { name: 'now', from: { board: ['Now'] }, action: 'deleteActivity' };
const STAGES = [DEV, DONE, AT_ONCE];
const task = (n: number, stage: Stage, extra: Partial<WithWork> = {}): WithWork =>
  ({ item: item(n), stage: stage.name, boardColumn: stage.from.board?.[0] ?? '', auto: true, ...extra });
// Every fixture task's activity (#629): a worker or a terminal on itemN points at activityIdOf('itemN'), each record empty
const { activities: TASK_ACTIVITIES, activityRecords: TASK_RECORDS } = withWork(withWork(withWork(withWork(initialState(0), 'item1'), 'item2'), 'item3'), 'item4');
const TASK_WORK: Pick<State, 'activities' | 'activityRecords'> = { activities: TASK_ACTIVITIES, activityRecords: TASK_RECORDS };
const runsOf = (workers: Worker[], terminals: Terminal[] = []): Runs => ({ workers, terminals, activities: TASK_WORK.activities, activityRecords: TASK_WORK.activityRecords });
// No run at all: the fixtures that mean "running" set the activity's workerId, which isLive reads on its own (#356, #629)
const NO_RUNS: Runs = runsOf([]);
// `runs` with the run fields the fixture tasks carry moved onto their activities (#629): what the reducer would hold
const runsFor = (tasks: WithWork[], runs: Runs = NO_RUNS): Runs => {
  const { activities, activityRecords } = movedWork({ tasks, ...runs });
  return { ...runs, activities, activityRecords };
};
// One poll of the only source, `listed` in source order (#180), with the runs the state holds while it lands (#356), at `now` (#889)
const merge = (tasks: WithWork[], stages: LegacyStage[], listed: SourceItem[], runs: Runs = NO_RUNS, now = new Date().toISOString()): Task[] =>
  mergeTasks(tasks.map(bareTask), stages, { source: 'board', items: listed }, ['board'], listed.map((c) => c.item.itemId), runsFor(tasks, runs), now);
const ONE: WorkspaceNames = { workspaces: ['hive'], sourceWorkspaces: {} };
// #629: candidates and dueDeletions read the state, the run fields on the activities; the fixtures keep their arguments
const cands = (tasks: WithWork[], stages: LegacyStage[], now: number, runs: Runs, scope: WorkspaceNames): Task[] =>
  candidates({ tasks: tasks.map(bareTask), stages, ...runsFor(tasks, runs), ...scope }, now);
const dues = (tasks: WithWork[], stages: LegacyStage[], now: number, runs: Runs, deleteActivity: DeleteActivityScope): Task[] =>
  dueActions({ tasks: tasks.map(bareTask), stages, deleteActivity, ...ONE, ...runsFor(tasks, runs) }, now, true);
// What the session reads take of the State (#629): the task's records, a task's activity's sessions in its record
const NO_WORK: Pick<State, 'activities' | 'activityRecords'> = { activities: [], activityRecords: [] };
const work = (sessions: Session[], itemId = 'item1', live: Partial<Activity> = {}): Pick<State, 'activities' | 'activityRecords'> => {
  const { activities, activityRecords } = withWork(initialState(0), itemId, live, { sessions });
  return { activities, activityRecords };
};
// Task n's live activity with the worktree fields a fixture gives it (#629), under the slug the factory's item names
const pairs = (fields: [number, Partial<Activity>][]): Pick<State, 'activities' | 'activityRecords'> => {
  const { activities, activityRecords } = fields.reduce((st, [n, f]) => withWork(st, `item${n}`, { slug: `hive-${n}-task-${n}`, ...f }), initialState(0));
  return { activities, activityRecords };
};

test('durationMs reads minutes, hours and days; DURATION rejects everything else and durationMs answers undefined for it', () => {
  assert.equal(durationMs('30m'), 30 * 60_000);
  assert.equal(durationMs('12h'), 12 * HOUR);
  assert.equal(durationMs('5d'), 5 * DAY);
  assert.equal(durationMs('1m'), 60_000);
  for (const bad of ['5', '0d', '5 d', '1w', 'd', '05d', '', '-1h', '1.5h', '1H']) {
    assert.equal(DURATION.test(bad), false, JSON.stringify(bad));
    assert.equal(durationMs(bad), undefined, JSON.stringify(bad));
  }
});

test('isDue: a stage without after is always due; with after, once enteredAt + after has passed; without enteredAt or with an unreadable one, never', () => {
  assert.equal(isDue(task(1, AT_ONCE), AT_ONCE, NOW), true);
  assert.equal(isDue(task(1, DONE, { enteredAt: ago(4 * DAY) }), DONE, NOW), false);
  assert.equal(isDue(task(1, DONE, { enteredAt: ago(5 * DAY) }), DONE, NOW), true, 'exactly on time counts');
  assert.equal(isDue(task(1, DONE, { enteredAt: ago(6 * DAY) }), DONE, NOW), true);
  assert.equal(isDue(task(1, DONE), DONE, NOW), false, 'a task from before enteredAt existed: the poll stamps it first');
  assert.equal(isDue(task(1, DONE, { enteredAt: 'yesterday' }), DONE, NOW), false, 'an unreadable stamp never comes due; a manual start still works');
  assert.equal(isDue(task(1, DONE, { enteredAt: ago(9 * DAY) }), { ...DONE, after: '1w' }, NOW), false, 'a bad after (the config refuses it anyway) never comes due');
});

test('candidates skips a task in a prompt stage with after until it is due, keeping the other rules', () => {
  const fresh = task(1, DEV, { enteredAt: ago(HOUR) });
  const due = task(2, DEV, { enteredAt: ago(13 * HOUR) });
  const unstamped = task(3, DEV);
  const cleanup = task(4, DONE, { enteredAt: ago(6 * DAY) });
  assert.deepEqual(cands([fresh, due, unstamped, cleanup], STAGES, NOW, runsOf([]), ONE).map((c) => c.item.id), ['2'], 'a delete activity stage has no prompt: never a candidate');
  assert.deepEqual(cands([fresh, due], STAGES, NOW + 12 * HOUR, runsOf([]), ONE).map((c) => c.item.id), ['1', '2'], 'board order once both are due');
  assert.deepEqual(cands([fresh], [{ ...DEV, after: undefined }], NOW, runsOf([]), ONE).map((c) => c.item.id), ['1'], 'no after: due at once, as today');
});

test('candidates puts a task in a later stage first, even when it sits below the other in the Hive order; two tasks in the same stage keep that order (#316)', () => {
  const SPEC: LegacyStage = { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' };
  const BUILD: LegacyStage = { name: 'build', from: { board: ['Ready'] }, prompt: '/hive-build {url}' };
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  assert.deepEqual(ids(cands([task(1, SPEC), task(2, BUILD)], [SPEC, BUILD], NOW, runsOf([]), ONE)), ['2', '1'], 'build comes after spec: its task wins, though it sits below');
  assert.deepEqual(ids(cands([task(1, SPEC), task(2, BUILD)], [BUILD, SPEC], NOW, runsOf([]), ONE)), ['1', '2'], 'the stages array decides, not the names');
  assert.deepEqual(ids(cands([task(1, BUILD), task(2, BUILD)], [SPEC, BUILD], NOW, runsOf([]), ONE)), ['1', '2'], 'same stage: the Hive order');
  assert.deepEqual(ids(cands([task(2, BUILD), task(1, BUILD)], [SPEC, BUILD], NOW, runsOf([]), ONE)), ['2', '1'], 'a drag changes it');
});

test('dueDeletions: stopped, present, error-free tasks in a due delete activity stage, in source order; blockers do not matter', () => {
  const due = task(1, DONE, { enteredAt: ago(6 * DAY) });
  const blocked = task(2, DONE, { enteredAt: ago(6 * DAY), item: { ...item(2), blockedBy: ['9'] } });
  const early = task(3, DONE, { enteredAt: ago(DAY) });
  const running = task(4, DONE, { enteredAt: ago(6 * DAY), workerId: 's1' });
  const missing = task(5, DONE, { enteredAt: ago(6 * DAY), missing: true });
  const failed = task(6, DONE, { enteredAt: ago(6 * DAY), error: "error: The branch 'x' is not fully merged." });
  const prompt = task(7, DEV, { enteredAt: ago(6 * DAY) });
  const atOnce = task(8, AT_ONCE);
  const orphan = task(9, DONE, { enteredAt: ago(6 * DAY), orphan: true });
  assert.deepEqual(dues([prompt, atOnce, due, blocked, early, running, missing, failed, orphan], STAGES, NOW, NO_RUNS, DELETE_ACTIVITY_DEFAULTS).map((c) => c.item.id), ['8', '1', '2', '9']);
  assert.deepEqual(dues([], STAGES, NOW, NO_RUNS, DELETE_ACTIVITY_DEFAULTS), []);
});

test('enter stamps enteredAt with the stage change; mergeTasks stamps a task that lacks it, keeps one that has it and resets it on a source move into another stage', () => {
  const before = Date.now();
  const old = task(1, DEV, { enteredAt: ago(DAY) });
  const moved = enter(old, DONE);
  assert.equal(moved.stage, 'done');
  assert.ok(Date.parse(moved.enteredAt!) >= before, 'a fresh stamp');
  assert.equal(old.enteredAt, ago(DAY), 'the input is untouched');
  const unstamped = task(2, DEV);
  const merged = merge([old, unstamped], STAGES, [{ item: item(1), column: 'Ready' }, { item: item(2), column: 'Ready' }, { item: item(3), column: 'Done' }]);
  assert.equal(merged[0].enteredAt, old.enteredAt, 'same board column: the stamp stays');
  assert.ok(Date.parse(merged[1].enteredAt!) >= before, 'a task saved before the field existed: stamped by this poll');
  assert.ok(Date.parse(merged[2].enteredAt!) >= before, 'a new task is stamped as it enters');
  assert.deepEqual(merged.map((c) => c.stage), ['dev', 'dev', 'done']);
  const [followed] = merge([old], STAGES, [{ item: item(1), column: 'Done' }]);
  assert.equal(followed.stage, 'done');
  assert.ok(Date.parse(followed.enteredAt!) >= before, 'a board move into another column restarts the clock');
  const [kept] = merge([old], STAGES, [{ item: item(1), column: 'In progress' }]);
  assert.deepEqual([kept.stage, kept.boardColumn, kept.enteredAt], ['dev', 'In progress', old.enteredAt], 'a move to a stage that is no door keeps the stamp');
  const [gone] = merge([unstamped], STAGES, []);
  assert.ok(gone.missing && Date.parse(gone.enteredAt!) >= before, 'an unlisted task is stamped too');
});

test('a listed task is born with its source\'s autoOnEntry, on when absent; a later poll or a move on the source back to an entry stage never touches auto (#688)', () => {
  const manual = (n: number, column = 'Ready'): SourceItem => ({ item: { ...item(n), autoOnEntry: false }, column });
  const [born, plain] = merge([], STAGES, [manual(1), { item: item(2), column: 'Ready' }]);
  assert.deepEqual([born.auto, plain.auto], [false, true], 'no autoOnEntry (a fake source, a task listed before #688): born auto (#573)');
  const [repolled] = merge([{ ...task(1, DEV), auto: true }], STAGES, [manual(1)]);
  assert.equal(repolled.auto, true, 'the user turned it back on: the poll refreshes the item, not the switch');
  const [back] = merge([{ ...task(1, DONE), auto: true }], STAGES, [manual(1, 'Ready')]);
  assert.deepEqual([back.stage, back.auto], ['dev', true], 'a move on the source back to an entry stage keeps the switch');
  const [off] = merge([{ ...task(2, DEV), auto: false }], STAGES, [{ item: { ...item(2), autoOnEntry: true }, column: 'Ready' }]);
  assert.equal(off.auto, false, 'nor turns it back on');
});

test("runningFirst puts the running tasks of the started task's stage on top in their order, the started one last among them, then the stopped ones in their order; other stages keep their indexes; unknown id or nothing to move leave the same list", () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const running = (n: number, stage: Stage = DEV): WithWork => task(n, stage, { workerId: `s${n}` });
  // dev: 1 running, 2 and 3 stopped, 5 just started from the bottom (it already holds its worker, as occupy leaves it); done: 4 and 6 at indexes 3 and 5
  const tasks = [running(1), task(2, DEV), task(3, DEV), running(4, DONE), running(5), task(6, DONE)];
  assert.deepEqual(ids(runningFirst(tasks, 'item5', runsFor(tasks))), ['1', '5', '2', '4', '3', '6'], 'right after the running one, above the stopped ones; done keeps its indexes (3 and 5)');
  assert.deepEqual(ids(tasks), ['1', '2', '3', '4', '5', '6'], 'the input is untouched');
  // running tasks scattered by a drag: 1 stopped, 2 running, 3 stopped, 5 running, 7 just started; done in between
  const scattered = [task(1, DEV), running(2), task(3, DEV), running(4, DONE), running(5), running(7), task(6, DONE)];
  assert.deepEqual(ids(runningFirst(scattered, 'item7', runsFor(scattered))), ['2', '5', '7', '4', '1', '3', '6'], 'running ones gathered on top in their order, the started one last among them; stopped ones keep their order; done untouched');
  const above = [running(5), running(1), task(2, DEV)]; // the started one sits above a running one
  assert.deepEqual(ids(runningFirst(above, 'item5', runsFor(above))), ['1', '5', '2'], 'last among the running ones, whatever its place');
  assert.equal(runningFirst(tasks, 'item9', runsFor(tasks)), tasks, 'unknown id: the same list');
  const onTop = [running(1), running(5), task(2, DEV), running(4, DONE), task(3, DEV)];
  assert.equal(runningFirst(onTop, 'item5', runsFor(onTop)), onTop, 'already right below the running ones: the same list, so nothing downstream sees a change');
  assert.deepEqual(ids(runningFirst(onTop, 'item1', runsFor(onTop))), ['5', '1', '2', '4', '3'], 'a running task started again goes last among the running ones; done keeps its index');
  const alone = [task(1, DEV), running(4, DONE)];
  assert.equal(runningFirst(alone, 'item4', runsFor(alone)), alone, 'alone in its stage: nothing to move');
  assert.deepEqual(ids(runningFirst([], 'item1', NO_RUNS)), [], 'no tasks at all');
});

// The issue this plan implements, as the source would list it.
const ISSUE_125: Item = {
  itemId: 'PVTI_1', id: '125', title: 'the Hive creates and owns the worktree; the worker only gets a cwd',
  body: '', url: 'https://github.com/dennys-bd/agent-hive/issues/125',
};

test('renderBranch replaces {id}, {title} and {slug}, leaves anything else as typed, and renders the default template for #125', () => {
  assert.equal(renderBranch(DEFAULT_BRANCH_TEMPLATE, ISSUE_125), 'hive/125-the-hive-creates-and-owns-the');
  assert.equal(renderBranch('feat/{id}-{title}', ISSUE_125), 'feat/125-the-hive-creates-and-owns-the');
  assert.equal(renderBranch('{slug}', ISSUE_125), slugFor(ISSUE_125), '{slug} is the very name the worktree directory carries');
  assert.equal(renderBranch('wip/{id}/{unknown}', ISSUE_125), 'wip/125/{unknown}', 'an unknown placeholder is text, not an error');
  assert.equal(renderBranch('hive/{id}-{title}', { ...ISSUE_125, id: 'T-12', title: 'Adicionar Autenticação' }), 'hive/T-12-adicionar-autenticacao',
    'only the title is kebab-ized: the id is the board\'s own and reaches the branch as it is');
});

test('titleSlug is the kebab title the slug already used — capped at 30 with no trailing hyphen — and slugFor still returns what it returned before', () => {
  assert.equal(titleSlug(ISSUE_125), 'the-hive-creates-and-owns-the');
  assert.equal(titleSlug({ ...ISSUE_125, title: '  --weird__title!!  ' }), 'weird-title');
  assert.equal(slugFor({ ...ISSUE_125, id: '12', title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...ISSUE_125, id: 'Épico #3', title: 'x' }), 'hive-epico-3-x');
});

test('branchProblem: a template without {id} or {slug} is not unique, one that renders a name git refuses is invalid, and an empty one is the default', () => {
  for (const ok of ['', DEFAULT_BRANCH_TEMPLATE, 'feat/{id}-{title}', '{slug}', 'wip/{id}']) {
    assert.equal(branchProblem(ok), undefined, ok);
  }
  assert.equal(branchProblem('feat/{title}'), 'settings.error.branch.unique', 'two tasks would share a branch and the second worktree add would fail');
  assert.equal(branchProblem('hive/main'), 'settings.error.branch.unique');
  for (const bad of ['{id}//x', '{id} x', 'hive/{id}.lock', 'hive/../{id}', 'hive/{id}^', '/{id}', '{id}/', 'hive/.{id}', 'hive/{id}~1', 'hive/{id}:x', 'hive/{id}?', 'hive/{id}*', 'hive/{id}[x', 'hive/{id}\\x']) {
    assert.equal(branchProblem(bad), 'settings.error.branch.invalid', bad);
  }
});

test('moveTask pins the task it moves, and pins it even when the order does not change; resetOrder drops the pin from its own stage; enter drops it on a stage change (#123)', () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const pins = (list: Task[]): (true | undefined)[] => list.map((c) => c.pinned);
  const tasks = [task(1, DEV), task(2, DEV), task(3, DONE)];
  const moved = moveTask(tasks, 'item2', 'item1');
  assert.deepEqual([ids(moved), pins(moved)], [['2', '1', '3'], [true, undefined, undefined]], 'only the dragged task is pinned: the neighbours it displaced stay free');
  assert.equal(tasks[1].pinned, undefined, 'the input is untouched');
  assert.equal(moveTask(moved, 'item2', 'item1'), moved, 'already pinned and already there: the same list, so nothing downstream sees a change');
  const last = moveTask(tasks, 'item2');
  assert.deepEqual([ids(last), pins(last)], [['1', '2', '3'], [undefined, true, undefined]], 'already the last of its stage: the order stands and the pin is the change');
  const itself = moveTask(tasks, 'item1', 'item1');
  assert.deepEqual([ids(itself), pins(itself)], [['1', '2', '3'], [true, undefined, undefined]], 'dropped on itself: the gesture is still a statement');
  assert.deepEqual(pins(moveTask(tasks, 'item3')), [undefined, undefined, true], 'alone in its stage');
  assert.equal(moveTask(tasks, 'item9'), tasks, 'unknown task: refused, no pin');
  assert.equal(moveTask(tasks, 'item1', 'item9'), tasks, 'unknown before: refused, no pin');
  assert.equal(moveTask(tasks, 'item1', 'item3'), tasks, 'another stage: refused, no pin');
  const reset = resetOrder(moved, 'dev', ['item1', 'item2'], NO_RUNS);
  assert.deepEqual([ids(reset), pins(reset)], [['1', '2', '3'], [undefined, undefined, undefined]], 'the board order back, and the stage follows it again from now on');
  const other = resetOrder(moveTask(moved, 'item3'), 'dev', ['item1', 'item2'], NO_RUNS);
  assert.equal(other[2].pinned, true, 'the other stage keeps its pin');
  assert.equal(enter(moved[0], DONE).pinned, undefined, 'a new stage is a new queue');
  assert.equal(moved[0].pinned, true, 'enter does not touch its input');
});

test('mergeTasks: per stage the anchored tasks (pinned, running, unlisted) hold the positions they occupy and every other task takes the rest in the source order, new tasks included; other stages keep their indexes (#123)', () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const board = (n: number, stage: Stage = DEV): SourceItem => ({ item: item(n), column: stage.from.board?.[0] ?? '' });
  // dev: 4 dragged to the top, 1 running, 2 and 3 free; done: 5, at index 4 of the global array
  const tasks = [task(4, DEV, { pinned: true }), task(1, DEV, { workerId: 's1' }), task(2, DEV), task(3, DEV), task(5, DONE)];
  const merged = merge(tasks, STAGES, [board(3), board(2), board(1), board(4), board(5, DONE)]);
  assert.deepEqual(ids(merged), ['4', '1', '3', '2', '5'], 'the pinned and the running hold positions 0 and 1; 2 and 3 fill the rest in board order; done keeps its index');
  assert.deepEqual(ids(tasks), ['4', '1', '2', '3', '5'], 'the input is untouched');
  assert.equal(merged[0].pinned, true, 'a poll never drops a pin');
  const simple = [task(1, DEV), task(2, DEV), task(3, DEV)];
  assert.deepEqual(ids(merge(simple, STAGES, [board(4), board(2), board(1)])), ['4', '2', '3', '1'], '3 is gone from the board and holds its index; 4 is new and enters at its board position, not at the end');
  assert.deepEqual(ids(merge(simple, STAGES, [])), ['1', '2', '3'], 'nothing listed: no order to follow, everyone holds');
  assert.deepEqual(ids(merge(simple, STAGES, [board(3), board(2), board(1)])), ['3', '2', '1'], 'nothing anchored: the stage is the board');
  const [left] = merge([task(1, DEV, { pinned: true })], STAGES, [{ item: item(1), column: 'Done' }]);
  assert.deepEqual([left.stage, left.pinned], ['done', undefined], 'a board move into another Hive stage frees the task');
});

test('mergeTasks keeps a local task as it is (never missing) at its index; resetOrder puts the local tasks after the listed ones in their relative order', () => {
  const local = (n: number): Task => ({
    item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Local ${n}`, body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true,
    created: true, enteredAt: ago(HOUR),
  });
  const tasks = [task(1, DEV, { enteredAt: ago(HOUR) }), local(1), task(2, DEV, { enteredAt: ago(HOUR) }), local(2)];
  const listed: SourceItem[] = [{ item: item(2), column: 'Ready' }, { item: item(1), column: 'Ready' }];
  const merged = merge(tasks, STAGES, listed);
  assert.deepEqual(merged.map((c) => c.item.id), ['2', 'HIVE-1', '1', 'HIVE-2'], 'the listed tasks follow the board around the local ones, which hold their index (#123)');
  assert.deepEqual(merged.filter((c) => c.created), [local(1), local(2)], 'untouched: no missing mark');
  assert.deepEqual(resetOrder(merged, 'dev', ['item2', 'item1'], NO_RUNS).map((c) => c.item.id), ['2', '1', 'HIVE-1', 'HIVE-2']);
});

// #889: task 1 sits in done after the Hive wrote Done over Ready, the write `age` ms before AT_NOW
const writtenDone = (age: number, extra: Partial<WithWork> = {}): WithWork =>
  task(1, DONE, { enteredAt: ago(HOUR), columnWrite: { column: 'Done', stale: ['Ready'], at: ago(age) }, ...extra });
const seenIn = (column: string, title = 'Task 1'): SourceItem => ({ item: { ...item(1), title }, column });

test('mergeTasks over a column write: the written column clears the mark, a stale one inside the window is ignored while the item refreshes, an expired mark or a third column lets a stopped task follow (#889)', () => {
  const [confirmed] = merge([writtenDone(30_000)], STAGES, [seenIn('Done')], NO_RUNS, AT_NOW);
  assert.deepEqual([confirmed.stage, confirmed.boardColumn, confirmed.columnWrite, confirmed.enteredAt], ['done', 'Done', undefined, ago(HOUR)]);
  const [stale] = merge([writtenDone(30_000, { missing: true })], STAGES, [seenIn('Ready', 'Renamed')], NO_RUNS, AT_NOW);
  assert.deepEqual([stale.stage, stale.boardColumn, stale.enteredAt], ['done', 'Done', ago(HOUR)], 'a read from before the write: no move back');
  assert.deepEqual(stale.columnWrite, { column: 'Done', stale: ['Ready'], at: ago(30_000) }, 'the mark waits for the source to show the write');
  assert.deepEqual([stale.item.title, stale.missing], ['Renamed', undefined], 'everything but the column refreshes');
  const [expired] = merge([writtenDone(COLUMN_WRITE_TIMEOUT_MS)], STAGES, [seenIn('Ready')], NO_RUNS, AT_NOW);
  assert.deepEqual([expired.stage, expired.boardColumn, expired.columnWrite], ['dev', 'Ready', undefined], 'past the window the source wins, as over a failed write');
  const [third] = merge([writtenDone(30_000)], STAGES, [seenIn('Now')], NO_RUNS, AT_NOW);
  assert.deepEqual([third.stage, third.boardColumn, third.columnWrite], ['now', 'Now', undefined], 'a column the write never replaced is a human move');
});

test('a running task keeps its written boardColumn through a stale read; a third column still overwrites it without moving the task (#889)', () => {
  const running = writtenDone(30_000, { workerId: 's1' });
  const [stale] = merge([running], STAGES, [seenIn('Ready')], NO_RUNS, AT_NOW);
  assert.deepEqual([stale.stage, stale.boardColumn, stale.columnWrite?.column], ['done', 'Done', 'Done'], 'today the stale value overwrote it');
  const [third] = merge([running], STAGES, [seenIn('Now')], NO_RUNS, AT_NOW);
  assert.deepEqual([third.stage, third.boardColumn, third.columnWrite], ['done', 'Now', undefined], 'a running task never follows the source, as today');
});

const WORKER = '1a2b3c4d-1111-4111-8111-111111111111';
const sessionWorker = (n: number, sessionId?: string): Worker => ({ id: `m${n}`, status: 'working', activityId: activityIdOf(`item${n}`), runId: WORKER, freeSession: true, ...(sessionId ? { sessionId } : {}) });
const shellOn = (n: number): Terminal => ({ terminalId: `sh${n}`, activityId: activityIdOf(`item${n}`), startedAt: ago(HOUR), cwd: '/repo' });

test('a task with auto off is neither a candidate nor a due delete activity; with auto back on it is a candidate again only once no worker holds it (#164, #573)', () => {
  const ready = task(1, DEV, { enteredAt: ago(DAY) });
  const cleanable = task(2, DONE, { enteredAt: ago(6 * DAY) });
  assert.deepEqual(cands([{ ...ready, auto: false }], STAGES, NOW, runsOf([]), ONE), []);
  assert.deepEqual(dues([{ ...cleanable, auto: false }], STAGES, NOW, NO_RUNS, DELETE_ACTIVITY_DEFAULTS), []);
  assert.deepEqual(cands([ready], STAGES, NOW, runsOf([sessionWorker(1)]), ONE), [], 'auto on with a Claude session still open: the fill must not start a worker in that worktree');
  assert.deepEqual(cands([ready], STAGES, NOW, runsOf([{ ...sessionWorker(1), status: 'empty' }]), ONE).map((c) => c.item.id), ['1']);
});

test('dueDeletions skips a task any worker holds: a manual Claude session on a task that is not manual runs inside its worktree (#208)', () => {
  const due = task(1, DONE, { enteredAt: ago(6 * DAY) });
  assert.deepEqual(dues([due], STAGES, NOW, runsOf([sessionWorker(1)]), DELETE_ACTIVITY_DEFAULTS), [], 'git never removes a worktree with a session inside');
  assert.deepEqual(dues([due], STAGES, NOW, runsOf([{ ...sessionWorker(1), status: 'empty' }]), DELETE_ACTIVITY_DEFAULTS).map((c) => c.item.id), ['1'], 'an empty worker holds nothing');
  assert.deepEqual(dues([due], STAGES, NOW, runsOf([sessionWorker(2)]), DELETE_ACTIVITY_DEFAULTS).map((c) => c.item.id), ['1'], 'another task\'s session');
});

const NON_AUTO: DeleteActivityScope = { ...DELETE_ACTIVITY_DEFAULTS, nonAutoTasks: true };

test('dueDeletions takes a task without auto only when the scope\'s nonAutoTasks is on, and only when every other condition holds (#496)', () => {
  const noAuto = task(1, DONE, { enteredAt: ago(6 * DAY), auto: false });
  assert.deepEqual(dues([noAuto], STAGES, NOW, NO_RUNS, DELETE_ACTIVITY_DEFAULTS), [], 'off: left for a delete activity by hand, as before');
  assert.deepEqual(dues([noAuto], STAGES, NOW, NO_RUNS, NON_AUTO).map((c) => c.item.id), ['1']);
  const held: [Task, Runs, string][] = [
    [noAuto, runsOf([sessionWorker(1)]), 'a worker holds it'],
    [noAuto, runsFor([{ ...noAuto, stopped: true }]), 'stopped'],
    [noAuto, runsFor([{ ...noAuto, error: "error: The branch 'x' is not fully merged." }]), 'carries an error'],
    [{ ...noAuto, enteredAt: ago(DAY) }, NO_RUNS, 'not yet past after'],
  ];
  for (const [c, runs, why] of held) assert.deepEqual(dues([c], STAGES, NOW, runs, NON_AUTO), [], why);
  assert.deepEqual(dues([noAuto], STAGES, NOW, runsOf([], [shellOn(1)]), NON_AUTO).map((c) => c.item.id), ['1'], 'a terminal holds nothing: deleting closes it (#573)');
});

test('sessionsOf reads every record of the task, oldest first; continuable drops the sessions a live worker holds and the automatic worker\'s own while it runs (#164, #629)', () => {
  const session = (id: string): Session => ({ id, startedAt: ago(HOUR), stages: ['dev'], agent: 'claude' as const, lastUsedAt: ago(HOUR) });
  assert.deepEqual(sessionsOf(NO_WORK, 'item1'), []);
  const kept: ActivityRecord = { id: 'old', taskIds: ['item1'], sessions: [{ ...session('z-session-0009'), repo: true }] };
  assert.deepEqual(sessionsOf({ activityRecords: [kept, ...work([session('a-session-0001')]).activityRecords] }, 'item1').map((s) => s.id), ['z-session-0009', 'a-session-0001'],
    'a deleted activity\'s record first, then the live one\'s');
  const listed = task(1, DEV);
  const records = work([session('a-session-0001'), session('b-session-0002')], 'item1', { sessionId: 'b-session-0002' });
  assert.deepEqual(continuable(listed, { workers: [], ...records }).map((s) => s.id), ['a-session-0001', 'b-session-0002']);
  assert.deepEqual(continuable(listed, { workers: [sessionWorker(1, 'a-session-0001')], ...records }).map((s) => s.id), ['b-session-0002'], 'two terminals on one transcript would corrupt it');
  const running = work([session('a-session-0001'), session('b-session-0002')], 'item1', { sessionId: 'b-session-0002', workerId: 's1' });
  assert.deepEqual(continuable(listed, { workers: [{ id: 's1', status: 'working', activityId: activityIdOf('item1') }], ...running }).map((s) => s.id), ['a-session-0001'],
    'the running worker holds the activity\'s sessionId even before its SessionStart tells the worker');
});

test('sessionIdentity is the session\'s first 8 characters of its id, then its stages joined by " → " (#346)', () => {
  const session = { id: 'abcdefgh12345', startedAt: ago(DAY), stages: ['spec', 'plan'], agent: 'claude' as const, lastUsedAt: ago(HOUR) };
  assert.equal(sessionIdentity(session), 'abcdefgh · spec → plan');
});

test('touchSession appends a session the task does not list to its live record, or moves a listed one on where it is listed: its stage added unless it is already the last one, lastUsedAt set, the others untouched (#236, #629)', () => {
  const at = ago(HOUR);
  const later = ago(0);
  const c = task(1, DEV);
  const live = withWork({ ...initialState(0), tasks: [c] }, 'item1');
  const fresh = touchSession(live, c, 'a-session-0001', 'dev', at, 'claude');
  assert.deepEqual(sessionsOf(fresh, 'item1'), [{ id: 'a-session-0001', startedAt: at, stages: ['dev'], agent: 'claude', lastUsedAt: at }]);
  const two = touchSession(fresh, c, 'b-session-0002', 'spec', at, 'claude');
  const moved = touchSession(two, c, 'a-session-0001', 'review', later, 'claude');
  assert.deepEqual(sessionsOf(moved, 'item1'), [
    { id: 'a-session-0001', startedAt: at, stages: ['dev', 'review'], agent: 'claude' as const, lastUsedAt: later },
    { id: 'b-session-0002', startedAt: at, stages: ['spec'], agent: 'claude' as const, lastUsedAt: at },
  ]);
  assert.deepEqual(sessionsOf(touchSession(moved, c, 'a-session-0001', 'review', later, 'claude'), 'item1')[0].stages, ['dev', 'review'], 'the same stage again: no repeat');
  assert.deepEqual(sessionsOf(touchSession(moved, c, 'a-session-0001', 'dev', later, 'claude'), 'item1')[0].stages, ['dev', 'review', 'dev'], 'back to an earlier stage: a new entry');
  const counted = withWork(live, 'item1', {}, { sessions: [{ id: 'a-session-0001', startedAt: at, stages: ['dev'], agent: 'claude' as const, lastUsedAt: at, tokens: 1200 }] });
  assert.equal(sessionsOf(touchSession(counted, c, 'a-session-0001', 'review', later, 'claude'), 'item1')[0].tokens, 1200, 'used again, it keeps the baseline a resume counts from (#248)');
  const older = withKeptRecord(live, 'item1', 'old', { sessions: [{ id: 'saved-session-0001', startedAt: at, stages: ['dev'], agent: 'claude' as const, lastUsedAt: at, repo: true }] });
  const reused = touchSession(older, c, 'saved-session-0001', 'dev', later, 'claude');
  assert.deepEqual(reused.activityRecords.map((r) => r.sessions.map((s) => [s.id, s.lastUsedAt])), [[], [['saved-session-0001', later]]],
    'a session an older record lists is used again there, not copied into the live one');
});

test('defaultSession follows the stage\'s session policy as a normal start does: new (undefined) on a new stage, the newest session nothing holds on a continue stage, new there when nothing is continuable (#237)', () => {
  const CONTINUE: LegacyStage = { ...DEV, name: 'spec', session: 'continue' };
  const session = (id: string, hours: number) => ({ id, startedAt: ago(hours * HOUR), stages: ['dev'], agent: 'claude' as const, lastUsedAt: ago(hours * HOUR) });
  const marked = task(1, CONTINUE, { auto: false });
  const records = work([session('a-session-0001', 3), session('b-session-0002', 2), session('c-session-0003', 1)]);
  assert.equal(defaultSession(marked, { workers: [], ...records }, DEV), undefined, 'a new stage starts a new session');
  assert.equal(defaultSession(marked, { workers: [], ...records }, undefined), undefined, 'a stage the Comb lost: new');
  assert.equal(defaultSession(marked, { workers: [], ...records }, CONTINUE), 'c-session-0003');
  assert.equal(defaultSession(marked, { workers: [sessionWorker(1, 'c-session-0003')], ...records }, CONTINUE), 'b-session-0002', 'the newest one is open in a terminal: never offered');
  assert.equal(defaultSession(marked, { workers: [], ...work([]) }, CONTINUE), undefined, 'nothing continuable: new');
});

test('worktreeSessions is continuable minus the repo sessions, and empty while the worktree is gone from disk; defaultSession picks from it (#208)', () => {
  const CONTINUE: LegacyStage = { ...DEV, session: 'continue' };
  const session = (id: string, repo = false) => ({ id, startedAt: ago(HOUR), stages: ['dev'], agent: 'claude' as const, lastUsedAt: ago(HOUR), ...(repo ? { repo: true as const } : {}) });
  const mixed = task(1, CONTINUE);
  const state = { workers: [], ...work([session('a-session-0001'), session('b-session-0002', true)]) };
  assert.deepEqual(continuable(mixed, state).map((s) => s.id), ['a-session-0001', 'b-session-0002'], 'the sidebar offers both');
  assert.deepEqual(worktreeSessions(mixed, state).map((s) => s.id), ['a-session-0001'], 'a repo session never opens in a worktree');
  assert.deepEqual(worktreeSessions(mixed, { ...state, workers: [sessionWorker(1, 'a-session-0001')] }), [], 'held by a worker: continuable drops it first');
  const gone = { workers: [], ...work([session('a-session-0001'), session('b-session-0002', true)], 'item1', { worktreeGone: true }) };
  assert.deepEqual(worktreeSessions(mixed, gone), [], 'the worktree is gone from disk: nothing resumes in it');
  assert.equal(defaultSession(mixed, state, CONTINUE), 'a-session-0001', 'the newest one is a repo session: the popup never preselects it');
  assert.equal(defaultSession(mixed, gone, CONTINUE), undefined, 'new');
});

test('canMoveToStage and canRemoveCreated read every worker of the task (#164, #366, #708)', () => {
  const marked = task(1, DEV, { auto: false });
  const local = task(1, DEV, { created: true });
  const stageRun: Worker = { id: 's1', status: 'working', activityId: activityIdOf('item1') };
  assert.equal(canMoveToStage(marked, runsOf([])), true, 'a manual board task');
  assert.equal(canMoveToStage(local, runsOf([])), true, 'a stopped local task, not manual (#366)');
  assert.equal(canMoveToStage(task(1, DEV), runsOf([])), true, 'a stopped board task with auto on (#708)');
  assert.equal(canMoveToStage(task(1, DEV), runsOf([stageRun])), false, 'auto on: its stage run still holds it (#708)');
  assert.equal(canMoveToStage({ ...marked, missing: true }, runsOf([])), false, 'gone from the board');
  assert.equal(canMoveToStage({ ...local, leaving: true }, runsOf([])), false, 'its board action is in flight (#286)');
  assert.equal(canMoveToStage(local, runsOf([sessionWorker(1)])), true, 'a free session is the user\'s own: it holds nothing (#366)');
  assert.equal(canMoveToStage(local, runsFor([{ ...local, workerId: 's1' }], runsOf([stageRun]))), false, 'its stage run holds it');
  assert.equal(canMoveToStage(marked, runsOf([stageRun])), false, 'a stage run\'s worker counts even before the activity\'s workerId is read');
  assert.equal(canMoveToStage(marked, runsOf([sessionWorker(2)])), true, 'another task\'s session');
  assert.equal(canRemoveCreated(local, NO_RUNS), true);
  assert.equal(canRemoveCreated(local, runsOf([sessionWorker(1)])), false, 'a manual session holds it');
});

test('createdRemovalBlocker: running while the task holds a worker or any worker runs on it, deleting while a delete activity runs, nothing on a stopped local task; canRemoveCreated also needs a local task (#355)', () => {
  const created = task(1, DEV, { created: true });
  assert.equal(createdRemovalBlocker(created, NO_RUNS), undefined);
  assert.equal(createdRemovalBlocker(created, runsFor([{ ...created, workerId: 's1' }])), 'running', 'its stage run');
  assert.equal(createdRemovalBlocker(created, runsOf([sessionWorker(1)])), 'running', 'a Claude session on it (#164)');
  assert.equal(createdRemovalBlocker(created, runsOf([sessionWorker(2)])), undefined, 'another task\'s session');
  const deleting: Runs = { ...NO_RUNS, ...work([], 'item1', { deleting: true }) }; // the mark is the live activity's (#629)
  assert.equal(createdRemovalBlocker(created, deleting), 'deleting');
  assert.equal(createdRemovalBlocker(created, { ...NO_RUNS, ...work([], 'item1', { deleting: true, workerId: 's1' }) }), 'running', 'a run is named first, as removalBlocker does');
  assert.equal(createdRemovalBlocker(created, runsOf([], [{ terminalId: WORKER, activityId: activityIdOf('item1'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }])), undefined, 'a terminal holds nothing: deleting the card closes it (#573)');
  assert.equal(canRemoveCreated(created, NO_RUNS), true);
  assert.equal(canRemoveCreated(created, deleting), false);
  assert.equal(canRemoveCreated(task(1, DEV), NO_RUNS), false, 'a board task leaves with its board');
});

test('spawnedRun reads the ptyId off openSession\'s own effect, spawnSession or spawnTerminal, and answers undefined for neither (#249)', () => {
  const started = task(1, DEV);
  const worker: Worker = { id: 's1', status: 'working', activityId: activityIdOf('item1'), runId: WORKER, freeSession: true };
  const activity = TASK_ACTIVITIES[0];
  const session: Effect = { type: 'spawnSession', worker, activity, task: started, sessionId: 'sess-1', continues: false };
  assert.deepEqual(spawnedRun([session]), { ptyId: WORKER });
  const shell: Effect = { type: 'spawnTerminal', terminal: { terminalId: WORKER, activityId: activityIdOf('item1'), startedAt: ago(0), cwd: '/repo' }, activity, task: started };
  assert.deepEqual(spawnedRun([shell]), { ptyId: WORKER });
  assert.equal(spawnedRun([{ type: 'shutdown' }]), undefined, 'neither kind of run: nothing to attach');
  assert.equal(spawnedRun([{ ...session, worker: { ...worker, runId: undefined } }]), undefined, 'a worker with no ptyId is never openSession\'s own, but spawnedRun stays defensive');
});

test('spawnedRun of a workspace shell\'s spawnTerminal, which has no task, answers its worker id (#292)', () => {
  const shell: Effect = { type: 'spawnTerminal', terminal: { terminalId: WORKER, activityId: localActivityId('hive'), startedAt: ago(0), cwd: '/repo' }, activity: { id: localActivityId('hive'), kind: 'local', workspace: 'hive' } };
  assert.equal(LOCAL_SLUG, 'workspace');
  assert.deepEqual(spawnedRun([shell]), { ptyId: WORKER });
});

test('canCloseMissing: a stopped missing task with no worker of any kind, not being deleted and not open in a terminal; nothing else (#279)', () => {
  const gone = task(1, DEV, { missing: true });
  assert.equal(canCloseMissing(gone, runsOf([])), true);
  assert.equal(canCloseMissing(task(1, DEV), runsOf([])), false, 'still on the board');
  assert.equal(canCloseMissing(task(1, DEV, { orphan: true }), runsOf([])), false, 'kept: an orphan is no longer missing');
  assert.equal(canCloseMissing(task(1, DEV, { created: true }), runsOf([])), false, 'a local task never leaves a board (#132)');
  assert.equal(canCloseMissing(gone, { ...runsOf([]), ...work([], 'item1', { deleting: true }) }), false, 'git is removing its worktree (#182)');
  assert.equal(canCloseMissing(gone, runsFor([{ ...gone, workerId: 's1' }], runsOf([{ id: 's1', status: 'working', activityId: activityIdOf('item1') }]))), false, 'its automatic worker runs');
  assert.equal(canCloseMissing(gone, runsOf([sessionWorker(1)])), false, 'only a manual session runs on it (#164)');
  assert.equal(canCloseMissing(gone, runsOf([sessionWorker(2), { id: 's9', status: 'empty' }])), true, "another task's session and an empty worker do not hold it");
});

test('worktreeRows: no task with the slug is noTask; a stopped task in a delete activity stage that still has its worktree is cleanupFailed with its error; the same task while deleting, one waiting with no error, or a task in a prompt stage, is no orphan (#181)', () => {
  const at = (slug: string) => ({ slug, path: `/r/.hive/worktrees/${slug}`, branch: `hive/${slug}` });
  const slug = (n: number): string => `hive-${n}-task-${n}`;
  const refusal = "the branch 'hive/1' is not fully merged into HEAD";
  const refused = task(1, DONE);
  const deleting = task(2, DONE);
  const waiting = task(5, DONE); // in the delete activity stage, its `after` not yet due: git never refused
  const working = task(3, DEV);
  const local = task(4, DEV, { created: true, item: { ...item(4), id: 'HIVE-4' } });
  const live = pairs([[1, { worktree: '/wt/1', error: refusal }], [2, { worktree: '/wt/2', deleting: true, error: 'refused before' }], [5, { worktree: '/wt/5' }], [3, { worktree: '/wt/3' }], [4, { worktree: '/wt/4' }]]); // #629: the errors are the activities'
  const rows = worktreeRows([at('hive-9-gone'), at(slug(1)), at(slug(2)), at(slug(3)), at(slug(4)), at(slug(5))], { tasks: [refused, deleting, working, local, waiting], stages: STAGES, workers: [], workspaces: ['hive'], sourceWorkspaces: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, ...live }, 'hive');
  assert.deepEqual(rows[0], { ...at('hive-9-gone'), workspace: 'hive', orphan: 'noTask' });
  assert.deepEqual(rows[1], { ...at(slug(1)), workspace: 'hive', task: { id: 'item1', activityId: activityIdOf('item1'), title: '#1 Task 1', error: refusal, removable: true }, orphan: 'deleteActivityFailed' }); // #629: the route its removal posts to
  assert.deepEqual(rows.slice(2).map((r) => r.orphan), [undefined, undefined, undefined, undefined]);
  assert.equal('error' in rows[3].task!, false, 'no error: no key');
  assert.equal(rows[4].task?.title, 'HIVE-4 Task 4', 'the name a local task shows on the board');
});

test('worktreeRows: removable follows canDeleteActivity, so a running or session-held task offers no remove; a terminal does not hold one (#181, #283, #573)', () => {
  const listed = [1, 2, 3, 4].map((n) => ({ slug: `hive-${n}-task-${n}`, path: `/r/.hive/worktrees/hive-${n}-task-${n}`, branch: null }));
  const tasks = [task(1, DEV), task(2, DEV), task(3, DEV), task(4, DEV)];
  const live = pairs([1, 2, 3, 4].map((n) => [n, { worktree: `/wt/${n}`, ...(n === 2 ? { workerId: 's1' } : {}) }]));
  assert.deepEqual(worktreeRows(listed, { tasks, stages: STAGES, workers: [sessionWorker(4)], workspaces: ['hive'], sourceWorkspaces: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, ...live }, 'hive').map((r) => r.task?.removable), [true, false, true, false]);
});

test('worktreeRows tags each row with its workspace and gives a task only the worktree of the workspace its activity was born in (#179, #629)', () => {
  const owned = task(1, DEV, { workspace: 'site' });
  const row = { slug: 'hive-1-task-1', path: '/hive/.hive/worktrees/hive-1-task-1', branch: null };
  const state = { tasks: [owned], stages: STAGES, workers: [], terminals: [], workspaces: ['hive', 'site'], sourceWorkspaces: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, ...pairs([[1, { worktree: '/wt/1', workspace: 'site' }]]) };
  assert.deepEqual(worktreeRows([row], state, 'hive'), [{ ...row, workspace: 'hive', orphan: 'noTask' }], 'the same slug in another repo is not the task\'s');
  assert.equal(worktreeRows([row], state, 'site')[0].task?.id, 'item1');
});

test('resolveWorkspace: task.workspace first, then the source field\'s hint, the source\'s default, the Comb\'s only workspace, else none; an unknown task.workspace is none and never falls back, an unknown hint is skipped (#179)', () => {
  const TWO = ['hive', 'site'];
  const hinted = (hint?: string, extra: Partial<Task> = {}): Task => task(1, DEV, { item: { ...item(1), ...(hint === undefined ? {} : { workspaceHint: hint }) }, ...extra });
  assert.equal(resolveWorkspace(hinted('site', { workspace: 'hive' }), TWO, { board: 'site' }), 'hive', '1: the hand choice beats the hint and the default');
  assert.equal(resolveWorkspace(hinted('site'), TWO, { board: 'hive' }), 'site', '2: the hint beats the board default');
  assert.equal(resolveWorkspace(hinted('nope'), TWO, { board: 'hive' }), 'hive', 'an unknown hint is skipped: 3, the board default');
  assert.equal(resolveWorkspace(hinted(), ['hive']), 'hive', '4: the only workspace');
  assert.equal(resolveWorkspace(hinted(), TWO), undefined, '5: two workspaces, no rule');
  assert.equal(resolveWorkspace(hinted('site', { workspace: 'gone' }), TWO, { board: 'hive' }), undefined, 'a hand choice that no longer exists is not silently replaced');
  assert.equal(resolveWorkspace(hinted(undefined, { workspace: 'gone' }), ['hive']), undefined, 'not even by the only workspace');
  assert.equal(resolveWorkspace(hinted(), []), undefined);
  assert.equal(resolveWorkspace({ item: { ...item(1), source: 'notes' } }, TWO, { board: 'hive' }), undefined, 'another board\'s default does not apply (#180)');
  assert.equal(resolveWorkspace({ item: { ...item(1), source: 'toString' } }, TWO, {}), undefined, 'own keys only');
});

test('isPastFirstStage: the task\'s stage comes after the first stage its source enters through; its own first stage, another source\'s door and a local task are not (#32)', () => {
  const GOAL: LegacyStage = { name: 'goal', from: { board: ['Goals'] } };
  const stages = [GOAL, DEV, DONE];
  assert.equal(isPastFirstStage(stages, task(1, GOAL)), false);
  assert.equal(isPastFirstStage(stages, task(1, DEV)), true);
  assert.equal(isPastFirstStage([DEV, DONE], task(1, DEV)), false, 'its source\'s first door');
  assert.equal(isPastFirstStage([{ name: 'notes', from: { notes: ['X'] } }, DEV], task(1, DEV)), false, 'another source\'s door does not count');
  const { source: _source, ...local } = item(1);
  assert.equal(isPastFirstStage(stages, { ...task(1, DONE), item: local }), false, 'no source, no first stage');
});

test('resolveWorkspace with the task list: the parent\'s resolved workspace after the child\'s own hint and before its source\'s default, up the whole lineage; a cycle ends at the default; no list, today\'s answer (#32)', () => {
  const TWO = ['hive', 'site'];
  const DEFAULT = { board: 'hive' };
  const linked = (n: number, links: Pick<Item, 'parent' | 'children'>, extra: Partial<Task> = {}, hint?: string): Task =>
    task(n, DEV, { item: { ...item(n), ...links, ...(hint === undefined ? {} : { workspaceHint: hint }) }, ...extra });
  const root = linked(1, { children: ['item2'] }, { workspace: 'site' }); // hand-picked
  const child = linked(2, { parent: 'item1', children: ['item3'] });
  const grandchild = linked(3, { parent: 'item2' });
  const tree = [root, child, grandchild];
  assert.equal(resolveWorkspace(child, TWO, DEFAULT, tree), 'site', 'the parent beats the source default');
  assert.equal(resolveWorkspace(grandchild, TWO, DEFAULT, tree), 'site', 'the root\'s, through the parent\'s');
  const hinted = linked(2, { parent: 'item1' }, {}, 'hive');
  assert.equal(resolveWorkspace(hinted, TWO, {}, [root, hinted]), 'hive', 'the child\'s own rule hint wins');
  assert.equal(resolveWorkspace(child, TWO, DEFAULT), 'hive', 'without the list: today\'s answer');
  const a = linked(4, { parent: 'item5' });
  const b = linked(5, { parent: 'item4' });
  assert.equal(resolveWorkspace(a, TWO, DEFAULT, [a, b]), 'hive', 'a cycle answers the source default without looping');
  assert.equal(resolveWorkspace(linked(6, { parent: 'nope' }), TWO, DEFAULT, tree), 'hive', 'a parent that is no task: no inheritance');
  const gone = linked(7, { children: ['item8'] }, { workspace: 'gone' });
  const orphaned = linked(8, { parent: 'item7' });
  assert.equal(resolveWorkspace(orphaned, TWO, DEFAULT, [gone, orphaned]), 'hive', 'a parent that resolves to none: the child falls through');
});

test('canSetWorkspace: only a stopped task with no worktree, no session, nothing deleting; hasWorktree reads the worktree or any session of any record (#179, #629)', () => {
  const fresh = task(1, DEV);
  assert.deepEqual([canSetWorkspace(fresh, NO_WORK), hasWorktree(fresh, NO_WORK)], [true, false]);
  const listed = { id: 's-0001-abcd', startedAt: ago(HOUR), stages: ['dev'], agent: 'claude' as const, lastUsedAt: ago(HOUR) };
  const kept = { activities: [], activityRecords: [{ id: 'old', taskIds: ['item1'], sessions: [{ ...listed, repo: true as const }] }] };
  const cases: [string, Pick<State, 'activities' | 'activityRecords'>][] = [
    ['a worktree', work([], 'item1', { worktree: '/wt/1' })],
    ['a deleted activity\'s session', kept],
    ['a listed session', work([listed])],
    ['a running worker', work([], 'item1', { workerId: 's1' })], // #629: the run is the activity's
    ['deleting', work([], 'item1', { deleting: true })],
  ];
  for (const [why, state] of cases) assert.equal(canSetWorkspace(fresh, state), false, why);
  assert.equal(hasWorktree(fresh, kept), true);
});

test('candidates skip a task whose workspace resolves to none; one workspace resolves every task (#179)', () => {
  const ready = task(1, DEV, { enteredAt: ago(DAY) });
  const site = task(2, DEV, { enteredAt: ago(DAY), item: { ...item(2), workspaceHint: 'site' } });
  assert.deepEqual(cands([ready, site], STAGES, NOW, runsOf([]), { workspaces: ['hive', 'site'], sourceWorkspaces: {} }).map((c) => c.item.id), ['2']);
  assert.deepEqual(cands([ready, site], STAGES, NOW, runsOf([]), { workspaces: ['hive', 'site'], sourceWorkspaces: { board: 'hive' } }).map((c) => c.item.id), ['1', '2']);
  assert.deepEqual(cands([ready, site], STAGES, NOW, runsOf([]), ONE).map((c) => c.item.id), ['1', '2'], 'one workspace: an unknown hint is skipped, step 4 answers');
});

test('a task awaiting approval is no candidate, one with a queued handover is, and entering a stage drops both (#268, #134)', () => {
  const awaiting = task(1, DEV, { enteredAt: ago(DAY), approval: { since: ago(HOUR) } });
  const queued = task(2, DEV, { enteredAt: ago(DAY), handover: { prompt: 'split it' } });
  assert.deepEqual(cands([awaiting, queued], STAGES, NOW, runsOf([]), ONE).map((c) => c.item.id), ['2']);
  // #629: enter changes the task alone; settleEntries drops both from its activity (the orchestrator tests)
  const entered = enter(bareTask(awaiting), DONE);
  assert.deepEqual([entered.stage, entered.enteredAt === awaiting.enteredAt], ['done', false], 'a new stage and a new entry');
});

test('isGate: approval with no prompt and no action; entering a gate awaits approval from the moment the task enters, entering any other stage stamps nothing (#315)', () => {
  const GATE: LegacyStage = { name: 'gate', from: { board: ['Review'] }, approval: true };
  const REVIEWED: LegacyStage = { ...DEV, approval: true }; // a #268 stage: its run ends in approval, entering it does not
  const PARKED: LegacyStage = { name: 'parked', from: { board: ['Parked'] } };
  assert.deepEqual([GATE, REVIEWED, PARKED, { ...DONE, approval: true as const }, undefined].map((s) => isGate(s)), [true, false, false, false, false]);
  // #629: the approval a gate awaits is its activity's, set by settleEntries (the orchestrator tests); enter stamps only the entry
  const entered = enter(task(1, DEV), GATE);
  assert.deepEqual([entered.stage, 'approval' in entered], ['gate', false]);
  for (const stage of [REVIEWED, PARKED]) assert.equal(enter(task(1, GATE), stage).stage, stage.name);
});

test('candidates never takes a task in a manual gate; canRunIn is the stage\'s prompt (#134: a gate runs nothing)', () => {
  const GATE: LegacyStage = { name: 'gate', from: { board: ['Review'] }, approval: true };
  const bare = task(2, GATE, { enteredAt: ago(DAY) });
  assert.deepEqual(cands([bare], [DEV, GATE], NOW, runsOf([]), ONE), []);
  assert.equal(canRunIn({ prompt: '/x' }), true);
  assert.equal(canRunIn({}), false);
});

test('citedColumns reads only its source\'s entries of the maps, and entryStage enters through that source\'s from only (#180)', () => {
  const stages: LegacyStage[] = [
    { name: 'spec', from: { work: ['Todo'], notes: ['todo'] }, onFinish: { work: [move('Specced')] }, prompt: 'x' },
    { name: 'dev', from: { work: ['Specced'] }, onStart: { notes: [move('doing')] }, prompt: 'y' },
  ];
  assert.deepEqual(citedColumns(stages, [], 'work').map((c) => c.column), ['Todo', 'Specced']);
  assert.deepEqual(citedColumns(stages, [], 'notes'), [{ column: 'todo', by: 'spec.from' }, { column: 'doing', by: 'dev.onStart' }]);
  assert.deepEqual(citedColumns(stages, [], 'constructor'), [], 'own keys only');
  assert.equal(entryStage(stages, 'notes', 'todo')?.name, 'spec');
  assert.equal(entryStage(stages, 'notes', 'Specced'), undefined, 'another board\'s column is no door');
  assert.equal(entryStage(stages, undefined, 'Todo'), undefined, 'a local task has no board to enter from');
});

test('citedColumns cites every move of both lists, first citation wins; a list with no move cites nothing (#515)', () => {
  const stages: LegacyStage[] = [{ name: 'dev', from: { work: ['Ready'] }, onStart: { work: [move('A'), { type: 'close' }] } }];
  const transitions: Transition[] = [{ from: 'dev', to: 'end', when: 'done', sources: { work: [move('B'), move('A')] } }];
  assert.deepEqual(citedColumns(stages, transitions, 'work'), [{ column: 'Ready', by: 'dev.from' }, { column: 'A', by: 'dev.onStart' }, { column: 'B', by: 'dev → end.sources' }]);
  assert.deepEqual(citedColumns([{ name: 'x', from: {}, onStart: { work: [{ type: 'close' }] } }], [], 'work'), []);
});

test('mergeTasks for one source touches only that source\'s tasks: another source\'s and the local ones are neither refreshed nor marked missing, and a new item enters through its source\'s from only (#180)', () => {
  const stages: LegacyStage[] = [{ name: 'dev', from: { work: ['Ready'], notes: ['todo'] }, prompt: 'x' }];
  const on = (board: string, n: number): Item => ({ ...item(n), itemId: `${board}:${n}`, source: board });
  const workTask: Task = { item: on('work', 1), stage: 'dev', boardColumn: 'Ready', auto: true, enteredAt: ago(HOUR) };
  const notesTask: Task = { item: on('notes', 2), stage: 'dev', boardColumn: 'todo', auto: true, enteredAt: ago(HOUR) };
  const localTask: Task = { item: { ...item(3), itemId: 'local:3', source: undefined }, stage: 'dev', boardColumn: '', auto: true, created: true, enteredAt: ago(HOUR) };
  const listed: SourceItem[] = [{ item: on('work', 4), column: 'Ready' }, { item: on('work', 5), column: 'todo' }];
  const merged = mergeTasks([workTask, notesTask, localTask], stages, { source: 'work', items: listed }, ['work', 'notes'], ['work:4', 'work:5', 'notes:2'], NO_RUNS, AT_NOW);
  assert.equal(merged.find((c) => taskId(c) === 'work:1')?.missing, true, 'its own board no longer lists it');
  assert.deepEqual(merged.find((c) => taskId(c) === 'notes:2'), notesTask, 'another board\'s task is untouched');
  assert.deepEqual(merged.find((c) => taskId(c) === 'local:3'), localTask);
  assert.deepEqual(merged.filter((c) => c.item.source === 'work' && !c.missing).map(taskId), ['work:4'], '"todo" is a notes column: work:5 enters nowhere');
});

test('a task whose source is gone, or saved before sources had names, is marked missing by any poll; markRemoved spares local tasks and kept orphans (#180)', () => {
  const gone: Task = { item: { ...item(1), itemId: 'old:1', source: 'old' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const legacy: Task = { ...gone, item: { itemId: 'PVTI_2', id: '2', title: 'Task 2', body: '', url: '' } };
  const orphan: Task = { ...gone, item: { ...gone.item, itemId: 'old:3' }, orphan: true };
  const local: Task = { ...gone, item: { itemId: 'local:4', id: 'HIVE-4', title: 'Task 4', body: '', url: '' }, created: true };
  assert.deepEqual(markRemoved([gone, legacy, orphan, local], ['work']).map((c) => c.missing === true), [true, true, false, false]);
  assert.equal(mergeTasks([gone], STAGES, { source: 'board', items: [] }, ['board'], [], NO_RUNS, AT_NOW)[0].missing, true, 'another board\'s poll marks it too');
});

test('replaceSegment swaps one source\'s ids in place and appends a source seen for the first time (#180)', () => {
  const order = ['work:1', 'work:2', 'notes:7', 'work:3'];
  assert.deepEqual(replaceSegment(order, 'work', ['work:9', 'work:1']), ['work:9', 'work:1', 'notes:7']);
  assert.deepEqual(replaceSegment(order, 'notes', ['notes:8']), ['work:1', 'work:2', 'notes:8', 'work:3']);
  assert.deepEqual(replaceSegment(order, 'site', ['site:1']), [...order, 'site:1']);
  assert.deepEqual(replaceSegment(['a.b:1'], 'a', ['a:2']), ['a.b:1', 'a:2'], 'the name ends at the colon');
});

test('renameSource puts a renamed source\'s task under the new name, item.source and the item id prefix, and leaves another source\'s and a local task as they are; a swap rewrites each task once; renamedId swaps only its own prefix (#278)', () => {
  const on = (board: string, n: number): Task => ({ ...task(n, DEV), item: { ...item(n), itemId: `${board}:${n}`, source: board } });
  const work = on('work', 1);
  const notes = on('notes', 2);
  const local: Task = { ...task(3, DEV), item: { ...item(3), itemId: 'local:3', source: undefined }, created: true };
  const renames = { work: 'job' };
  assert.deepEqual(renameSource(work, renames), { ...work, item: { ...work.item, itemId: 'job:1', source: 'job' } }, 'stage, slug and the shown id stay');
  assert.equal(renameSource(notes, renames), notes, 'another board\'s task: the same object');
  assert.equal(renameSource(local, renames), local, 'a local task has no board');
  const swap = { work: 'notes', notes: 'work' };
  assert.deepEqual([work, notes].map((c) => renameSource(c, swap).item.itemId), ['notes:1', 'work:2'], 'one map, not two steps');
  assert.deepEqual(
    ['work:1', 'notes:2', 'local:3', 'PVTI_4', 'workshop:5', 'constructor:6'].map((id) => renamedId(id, swap)),
    ['notes:1', 'work:2', 'local:3', 'PVTI_4', 'workshop:5', 'constructor:6'],
    'the name ends at the colon; own keys only',
  );
});

test('slugOwner finds the other task of the same workspace whose live activity holds the slug through a worktree or a worker, and ignores another workspace, a task that never ran and the task itself (#180, #629)', () => {
  const twin = (board: string, extra: Partial<Task> = {}): Task => ({ ...task(12, DEV), item: { ...item(12), itemId: `${board}:12`, source: board }, ...extra });
  const mine = twin('notes', { workspace: 'hive' });
  // the activity of `board`'s twin, born in `workspace` under the twins' shared slug
  const state = (tasks: WithWork[], live: [string, Partial<Activity>][] = []) => {
    const { activities, activityRecords } = live.reduce((st, [board, f]) => withWork(st, `${board}:12`, { slug: 'hive-12-task-12', ...f }), initialState(0));
    return { tasks, activities, activityRecords, workspaces: ['hive', 'site'], sourceWorkspaces: {} }; // a kept record's task resolves its workspace (#629)
  };
  assert.equal(slugOwner(state([twin('work', { workspace: 'hive' }), mine], [['work', { worktree: '/w', workspace: 'hive' }]]), mine, 'hive')?.item.itemId, 'work:12');
  assert.equal(slugOwner(state([twin('work', { workspace: 'hive' }), mine], [['work', { workerId: 's1', workspace: 'hive' }]]), mine, 'hive')?.item.itemId, 'work:12', 'a running task owns it too');
  assert.equal(slugOwner(state([twin('work', { workspace: 'site' }), mine], [['work', { worktree: '/w', workspace: 'site' }]]), mine, 'hive'), undefined, 'another workspace has its own repo');
  assert.equal(slugOwner(state([twin('work', { workspace: 'hive' }), mine]), mine, 'hive'), undefined, 'a task that never ran owns nothing');
  assert.equal(slugOwner(state([mine], [['notes', { worktree: '/w', workspace: 'hive' }]]), mine, 'hive'), undefined, 'never itself');
  assert.equal(slugTakenMessage('hive-12-task-12', twin('work')), 'slug hive-12-task-12 is used by 12');
});

test('runTime: the wall clock since the start and the waiting, the finished waits plus one still open, up to the end; an unreadable or future date counts nothing. closeWait keeps the waits once the open one ends (#248)', () => {
  const MINUTE = 60_000;
  const waiting: Worker = { id: 's1', status: 'waiting', startedAt: ago(HOUR), waitedMs: 5 * MINUTE, waitingSince: ago(10 * MINUTE) };
  assert.deepEqual(runTime(waiting, NOW), { ms: HOUR, waitingMs: 15 * MINUTE });
  assert.deepEqual(runTime({ id: 's2', status: 'working', startedAt: ago(HOUR) }, NOW), { ms: HOUR, waitingMs: 0 });
  assert.deepEqual(runTime({ id: 's3', status: 'waiting', startedAt: 'nope', waitingSince: ago(-HOUR) }, NOW), { ms: 0, waitingMs: 0 });
  assert.deepEqual(runTime({ id: 's4', status: 'empty' }, NOW), { ms: 0, waitingMs: 0 });
  assert.deepEqual(closeWait(waiting, NOW), { waitedMs: 15 * MINUTE });
  assert.deepEqual(closeWait({ id: 's2', status: 'working', waitedMs: 5 * MINUTE }, NOW), {}, 'not waiting: waitedMs stays as it is');
});

test('taskTotals: zeros for a task with nothing recorded; the stored usage plus, for every worker running on the task, its time and its waiting so far; tokens as stored (#248)', () => {
  const MINUTE = 60_000;
  assert.deepEqual(taskTotals({ workers: [], ...NO_WORK }, task(1, DEV), NOW), { tokens: 0, ms: 0, waitingMs: 0, parts: [] });
  // #629: the usage is the records', summed: a deleted activity's and the live one's
  const usage = (tokens: number, ms: number, waitingMs: number): ActivityRecord => ({ id: `r${tokens}`, taskIds: ['item1'], sessions: [], usage: { tokens, ms, waitingMs, parts: [{ tokens, ms, waitingMs }] } });
  const activityRecords = [usage(1000, HOUR / 2, 0), usage(2000, HOUR / 2, MINUTE)];
  const workers: Worker[] = [
    { id: 's1', status: 'waiting', activityId: activityIdOf('item1'), startedAt: ago(HOUR), waitedMs: MINUTE, waitingSince: ago(2 * MINUTE) },
    { id: 's2', status: 'working', activityId: activityIdOf('item2'), startedAt: ago(DAY) }, // another task's
    { id: 's3', status: 'empty' },
  ];
  assert.deepEqual(taskTotals({ workers, activities: TASK_WORK.activities, activityRecords: [...activityRecords, ...TASK_WORK.activityRecords] }, task(1, DEV), NOW), { tokens: 3000, ms: 2 * HOUR, waitingMs: 4 * MINUTE, parts: [{ tokens: 3000, ms: 2 * HOUR, waitingMs: 4 * MINUTE }] });
});

test('a stopped task is neither a candidate nor a due delete activity; entering any stage drops the mark (#283)', () => {
  const stopped = task(1, DEV, { enteredAt: ago(DAY), stopped: true });
  assert.deepEqual(cands([stopped], STAGES, NOW, runsOf([]), ONE), []);
  assert.deepEqual(dues([task(2, AT_ONCE, { stopped: true })], STAGES, NOW, NO_RUNS, DELETE_ACTIVITY_DEFAULTS), []);
  assert.equal(enter(bareTask(stopped), DONE).stage, 'done', 'the mark is the activity\'s, which settleEntries drops (#629)');
});

test('a leaving task (#286) is not idle: no candidate, no due delete activity; a poll that no longer lists it leaves it unmarked', () => {
  const ready = task(1, DEV, { enteredAt: ago(DAY) });
  assert.deepEqual(cands([ready], STAGES, NOW, runsOf([]), ONE).map(taskId), ['item1'], 'the same task, not leaving, is a candidate');
  assert.deepEqual(cands([{ ...ready, leaving: true }], STAGES, NOW, runsOf([]), ONE), []);
  const cleanable = task(2, AT_ONCE);
  const held: Runs = { ...NO_RUNS, ...pairs([[2, { worktree: '/wt/hive-2-task-2' }]]) };
  assert.equal(dues([cleanable], STAGES, NOW, held, DELETE_ACTIVITY_DEFAULTS).length, 1);
  assert.deepEqual(dues([{ ...cleanable, leaving: true }], STAGES, NOW, held, DELETE_ACTIVITY_DEFAULTS), []);
  assert.equal(merge([{ ...ready, leaving: true }], STAGES, [])[0].missing, undefined);
  assert.equal(merge([ready], STAGES, [])[0].missing, true, 'a task that is not leaving is marked');
});

test('isLive: a task is live while a non-empty worker or a terminal names it, a stage run, a free session or a terminal alike, or while it holds workerId; an empty worker and another task\'s runs do not count (#356)', () => {
  const stage: Worker = { id: 's1', status: 'working', activityId: activityIdOf('item1'), runId: WORKER };
  assert.equal(isLive(task(1, DEV), runsOf([stage])), true, 'the stage run');
  assert.equal(isLive(task(1, DEV), runsOf([sessionWorker(1)])), true, 'a free session');
  assert.equal(isLive(task(1, DEV), runsOf([], [shellOn(1)])), true, 'a terminal');
  assert.equal(isLive(task(1, DEV), runsOf([{ id: 's1', status: 'empty', activityId: activityIdOf('item1') }])), false, 'an empty worker');
  assert.equal(isLive(task(1, DEV), runsOf([sessionWorker(2)], [shellOn(2)])), false, 'another task\'s runs');
  assert.equal(isLive(task(1, DEV), runsFor([task(1, DEV, { workerId: 's1' })])), true, 'the activity\'s workerId counts on its own, as removalBlocker reads it');
});

test('mergeTasks anchors a task whose only run is a free session or a terminal, as it anchors a stage run; once the run is gone it follows the source again (#356)', () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const board = (n: number): SourceItem => ({ item: item(n), column: 'Ready' });
  const tasks = [task(3, DEV), task(4, DEV), task(1, DEV), task(2, DEV)]; // 3 has a terminal, 4 a session: each went on top as it opened
  const listed = [board(1), board(2), board(3), board(4)];
  assert.deepEqual(ids(merge(tasks, STAGES, listed, runsOf([sessionWorker(4)], [shellOn(3)]))), ['3', '4', '1', '2'], 'both hold positions 0 and 1');
  assert.deepEqual(ids(merge(tasks, STAGES, listed, runsOf([], [shellOn(3)]))), ['3', '1', '2', '4'], 'the session ended: 4 follows the board again');
  assert.deepEqual(ids(merge(tasks, STAGES, listed)), ['1', '2', '3', '4'], 'no run left: the board order');
});

test('runningFirst, resetOrder and differsFromSource count a task with only a session or only a terminal as running (#356)', () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const runs: Runs = runsOf([sessionWorker(4)], [shellOn(3)]);
  const order = ['item1', 'item2', 'item3', 'item4'];
  const tasks = [task(3, DEV), task(1, DEV), task(2, DEV), task(4, DEV)]; // 3's terminal put it on top; 4 just opened a session at the bottom
  const opened = runningFirst(tasks, 'item4', runs);
  assert.deepEqual(ids(opened), ['3', '4', '1', '2'], 'right below the terminal task, above the stopped ones');
  assert.equal(runningFirst(opened, 'item4', runs), opened, 'already there: the same list');
  assert.equal(differsFromSource(opened, 'dev', order, runs), false, 'live tasks on top, stopped ones in board order: no reset to offer');
  assert.equal(differsFromSource(opened, 'dev', order, NO_RUNS), true, 'without the runs, 3 and 4 read as stopped tasks out of board order');
  const dragged = [task(1, DEV), task(2, DEV), task(3, DEV), task(4, DEV)]; // the live tasks dragged below the stopped ones
  assert.equal(differsFromSource(dragged, 'dev', order, runs), true, 'a live task below a stopped one');
  assert.deepEqual(ids(resetOrder(dragged, 'dev', order, runs)), ['3', '4', '1', '2'], 'the reset puts the live tasks back on top, in their order');
});

test('sourceOf answers the item\'s source, and hive for a task created in the Hive; isReservedSource holds local and hive only (#665)', () => {
  const item: Item = { itemId: 'board:1', id: '1', title: 't', body: '', url: '', source: 'board' };
  const { source: _source, ...sourceless } = item;
  assert.equal(sourceOf({ item }), 'board');
  assert.equal(sourceOf({ item: { ...sourceless, itemId: 'local:1', id: 'HIVE-1' } }), HIVE_SOURCE);
  assert.equal(HIVE_SOURCE, 'hive');
  assert.deepEqual(['local', 'hive', 'board'].map(isReservedSource), [true, true, false]);
});

test('isStarted: a task with a live activity is started, whatever made it (a run, a free session, a first open); one without is new (#727)', () => {
  const t1 = bareTask(task(1, DEV));
  assert.equal(isStarted({ activities: [], activityRecords: [] }, t1), false);
  assert.equal(isStarted(withWork(initialState(0), 'item1'), t1), true);
  assert.equal(isStarted(withKeptRecord(initialState(0), 'item1', 'old'), t1), false, 'a deleted activity\'s record alone: new again');
});

test('worktreeRows: a worktree whose kept activity has no task in the flow is kept, not noTask; another workspace\'s slug is still noTask (#861)', () => {
  const row = { slug: 'hive-9-gone', path: '/r/.hive/worktrees/hive-9-gone', branch: 'hive/9-gone' };
  const kept = withWork({ ...initialState(0), workspaces: ['hive', 'site'] }, 'board:item9', { slug: 'hive-9-gone', worktree: row.path });
  const state = { ...kept, stages: STAGES, deleteActivity: DELETE_ACTIVITY_DEFAULTS };
  assert.deepEqual(worktreeRows([row], state, 'hive'), [{ ...row, workspace: 'hive', orphan: 'kept' }]);
  assert.equal(worktreeRows([row], state, 'site')[0].orphan, 'noTask');
});
