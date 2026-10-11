import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, reduce } from '../src/orchestrator.js';
import { loadState, saveState } from '../src/state-store.js';
import { activityOf, localActivityId, prsOf, recordOf, recordsOf, resultOf } from '../src/activities.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { sessionsOf } from '../src/tasks.js';
import { APPROVAL_MINUTES_DEFAULT, MAX_CONCURRENT_DEFAULT, MAX_CONCURRENT_MAX, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, type SleptRun, type Task, type TaskPr, type DisabledRule, type Worker } from '../src/types.js';
import { savedActivityId, savedTasks, withKeptRecord, withLocal, withWork, } from './fixtures/work.js';
import { tempDir } from './temp-dir.js';
import { loadRecord, savedPrs } from '../src/state-guards.js';

const uuid = (n: number): string => `3f2504e0-4f89-11d3-9a0c-0305e82c330${n}`; // the shape randomUUID gives a worker; anything else empties the worker
// A file written before #629: no activities, so loadState migrates the tasks' own work into records
const pre629 = <S extends object>(state: S): Omit<S, 'activities' | 'activityRecords'> => {
  const { activities: _activities, activityRecords: _records, ...rest } = state as S & { activities?: unknown; activityRecords?: unknown };
  return rest;
};
// A record of task I1 as a file holds it (#629): what the record guards read
const savedRecord = (id: string, fields: Record<string, unknown>) => ({ id, taskIds: ['I1'], sessions: [], ...fields });
// The activity a saved run or terminal works in, with its record (#629): loadState keeps an occupied worker and a terminal only on a loaded one
const OWNER = savedActivityId(9);
const owned = { activities: [{ id: OWNER, kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' }], activityRecords: [savedRecord(OWNER, {})] };

test('loadState returns initialState when nothing is saved', async (t) => {
  const dir = await tempDir(t, '');
  const state = await loadState(dir);
  assert.equal(state.workers.length, MAX_CONCURRENT_DEFAULT);
  assert.deepEqual([state.tasks, state.stages], [[], []]);
});

test('loadState reads the saved maxConcurrent, and a file without one gets MAX_CONCURRENT_DEFAULT free workers (#727)', async (t) => {
  const dir = await tempDir(t, '');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ signal: 'red', tasks: [] }));
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.maxConcurrent, loaded.workers.length, loaded.signal], [MAX_CONCURRENT_DEFAULT, MAX_CONCURRENT_DEFAULT, 'red']);
  await saveState(dir, initialState(5));
  assert.equal((await loadState(dir)).maxConcurrent, 5);
});

test('loadState clamps a saved maxConcurrent above MAX_CONCURRENT_MAX, so one bad value cannot crash every boot (#727)', async (t) => {
  const dir = await tempDir(t, '');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ maxConcurrent: 1e9, tasks: [] }));
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.maxConcurrent, loaded.workers.length], [MAX_CONCURRENT_MAX, MAX_CONCURRENT_MAX]);
});

test('saveState then loadState round-trips and leaves no tmp file', async (t) => {
  const dir = await tempDir(t, '');
  const state = { ...initialState(1), error: 'x' };
  await saveState(dir, state);
  assert.deepEqual(await loadState(dir), state);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('a hive task\'s blockers and its blockedBy round-trip through saveState and loadState (#56)', async (t) => {
  const dir = await tempDir(t, '');
  const blockers = { blockedBy: [{ id: 'HIVE-2', title: 'Blocker', state: 'open' as const }], blocking: [{ id: 'HIVE-3', title: 'Next', state: 'closed' as const }] };
  const task: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '', blockers, blockedBy: ['HIVE-2'] }, stage: 'dev', boardColumn: '', created: true, auto: false };
  await saveState(dir, { ...initialState(1), tasks: [task] });
  assert.deepEqual((await loadState(dir)).tasks[0].item, task.item);
});

test('loadState ignores a corrupt file and falls back to initialState', async (t) => {
  const dir = await tempDir(t, '');
  await writeFile(join(dir, 'state.json'), '{not json');
  const state = await loadState(dir);
  assert.equal(state.workers.length, MAX_CONCURRENT_DEFAULT);
});

test('loadState reads a missing or unknown signal as green and keeps a valid one', async (t) => {
  const dir = await tempDir(t, '');
  const legacy = { maxConcurrent: 1, workers: [], queue: [] }; // written before the signal existed
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  assert.equal((await loadState(dir)).signal, 'green');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, signal: 'red' }));
  assert.equal((await loadState(dir)).signal, 'red');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, signal: 'blue' }));
  assert.equal((await loadState(dir)).signal, 'green');
});

test('loadState drops a saved auto: the Hive\'s auto is gone (#638, #727)', async (t) => {
  const dir = await tempDir(t, '');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ maxConcurrent: 1, workers: [], auto: false }));
  assert.equal('auto' in (await loadState(dir)), false);
});

test('loadState reads missing usage and budget as empty, keeps valid samples and drops malformed ones', async (t) => {
  const dir = await tempDir(t, '');
  const legacy = { signal: 'green', auto: true, maxConcurrent: 1, workers: [], queue: [] }; // written before the budget existed
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.usage, []);
  assert.deepEqual(loaded.budget, {});
  assert.deepEqual(loaded.usageRules, []);
  assert.deepEqual(loaded.terminals, [], 'a file from before #283: no terminal');
  const valid = { at: '2026-09-16T12:00:00.000Z', tokens: 1200 };
  const usage = [valid, { at: 5, tokens: 1 }, { at: '2026-09-16T12:00:00.000Z' }, { at: 'x', tokens: 'many' }, null, 7];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage, budget: { maxTokensPerHour: 10 } }));
  const kept = await loadState(dir);
  assert.deepEqual(kept.usage, [valid]);
  assert.deepEqual(kept.budget, { maxTokensPerHour: 10 });
  const rule = { source: 'hour', percent: 80, signal: 'yellow' };
  const staged = { source: 'week', percent: 70, maxWorkers: 1, stage: 'build' }; // #475
  const usageRules = [
    rule, staged, { ...staged, stage: 3 }, { percent: 80, signal: 'yellow' }, { source: 'x', percent: 80, signal: 'yellow' }, { source: 'hour', percent: 'x', signal: 'red' },
    { source: 'hour', percent: 50 }, { source: 'hour', percent: 50, signal: 'blue' }, { source: 'hour', percent: 50, signal: 'green' }, null, 7,
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usageRules }));
  assert.deepEqual((await loadState(dir)).usageRules, [rule, staged], 'malformed rules are dropped: no source, unknown source, no consequence, green, a stage that is not a string');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage: 'nope' }));
  assert.deepEqual((await loadState(dir)).usage, []);
});

test('loadState keeps a valid rateLimits reading', async (t) => {
  const dir = await tempDir(t, '');
  const rateLimits = {
    at: '2026-09-16T12:00:00.000Z',
    windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' }, seven_day_fable: { usedPercent: 7, resetsAt: '2026-09-20T00:00:00.000Z' } },
  };
  await saveState(dir, { ...initialState(1), rateLimits });
  assert.deepEqual((await loadState(dir)).rateLimits, rateLimits);
});

test('loadState drops a rateLimits with the wrong shape and leaves the key absent', async (t) => {
  const dir = await tempDir(t, '');
  const base = initialState(1);
  const at = '2026-09-16T12:00:00.000Z';
  const bad: unknown[] = [
    5, 'x', null, [], { at: 5, windows: {} }, { at }, { at, windows: [] }, { at, windows: 'x' },
    { at, windows: { five_hour: { usedPercent: 'many', resetsAt: at } } },
    { at, windows: { five_hour: { usedPercent: 1, resetsAt: 7 } } },
    { at, windows: { five_hour: null } },
  ];
  for (const rateLimits of bad) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...base, rateLimits }));
    const loaded = await loadState(dir);
    assert.equal('rateLimits' in loaded, false, JSON.stringify(rateLimits));
  }
});

test('loadState keeps each source\'s status in the shape the Hive writes, drops a field of any other shape, and forgets the pre-#180 lastPolledAt, boardQuota and boardProject', async (t) => {
  const dir = await tempDir(t, '');
  const quota = { limit: 5000, remaining: 320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
  const work = { polledAt: '2026-09-16T12:00:00.000Z', quota, error: 'boom' };
  await saveState(dir, { ...initialState(1), syncs: { work } });
  assert.deepEqual((await loadState(dir)).syncs, { work });
  const old = { ...initialState(1), syncs: { work: { polledAt: 7, quota: { ...quota, remaining: -1 }, error: null }, notes: 'x' }, lastPolledAt: 'x', boardQuota: quota, boardProject: 'hive' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(old));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.syncs, { work: {}, notes: {} });
  assert.deepEqual(['lastPolledAt' in loaded, 'boardQuota' in loaded, 'boardProject' in loaded], [false, false, false]);
});

test('loadState maps the legacy Portuguese statuses, empties a worker with an unknown status and drops a lastEvent that is not a WorkerEvent', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const workers = [
    { id: 'a', status: 'trabalhando', runId: uuid(1), task: item, slug: 'hive-1-t', lastEvent: 'iniciando' },
    { id: 'b', status: 'esperando_voce', runId: uuid(2), task: item, lastEvent: 'aguardando: permission_prompt' },
    { id: 'c', status: 'aguardando_review', runId: uuid(3), task: item, prUrl: 'https://github.com/o/r/pull/1' },
    { id: 'd', status: 'vazio' },
    { id: 'e', status: 'busy', runId: uuid(5), task: item },
    { id: 'f', status: 'working', runId: uuid(6), task: item, lastEvent: { kind: 'tool', detail: 'Bash: ls' } },
    { id: 'g', status: 'review', runId: uuid(7), task: item, lastEvent: { kind: 'nope' } },
    { id: 'h', status: 'constructor' },
  ].map((w) => ({ ...w, activityId: OWNER }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), ...owned, workers }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.workers.map((s) => s.status), ['working', 'waiting', 'review', 'empty', 'empty', 'working', 'review', 'empty']);
  assert.deepEqual(loaded.workers[0], { id: 'a', status: 'working', runId: uuid(1), activityId: OWNER }, 'the sentence is dropped, the rest is kept');
  assert.equal('lastEvent' in loaded.workers[1], false);
  assert.deepEqual(loaded.workers[4], { id: 'e', status: 'empty' }, 'unknown status: only the id survives');
  assert.deepEqual(loaded.workers[5].lastEvent, { kind: 'tool', detail: 'Bash: ls' }, 'a WorkerEvent object is kept as is');
  assert.equal('lastEvent' in loaded.workers[6], false, 'an unknown kind is dropped');
  assert.deepEqual(loaded.workers[7], { id: 'h', status: 'empty' }, 'an inherited property name is not a legacy status');
});

test('loadState drops a legacy queue and the task fields of workers, keeps activityId, keeps well-formed tasks and defaults columns to []', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const saved = { ...task, sessionId: 'abcdefgh-1' };
  const legacy = {
    signal: 'green', auto: true, maxConcurrent: 1, queue: [item], ...owned, // #629: written after the records, so the worker's pointer is read as is
    workers: [{ id: 'a', status: 'working', runId: uuid(1), task: item, slug: 'hive-1-t', prUrl: 'x', paused: true, activityId: OWNER, tokens: 5 }],
    tasks: [
      saved, { item, stage: 7 }, null, { stage: 'dev', boardColumn: 'Ready', auto: true, slug: 's' },
      { ...saved, slug: '../../evil' }, { ...saved, slug: 'hive-1-x|.' }, { ...saved, sessionId: 'a b' }, // a slug and a session id are the activity's (#629)
    ],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  const loaded = await loadState(dir);
  assert.equal('queue' in loaded, false);
  assert.deepEqual(loaded.workers[0], { id: 'a', status: 'working', runId: uuid(1), activityId: OWNER, tokens: 5 });
  assert.deepEqual(loaded.tasks, [task, task, task, task], 'a slug or a session id a task still carries is dropped, the task kept: loadActivity checks the activity\'s (#629)');
  assert.deepEqual(loaded.stages, []);
});

test('loadState drops a non-string enteredAt from a task (a null enteredAt would never be restamped and the task would stall), and a worktree or branch whatever it is: the activity\'s (#629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'done', boardColumn: 'Done', auto: true };
  const strings = { enteredAt: '2026-09-16T12:00:00.000Z', worktree: '/repo/.claude/worktrees/hive-1-t', branch: 'worktree-hive-1-t' };
  const tasks = [{ ...task, ...strings }, { ...task, enteredAt: null, worktree: 7, branch: ['x'] }, { ...task, pinned: true }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks }));
  assert.deepEqual((await loadState(dir)).tasks, [{ ...task, enteredAt: strings.enteredAt }, task, { ...task, pinned: true }], 'pinned survives a restart: normalizeTask passes unknown fields through (#123)');
});

test('loadState empties a worker whose runId randomUUID could not have produced: that id becomes the pkill pattern boot kills strays with', async (t) => {
  const dir = await tempDir(t, '');
  const workers = [
    { id: 'a', status: 'working', runId: uuid(1) },
    { id: 'b', status: 'working', runId: '.' }, // a pkill pattern that matches every process the user owns
    { id: 'c', status: 'working', runId: '^/' },
    { id: 'd', status: 'working', runId: 7 }, // execFile would throw a TypeError and boot would reject
    { id: 'e', status: 'working', runId: null },
    { id: 'f', status: 'working', runId: 'claude-code' }, // a plain id pkill would match in every worker's command line
    { id: 'g', status: 'working' }, // occupied with no worker id at all: nothing the Hive can kill either
  ].map((w) => ({ ...w, activityId: OWNER }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), ...owned, workers }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.workers[0], { id: 'a', status: 'working', runId: uuid(1), activityId: OWNER }, 'a real worker id survives, the worker stays working');
  assert.deepEqual(loaded.workers.slice(1), ['b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, status: 'empty' })),
    'the worker is emptied, not just stripped: a working worker boot cannot kill would stay working forever');
});

test('loadState drops an unusable runId from an empty worker too: killStrays reads the field off every worker, whatever its status', async (t) => {
  const dir = await tempDir(t, '');
  const workers = [{ id: 'a', status: 'empty', runId: '.' }, { id: 'b', status: 'empty', runId: uuid(2) }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), workers }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.workers[0], { id: 'a', status: 'empty' }, 'an empty worker is not a reason to trust the field: it still reaches pkill');
  assert.deepEqual(loaded.workers[1], { id: 'b', status: 'empty', runId: uuid(2) });
});

test('boot clears the workerId of an activity whose worker loadState emptied over an unusable worker id, so the task is dispatched again instead of stalling (#629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const tasks = [{ item, stage: 'dev', boardColumn: 'Ready', auto: true }];
  // #629: the run is the activity's
  const activities = [{ id: uuid(1), kind: 'task', workspace: 'hive', slug: 'hive-1-t', workerId: 'a' }];
  const workers = [{ id: 'a', status: 'working', runId: '.', activityId: uuid(1) }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), workers, tasks, activities, activityRecords: [savedRecord(uuid(1), {})] }));
  const { state } = reduce(await loadState(dir), { type: 'boot' });
  assert.deepEqual(state.workers, [{ id: 'a', status: 'empty' }]);
  assert.equal(activityOf(state, 'I1')?.workerId, undefined, 'the task is free to be dispatched again');
});

test('loadState loads a file from before #570 without an error: its slots, interactive runs and shells are not read, its tasks stay without slotId, and the default cap comes back as free workers (#570, #727)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready' };
  const { workers: _workers, terminals: _terminals, maxConcurrent: _cap, ...rest } = initialState(3); // no cap in the file either: the default comes back
  const old = {
    ...rest,
    slots: [{ id: 'a', status: 'working', workerId: uuid(1), taskId: 'I1' }, { id: 'b', status: 'working', workerId: uuid(2), taskId: 'I1', interactive: true }],
    shells: [{ workerId: uuid(3), taskId: 'I1', startedAt: '2026-09-25T10:00:00.000Z' }],
    tasks: [{ ...task, slotId: 'a' }],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(old));
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.maxConcurrent, loaded.workers.map((w) => w.status)], [MAX_CONCURRENT_DEFAULT, ['empty', 'empty']], 'no run survives: the default cap, every worker free');
  assert.deepEqual(loaded.terminals, []);
  assert.deepEqual(loaded.tasks, [{ ...task, auto: true }], 'the task stays, auto since it carries no manual (#573); its old slotId is dropped');
  assert.deepEqual(['slots' in loaded, 'shells' in loaded], [false, false], 'the retired keys are not carried into the state');
});

test('loadState reads sourceOrder back and defaults it to [] when absent or not an array of strings', async (t) => {
  const dir = await tempDir(t, '');
  const state = { ...initialState(1), sourceOrder: ['I2', 'I1'] };
  await saveState(dir, state);
  assert.deepEqual((await loadState(dir)).sourceOrder, ['I2', 'I1']);
  const { sourceOrder: _absent, ...legacy } = state; // written before the order existed: the first poll fills it
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  assert.deepEqual((await loadState(dir)).sourceOrder, []);
  for (const sourceOrder of ['I1', 7, null, { I1: 0 }, ['I1', 7]]) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, sourceOrder }));
    assert.deepEqual((await loadState(dir)).sourceOrder, [], JSON.stringify(sourceOrder));
  }
});

test('loadState keeps a well-formed base on an activity and drops one whose ref starts with -, whose tellWorker is not a boolean, or that is not an object (#131, #629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const live = (n: number) => ({ id: uuid(n), kind: 'task', workspace: 'hive', slug: 'hive-1-t' }); // #629: the base is the activity's
  const kept = { ref: 'origin/feature-x', tellWorker: true };
  const bases: unknown[] = [kept, { ref: '--upload-pack=x', tellWorker: false }, { ref: 'main^{/push it}', tellWorker: true }, { ref: 'feature-x', tellWorker: 'yes' }, 'feature-x', null];
  const activities = bases.map((base, i) => ({ ...live(i + 1), base }));
  const activityRecords = bases.map((_, i) => savedRecord(uuid(i + 1), {}));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities, activityRecords }));
  assert.deepEqual((await loadState(dir)).activities, bases.map((_, i) => (i === 0 ? { ...live(1), base: kept } : live(i + 1))),
    'the ref reaches git\'s argv at the next spawn: anything the popup could not have written reads as the default base');
});

test('loadState reads a missing or bad localCount as 0, keeps a valid one, and reads a created mark of before #573 (saved as local) only as true', async (t) => {
  const dir = await tempDir(t, '');
  const legacy = { signal: 'green', auto: true, maxConcurrent: 1, workers: [] }; // written before #132
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  assert.equal((await loadState(dir)).localCount, 0);
  for (const bad of [-1, 1.5, '3', null]) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, localCount: bad }));
    assert.equal((await loadState(dir)).localCount, 0, JSON.stringify(bad));
  }
  const made = (n: number, mark: unknown) => ({ // no auto: saved before #573, when local meant created
    item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: 'x', body: '', url: '' }, stage: 'dev', boardColumn: '', local: mark,
  });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, localCount: 4, tasks: [made(3, true), made(4, 'yes')] }));
  const loaded = await loadState(dir);
  assert.equal(loaded.localCount, 4);
  assert.deepEqual(loaded.tasks.map((c) => c.created), [true, undefined]);
  assert.equal('created' in loaded.tasks[1], false, 'anything but true drops the key: it decides whether a task is ever written to a board');
  assert.equal(loaded.tasks.some((c) => 'local' in c), false, 'a local of before #573 is the created mark, never the checkout');
});

test('loadState reads a saved manual true as auto false, keeps Worker.freeSession only as true and empties a worker saved as manual before #283; and only the well-formed entries of sessions: an id that is not the uuid shape Claude Code writes (it reaches --resume, and a leading `-` like `--settings` would reach argv as an option) or a field not in its written shape drops the entry (#164, #573)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready' }; // no auto: a task saved before #573
  const good = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['spec', 'dev'], lastUsedAt: '2026-09-22T11:00:00.000Z' };
  const tasks = [{ ...task, manual: true, viewing: true }, { ...task, manual: 'yes' }];
  // #629: the sessions are the record's, read through the same guard
  const activityRecords = [
    savedRecord(OWNER, { sessions: [good, { ...good, id: 'a b' }, { ...good, id: '--settings' }, { ...good, startedAt: 7 }, { ...good, stages: ['dev', 7] }, { ...good, lastUsedAt: 7 }, 'x', { ...good, extra: 1 }] }),
    savedRecord('r2', { sessions: 'x' }),
  ];
  const workers = [{ id: 'a', status: 'working', runId: uuid(1), activityId: OWNER, freeSession: true }, { id: 'b', status: 'working', runId: uuid(2), activityId: OWNER, freeSession: 'yes' }, { id: 'c', status: 'working', runId: uuid(3), activityId: OWNER, manual: true }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), workers, tasks, activities: owned.activities, activityRecords }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.tasks, [{ ...task, auto: false }, { ...task, auto: true }]);
  assert.deepEqual(loaded.activityRecords.map((r) => r.sessions), [[good, good], []], 'an unknown extra key is dropped, the entry kept');
  assert.deepEqual(loaded.workers.map((s) => [s.status, s.freeSession]), [['working', true], ['working', undefined], ['empty', undefined]]);
  assert.equal('freeSession' in loaded.workers[1], false);
  assert.equal('viewing' in loaded.tasks[0], false, 'the viewer is gone (#283)');
});

test('loadState reads a task saved before auto by its inverse: manual true as auto false, no manual as auto true; a saved auto wins, and manual is never kept (#573)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready' }; // no auto: a task saved before #573
  const tasks = [{ ...task, manual: true }, task, { ...task, manual: 'yes' }, { ...task, auto: false }, { ...task, auto: true, manual: true }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.tasks.map((c) => c.auto), [false, true, true, false, true]);
  assert.equal(loaded.tasks.some((c) => 'manual' in c), false, 'the old key is never kept');
});

test('loadState reads a session saved before #236, with only the column it started in, as that one stage, last used when it started', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const old = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', column: 'spec' };
  const lone = { item: { ...item, itemId: 'I2' }, stage: 'plan', boardColumn: 'Ready', auto: true, slug: 'hive-2-t', sessionId: uuid(4), enteredAt: old.startedAt };
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629({ ...initialState(0), tasks: [{ item, stage: 'plan', boardColumn: 'Ready', auto: true, slug: 'hive-1-t', sessions: [old] }, lone] })));
  // #629: neither task has live work, so the migration keeps its sessions in a deleted activity's record, in the main repo
  const loaded = await loadState(dir);
  assert.deepEqual(sessionsOf(loaded, 'I1'), [{ id: old.id, startedAt: old.startedAt, stages: ['spec'], lastUsedAt: old.startedAt, repo: true }]);
  assert.deepEqual(sessionsOf(loaded, 'I2'), [{ id: uuid(4), startedAt: old.startedAt, stages: ['plan'], lastUsedAt: old.startedAt, repo: true }], 'a task saved before the list reads as its sessionId, in its stage');
  assert.deepEqual(loaded.activityRecords.map((r) => r.slug), ['hive-1-t', 'hive-2-t'], 'each record keeps the task\'s slug: where its kept transcripts sit (#629)');
});

test('loadState drops a worker\'s sessionId when it is not shaped like a session id (#164)', async (t) => {
  const dir = await tempDir(t, '');
  const good = 'a1b2c3d4-0000-4000-8000-000000000002';
  const workers = [
    { id: 'a', status: 'working', runId: uuid(1), freeSession: true, sessionId: '.*' }, // a pkill pattern that matches every process the user owns
    { id: 'b', status: 'working', runId: uuid(2), freeSession: true, sessionId: good },
  ].map((w) => ({ ...w, activityId: OWNER }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), ...owned, workers }));
  const loaded = await loadState(dir);
  assert.equal('sessionId' in loaded.workers[0], false, 'not shaped like a session id: dropped, boot falls back to the worker id');
  assert.equal(loaded.workers[1].sessionId, good);
});

test('loadState keeps a task result that is a JSON object, drops any other value, and keeps an ask lastEvent (#99)', async (t) => {
  const dir = await tempDir(t, '');
  const task = (itemId: string, result: unknown) => ({ item: { itemId, id: itemId, title: 't', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true, slug: 'hive-1-t', result }); // pre-#629: the slug the migration gives the activity
  const saved = {
    ...initialState(1), workspaces: ['hive'], // #629: I1's run is live, so the migration gives it an activity for its worker to point at
    tasks: [{ ...task('I1', { spec: 'docs/x.md', pr: { number: 3 } }), workerId: 's1' }, task('I2', ['x']), task('I3', 'x'), task('I4', null)],
    workers: [{ id: 's1', status: 'waiting', runId: uuid(1), taskId: 'I1', question: 'Which base?', lastEvent: { kind: 'ask' } }],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629(saved)));
  const loaded = await loadState(dir);
  assert.deepEqual(resultOf(loaded, 'I1'), { spec: 'docs/x.md', pr: { number: 3 } }); // #629: the result is the record's
  assert.deepEqual(['I2', 'I3', 'I4'].map((id) => recordsOf(loaded, id).map((r) => Object.hasOwn(r, 'result'))), [[false], [false], [false]]);
  assert.equal(loaded.tasks.some((c) => 'result' in c), false);
  assert.deepEqual(loaded.workers[0].lastEvent, { kind: 'ask' });
});

test('loadState keeps a background lastEvent with its count (#367)', async (t) => {
  const dir = await tempDir(t, '');
  const saved = {
    ...initialState(1), ...owned,
    tasks: [{ item: { itemId: 'I1', id: 'I1', title: 't', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true }],
    workers: [{ id: 's1', status: 'working', runId: uuid(1), activityId: OWNER, lastEvent: { kind: 'background', detail: '2' } }],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(saved));
  assert.deepEqual((await loadState(dir)).workers[0].lastEvent, { kind: 'background', detail: '2' });
});

test('loadState keeps a task\'s workspace only as a string and reads workspaces as a list of strings, [] otherwise: boot overwrites both from the config (#179)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), workspaces: ['hive', 7], tasks: [{ ...task, workspace: 'site' }, { ...task, workspace: 7 }] }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.tasks, [{ ...task, workspace: 'site' }, task]);
  assert.deepEqual(loaded.workspaces, []);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), workspaces: ['hive', 'site'] }));
  assert.deepEqual((await loadState(dir)).workspaces, ['hive', 'site']);
});

test('loadState drops an activity\'s inFlight: started is having a live activity, which a save and a load keep (#224, #629, #727)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task: Task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const live = { id: uuid(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' };
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities: [{ ...live, inFlight: true }], activityRecords: [savedRecord(live.id, {})] }));
  assert.deepEqual((await loadState(dir)).activities, [live]);
});

test('loadState gives shutdownIdleMinutes the form default whatever the file holds: the config overwrites it on boot (#233)', async (t) => {
  const dir = await tempDir(t, '');
  const { shutdownIdleMinutes: _minutes, ...old } = initialState(1);
  await writeFile(join(dir, 'state.json'), JSON.stringify(old));
  assert.equal((await loadState(dir)).shutdownIdleMinutes, SHUTDOWN_IDLE_DEFAULT, 'a file from before the key');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...old, shutdownIdleMinutes: 'ten' }));
  assert.equal((await loadState(dir)).shutdownIdleMinutes, SHUTDOWN_IDLE_DEFAULT, 'nothing on disk is trusted for it');
});

test('loadState never comes back armed: a saved shutdown is dropped before boot runs (#233)', async (t) => {
  const dir = await tempDir(t, '');
  await saveState(dir, { ...initialState(1), shutdown: { armedAt: '2026-09-24T00:00:00.000Z' } });
  assert.equal((await loadState(dir)).shutdown, undefined);
});

test('loadState keeps a task\'s usage only as three counts ≥ 0, a session\'s tokens only as a count, and a worker\'s waitedMs, seenAt and waitingSince only in the shape the reducer writes: boot closes the run with them (#248)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const session = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-09-22T11:00:00.000Z' };
  const usage = { tokens: 3_400_000, ms: 4_320_000, waitingMs: 0 };
  const at = '2026-09-24T10:00:00.000Z';
  const worker: Worker = { id: 'a', status: 'waiting', runId: uuid(1), activityId: OWNER, waitedMs: 60_000, seenAt: at, waitingSince: at };
  const good = withKeptRecord({ ...initialState(0), ...owned, workers: [worker], tasks: [task] }, 'I1', 'r1', { usage, sessions: [{ ...session, tokens: 1200 }] }); // #629: the record's
  await saveState(dir, good);
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.workers[0], loaded.tasks, loaded.activityRecords], [worker, [task], good.activityRecords], 'a save and a load keep them');
  const badUsage = [{ ...usage, ms: -1 }, { ...usage, tokens: '5' }, { tokens: 1, ms: 1 }, null, 'x'];
  const activityRecords = [...badUsage.map((u, i) => savedRecord(`r${i}`, { usage: u })), savedRecord('rs', { sessions: [{ ...session, tokens: -1 }, { ...session, tokens: '9' }] })];
  const workers = [{ ...worker, waitedMs: -5, seenAt: 'yesterday', waitingSince: 7 }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), workers, tasks: [task], activities: owned.activities, activityRecords: [...activityRecords, ...owned.activityRecords] }));
  const dropped = await loadState(dir);
  assert.deepEqual(dropped.activityRecords.filter((r) => r.id !== OWNER).map(({ id: _id, ...r }) => r), [...badUsage.map(() => ({ taskIds: ['I1'], sessions: [] })), { taskIds: ['I1'], sessions: [session, session] }], 'dropped, not kept as undefined: the record reads as nothing recorded');
  assert.deepEqual(dropped.workers[0], { id: 'a', status: 'waiting', runId: uuid(1), activityId: OWNER });
});

test('loadState keeps an activity\'s worktreeGone and a session\'s repo and free only as true: a save and a load keep them, anything else drops the key (#208, #629, #812)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const session = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-09-22T11:00:00.000Z' };
  const task: Task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const live = { id: uuid(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' }; // #629: the mark is the activity's
  const state = withKeptRecord(withWork({ ...initialState(1), tasks: [task] }, 'I1', { ...live, worktreeGone: true }), 'I1', 'r1', { sessions: [{ ...session, repo: true, free: true }] });
  await saveState(dir, state);
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.tasks, loaded.activities, loaded.activityRecords], [[task], state.activities, state.activityRecords], 'a restart keeps both: the session button stays hidden, a repo session still opens in the main repo');
  const values = [false, 'yes', 1, null];
  const activities = values.map((v, i) => ({ ...live, id: uuid(i + 2), worktreeGone: v }));
  const activityRecords = values.map((v, i) => savedRecord(uuid(i + 2), { sessions: [{ ...session, repo: v, free: v }] }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities, activityRecords }));
  const dropped = await loadState(dir);
  assert.deepEqual([dropped.activities, dropped.activityRecords.map((r) => r.sessions)], [values.map((_, i) => ({ ...live, id: uuid(i + 2) })), [[session], [session], [session], [session]]], 'dropped, not kept as undefined');
});

test('loadState keeps a session\'s name only as a non-empty string, cleaned and cut to 60 characters: a save and a load keep it, anything else drops the key (#489)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const session = { id: 'a1b2c3d4-0000-4000-8000-000000000001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-09-22T11:00:00.000Z' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const named = withKeptRecord({ ...initialState(1), tasks: [task] }, 'I1', 'r1', { sessions: [{ ...session, name: 'fix the login' }] }); // #629: the record's
  await saveState(dir, named);
  assert.deepEqual((await loadState(dir)).activityRecords, named.activityRecords, 'a restart keeps it: a Continue or a resume shows the name again');
  const bad = [42, '', '   ', null, true].map((name, i) => savedRecord(`r${i}`, { sessions: [{ ...session, name }] }));
  const long = savedRecord('long', { sessions: [{ ...session, name: `\u0007${'n'.repeat(80)}` }] });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activityRecords: [...bad, long] }));
  assert.deepEqual((await loadState(dir)).activityRecords.map((r) => r.sessions), [...bad.map(() => [session]), [{ ...session, name: 'n'.repeat(60) }]]);
});

test('loadState keeps an activity\'s local only as true: a save and a load keep it, anything else drops the key (#444, #573, #629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task: Task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const live = { id: uuid(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' }; // #629: where git runs is the activity's
  const marked = withWork({ ...initialState(1), tasks: [task] }, 'I1', { ...live, local: true });
  await saveState(dir, marked);
  assert.deepEqual((await loadState(dir)).activities, marked.activities, 'a restart keeps the task in its workspace\'s checkout');
  const values = [false, 'yes', 1, null];
  const activities = values.map((v, i) => ({ ...live, id: uuid(i + 2), local: v }));
  const activityRecords = values.map((_, i) => savedRecord(uuid(i + 2), {}));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities, activityRecords }));
  assert.deepEqual((await loadState(dir)).activities, values.map((_, i) => ({ ...live, id: uuid(i + 2) })), 'dropped, not kept as undefined');
});

test('loadState reads a task saved before #573 by its old names, checkout true as local and local true as created; one saved after keeps local and created as they are, and a stray checkout goes (#573)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' };
  const old = { item, stage: 'dev', boardColumn: '' }; // no auto: the shape of before #573
  const now = { ...old, auto: true };
  const tasks = [{ ...old, checkout: true }, { ...old, local: true }, { ...old, local: true, checkout: true }, { ...now, local: true }, { ...now, created: true }, { ...now, checkout: true }];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks }));
  const loaded = (await loadState(dir)).tasks;
  // #629: local is the activity's now; on a file that already has activities a task's own goes, and created is read as before
  assert.deepEqual(loaded.map((c) => c.created), [undefined, true, true, undefined, true, undefined]);
  assert.equal(loaded.some((c) => 'checkout' in c || 'local' in c), false);
});

test('loadState keeps a task\'s PRs only as GitHub pull request links in one of the three states, and reads a prUrl saved before #207 as one open PR', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const prs: TaskPr[] = [{ url: 'https://github.com/o/r/pull/1', state: 'merged' }, { url: 'https://github.com/o/r/pull/2', state: 'open' }];
  const kept = withKeptRecord({ ...initialState(1), tasks: [task] }, 'I1', 'r1', { prs }); // #629: the PRs are the record's
  await saveState(dir, kept);
  assert.deepEqual((await loadState(dir)).activityRecords, kept.activityRecords, 'a save and a load keep them');
  const legacy = [{ ...task, prUrl: 'https://github.com/o/r/pull/9' }, { ...task, item: { ...item, itemId: 'I2' }, prUrl: 'x' }];
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629({ ...initialState(1), tasks: legacy })));
  const migrated = await loadState(dir);
  assert.deepEqual([prsOf(migrated, 'I1'), prsOf(migrated, 'I2')], [[{ url: 'https://github.com/o/r/pull/9', state: 'open' }], []], 'the legacy link reads as open until the next poll');
  const bad = [{ url: 'https://github.com/o/r/pull/3', state: 'draft' }, { url: 'javascript:alert(1)', state: 'open' }, { url: 7, state: 'open' }, null, 'x'];
  const activityRecords = [savedRecord('r0', { prs: [prs[0], ...bad] }), savedRecord('r1', { prs: bad }), savedRecord('r2', { prs: 'x' })];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activityRecords }));
  assert.deepEqual((await loadState(dir)).activityRecords.map((r) => r.prs), [[prs[0]], undefined, undefined],
    'an entry that is not a PR link in a known state goes, the key too when none is left');
});

test('savedPrs keeps a PR\'s slice only with an integer k ≥ 1 and a type of stacked or integration; a malformed one is dropped and the PR kept; a legacy prUrl reads as one open PR without a slice (#698)', () => {
  const url = 'https://github.com/o/r/pull/1';
  const slices = [{ k: 2, type: 'stacked' }, { k: 1, type: 'integration', extra: 1 }, { k: 0, type: 'stacked' }, { k: 1.5, type: 'stacked' }, { k: 1, type: 'single' }, 'x', null];
  assert.deepEqual(savedPrs(slices.map((slice) => ({ url, state: 'open', slice })), undefined).map((pr) => pr.slice),
    [{ k: 2, type: 'stacked' }, { k: 1, type: 'integration' }, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(savedPrs([{ url, state: 'merged', slice: { k: 0 } }], undefined), [{ url, state: 'merged' }], 'no slice key is left behind');
  assert.deepEqual(savedPrs(undefined, url), [{ url, state: 'open' }]);
});

test('loadState keeps stopped only as true, a stageStart only with a stage and a hex sha, the terminals only in their written shape, cleanStop only as true and a crash only with a date and item ids (#283)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const terminal = { terminalId: uuid(1), activityId: savedActivityId(1), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }; // savedTasks' activity of I1
  const crash = { at: '2026-09-25T10:00:00.000Z', tasks: ['I1'] };
  // #629: the stopped mark and the stage start are the activity's, the one the terminal points at
  const live = { id: savedActivityId(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' };
  const stageStart = { stage: 'dev', commit: '0123456789abcdef0123456789abcdef01234567' };
  const good = savedTasks({ ...initialState(0), terminals: [terminal], cleanStop: true, crash }, [{ ...task, stopped: true, stageStart }], () => 'hive-1-t');
  await saveState(dir, good);
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.tasks, loaded.activities, loaded.terminals, loaded.cleanStop, loaded.crash], [[task], good.activities, [terminal], true, crash]);
  const activities = [{ ...live, id: uuid(1), stopped: 'yes', stageStart: { stage: 'dev', commit: '--upload-pack=x' } }, { ...live, id: uuid(2), stageStart: 'dev' }];
  const onFirst = { ...terminal, activityId: uuid(1) };
  const terminals = [{ ...onFirst, terminalId: '.*' }, { ...onFirst, activityId: 7 }, { ...onFirst, extra: 1 }];
  const records = activities.map((a) => savedRecord(a.id, {}));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), tasks: [task], activities, activityRecords: records, terminals, cleanStop: 'yes', crash: { at: 'nope', tasks: ['I1'] } }));
  const dropped = await loadState(dir);
  assert.deepEqual([dropped.activities, dropped.terminals, 'cleanStop' in dropped, 'crash' in dropped], [[{ ...live, id: uuid(1) }, { ...live, id: uuid(2) }], [onFirst], false, false]);
});

test('loadState keeps stoppedAt only as a date on an activity it keeps stopped, and a stageStart\'s after only as a string (#580, #629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const [activity] = owned.activities;
  const saved = (work: object) => ({ ...initialState(0), tasks: [task], activities: [{ ...activity, ...work }], activityRecords: owned.activityRecords });
  const good = { ...activity, stopped: true as const, stoppedAt: '2026-09-30T10:00:00.000Z', stageStart: { stage: 'dev', commit, after: 'plan' } };
  await saveState(dir, saved(good));
  assert.deepEqual((await loadState(dir)).activities, [good]);
  await writeFile(join(dir, 'state.json'), JSON.stringify(saved({ stoppedAt: '2026-09-30T10:00:00.000Z' })));
  assert.deepEqual((await loadState(dir)).activities, [activity], 'no stopped mark: the time goes with it');
  await writeFile(join(dir, 'state.json'), JSON.stringify(saved({ stopped: true, stoppedAt: 'nope', stageStart: { stage: 'dev', commit, after: 7 } })));
  assert.deepEqual((await loadState(dir)).activities, [{ ...activity, stopped: true, stageStart: { stage: 'dev', commit } }]);
});

test('loadState keeps a workspace shell with its local activity (#292, #629), and drops a shell with no activity, one with only the old workspace, or one whose activity is not a string', async (t) => {
  const dir = await tempDir(t, '');
  const terminal = { terminalId: uuid(2), activityId: localActivityId('hive'), startedAt: '2026-09-26T10:00:00.000Z', cwd: '/repo' };
  await saveState(dir, withLocal({ ...initialState(0), terminals: [terminal] }, 'hive'));
  assert.deepEqual((await loadState(dir)).terminals, [terminal]);
  const { activityId: _activity, ...ownerless } = terminal;
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), terminals: [{ ...ownerless, workspace: 'hive' }, ownerless, { ...terminal, activityId: 7 }] }));
  assert.deepEqual((await loadState(dir)).terminals, []);
});

test('loadState drops the terminal mode a file from before #378 still carries: on a terminal, on a worker and on the state itself', async (t) => {
  const dir = await tempDir(t, '');
  const terminal = { terminalId: uuid(3), activityId: OWNER, startedAt: '2026-09-26T10:00:00.000Z', cwd: '/repo' };
  const worker = { id: 's1', status: 'working', runId: uuid(4), activityId: OWNER };
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), ...owned, terminal: 'internal', workers: [{ ...worker, terminal: 'internal' }], terminals: [{ ...terminal, terminal: 'internal' }] }));
  const loaded = await loadState(dir);
  assert.deepEqual([loaded.terminals, loaded.workers, 'terminal' in loaded], [[terminal], [worker], false]);
});

test('loadState keeps an activity\'s approval and queued handover in the shape the Hive writes and drops any other, a pre-#134 feedback included, and the approval\'s session only as a uuid; approvalMinutes reads as the form default (#268, #629, #134, #812)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task: Task = { item, stage: 'spec', boardColumn: 'Ready', auto: true };
  const since = '2026-09-25T10:00:00.000Z';
  const live = { id: uuid(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' }; // #629: both are the activity's
  const kept = [{ ...live, approval: { since, until: '2026-09-25T10:10:00.000Z' } }, { ...live, id: uuid(2), approval: { since, sessionId: uuid(8) }, handover: { prompt: 'split it', sessionId: uuid(9) } }];
  const records = kept.map((a) => savedRecord(a.id, {}));
  await saveState(dir, { ...initialState(1), tasks: [task], activities: kept, activityRecords: records });
  assert.deepEqual((await loadState(dir)).activities, kept, 'a restart keeps both');
  const bad = [
    { ...live, approval: { since: 'yesterday' }, handover: { prompt: '' } },
    { ...live, id: uuid(2), approval: { since, until: 5, sessionId: '--settings' }, feedback: 'split it' },
    { ...live, id: uuid(3), approval: 'yes', handover: 42 },
    { ...live, id: uuid(4), handover: { prompt: 'p', sessionId: '--settings' } },
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities: bad, activityRecords: bad.map((a) => savedRecord(a.id, {})), approvalMinutes: 'ten' }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.activities, [live, { ...live, id: uuid(2), approval: { since } }, { ...live, id: uuid(3) }, { ...live, id: uuid(4), handover: { prompt: 'p' } }], 'an unreadable since drops approval; a bad until drops only until; a session id not a uuid drops only the id');
  assert.equal(loaded.approvalMinutes, APPROVAL_MINUTES_DEFAULT, 'overwritten by the config on boot');
});

test('loadState keeps an activity\'s handoffPending only as a string, the waiting transition\'s key, and freeSessionStage only as text: a save and a load keep them, anything else drops the key (#692, #134, #812)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task: Task = { item, stage: 'spec', boardColumn: 'Ready', auto: true };
  const live = { id: uuid(1), kind: 'task' as const, workspace: 'hive', slug: 'hive-1-t' }; // #629: the run's marks are the activity's
  const marked = { ...live, handoffPending: '["spec","done",null]', freeSessionStage: 'spec' };
  await saveState(dir, { ...initialState(1), tasks: [task], activities: [marked], activityRecords: [savedRecord(live.id, {})] });
  assert.deepEqual((await loadState(dir)).activities, [marked], 'a restart keeps it: the handoff\'s end still moves the task');
  const bad = [true, false, 1, null].map((v, i) => ({ ...live, id: uuid(i + 1), handoffPending: v, freeSessionStage: i }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), tasks: [task], activities: bad, activityRecords: bad.map((a) => savedRecord(a.id, {})) }));
  assert.deepEqual((await loadState(dir)).activities, bad.map(({ handoffPending: _h, freeSessionStage: _f, ...a }) => a), 'dropped, not kept as undefined');
});

test('loadState reads a task saved before #286 with its stage under column, and drops a state-level columns: the config sends the stages on boot', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
  const legacy = { item, column: 'dev', boardColumn: 'Ready', auto: true };
  const { stages: _stages, ...saved } = initialState(1);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...saved, columns: [{ name: 'dev', from: {} }], tasks: [legacy] }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.tasks, [{ item, stage: 'dev', boardColumn: 'Ready', auto: true }], 'the task keeps its stage across the rename');
  assert.deepEqual(loaded.stages, [], 'the saved columns are not read: boot sets the stages from the config');
  assert.equal('columns' in loaded, false, 'and not carried into the next save');
});

test('loadState keeps disabledRules in the shapes the route accepts, a past at included, drops any other entry, and reads a file without the key as [] (#297)', async (t) => {
  const dir = await tempDir(t, '');
  const disabledRules: DisabledRule[] = [
    { source: 'session', percent: 80, until: { kind: 'reset' } },
    { source: 'hour', percent: 50, until: { kind: 'at', at: '2026-09-25T15:00:00.000Z' } },
    { source: 'week', percent: 90, until: { kind: 'manual' } },
  ];
  await saveState(dir, { ...initialState(1), disabledRules });
  assert.deepEqual((await loadState(dir)).disabledRules, disabledRules, 'a save and a load keep them');
  const bad = [
    { source: 'month', percent: 80, until: { kind: 'reset' } }, { source: 'hour', percent: '80', until: { kind: 'reset' } },
    { source: 'hour', percent: 80, until: { kind: 'later' } }, { source: 'hour', percent: 80, until: { kind: 'at', at: 'soon' } },
    { source: 'hour', percent: 80 }, null, 'x',
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), disabledRules: [{ ...disabledRules[0], extra: 1 }, ...bad] }));
  assert.deepEqual((await loadState(dir)).disabledRules, [disabledRules[0]], 'only the valid entry, field by field');
  const { disabledRules: _gone, ...old } = initialState(1);
  await writeFile(join(dir, 'state.json'), JSON.stringify(old));
  assert.deepEqual((await loadState(dir)).disabledRules, [], 'a file from before #297');
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...old, disabledRules: 'x' }));
  assert.deepEqual((await loadState(dir)).disabledRules, []);
});

test('loadState keeps each workspace\'s local sessions in a task session\'s shape with no stages, drops a bad id and a workspace the saved Comb no longer names, reads a file without them as none, and keeps a worker\'s workspace and a copy mark only in its shape (#587)', async (t) => {
  const dir = await tempDir(t, '');
  const at = '2026-09-29T10:00:00.000Z';
  const kept = { id: uuid(1), startedAt: at, stages: [], lastUsedAt: at, tokens: 10, name: 'no main' };
  const worker = { id: 's', status: 'waiting', runId: uuid(2), workspace: 'hive', sessionId: uuid(1), freeSession: true, copyOf: { from: uuid(3), dir: '/x' } };
  const forged = [{ ...worker, id: 't', copyOf: { from: '../x', dir: '/x' } }, { ...worker, id: 'u', copyOf: { from: uuid(3), dir: 7 } }, { ...worker, id: 'v', copyOf: 'x' }];
  const saved = { ...initialState(0), workspaces: ['hive'], workers: [worker, ...forged], localSessions: { hive: [kept, { ...kept, id: '--settings' }], gone: [kept] } };
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629(saved))); // #629: read into each workspace's local record
  const loaded = await loadState(dir);
  assert.deepEqual([localSessionsOf(loaded, 'hive'), loaded.activityRecords.some((r) => r.id === localActivityId('gone'))], [[kept], false]);
  const local = localActivityId('hive'); // #629: the migration points each at its workspace's local activity
  assert.deepEqual(loaded.workers.map((s) => [s.activityId, s.copyOf]), [[local, { from: uuid(3), dir: '/x' }], [local, undefined], [local, undefined], [local, undefined]]);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ maxConcurrent: 1, workers: [] })); // written before #587
  assert.deepEqual((await loadState(dir)).activityRecords, []);
});

test('loadState drops a stored inheritedTitle, written before a copy\'s fork got its own name (#587)', async (t) => {
  const dir = await tempDir(t, '');
  const at = '2026-09-29T10:00:00.000Z';
  const entry = { id: uuid(1), startedAt: at, stages: [], lastUsedAt: at, name: 'no dois', inheritedTitle: 'review' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629({ ...initialState(0), workspaces: ['hive'], localSessions: { hive: [entry] } })));
  assert.deepEqual(localSessionsOf(await loadState(dir), 'hive'), [{ id: uuid(1), startedAt: at, stages: [], lastUsedAt: at, name: 'no dois' }]);
});

test('loadState maps a pre-#629 worker\'s workspace to its local activity only on a local session\'s run, a free session with no taskId; any other occupied one is emptied (#590, #629)', async (t) => {
  const dir = await tempDir(t, '');
  const run = { status: 'working', runId: uuid(2), workspace: 'hive', sessionId: uuid(1) };
  const workers = [{ ...run, id: 'a', freeSession: true }, { ...run, id: 'b' }, { ...run, id: 'c', freeSession: true, taskId: 'board:1' }, { ...run, id: 'd', freeSession: true, workspace: 3 }];
  await writeFile(join(dir, 'state.json'), JSON.stringify(pre629({ ...initialState(0), workspaces: ['hive'], workers })));
  assert.deepEqual((await loadState(dir)).workers.map((s) => [s.status, s.activityId]), [['working', localActivityId('hive')], ['empty', undefined], ['empty', undefined], ['empty', undefined]]);
});

test('loadState reads a state.json in the #569 shape as it is (#569)', async (t) => {
  const dir = await tempDir(t, '');
  const at = '2026-09-30T10:00:00.000Z';
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const task = { item, stage: 'dev', boardColumn: 'Ready', auto: true };
  const state = {
    ...initialState(1), ...owned, tasks: [task], workers: [{ id: 's1', status: 'working' as const, runId: uuid(1), activityId: OWNER }],
    terminals: [{ terminalId: uuid(2), activityId: OWNER, startedAt: at, cwd: '/repo' }], crash: { at, tasks: ['I1'] },
  };
  await saveState(dir, state);
  assert.deepEqual(await loadState(dir), state, 'a new-shaped file loads unchanged');
});

test('saveState then loadState round-trips activities and records (#629)', async (t) => {
  const dir = await tempDir(t, '');
  const task: Task = { item: { itemId: 'board:item1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workspace: 'hive' };
  const session = { id: uuid(5), startedAt: '2026-10-01T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-10-01T10:00:00.000Z' };
  const worked = withWork({ ...initialState(1), workspaces: ['hive'], tasks: [task] }, 'board:item1', { id: uuid(1), slug: 'hive-1-t', worktree: '/w/1', branch: 'hive/1-t' }, { sessions: [session], result: { spec: 'a.md' } });
  const state = withLocal(worked, 'hive');
  await saveState(dir, state);
  assert.deepEqual(await loadState(dir), state);
});

test('loadState drops an activity or a record that fails its guard, an activity without its record, and a record nothing needs (#629)', async (t) => {
  const dir = await tempDir(t, '');
  const task = { item: { itemId: 'board:item1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const good = { id: uuid(1), kind: 'task', workspace: 'hive', slug: 'hive-1-t', worktree: '/w/1', setup: { consoleId: 'x' }, deleting: true };
  const activities = [good, { ...good, id: 'not-a-uuid' }, { ...good, id: uuid(2), slug: '../x' }, { id: 'local:other', kind: 'local', workspace: 'hive' }, { ...good, id: uuid(3) }];
  const activityRecords = [
    { id: uuid(1), taskIds: ['board:item1'], sessions: [{ id: 'x' }] }, { id: uuid(4), taskIds: ['board:gone'], sessions: [] }, { id: uuid(6), taskIds: 'nope' },
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ maxConcurrent: 1, workers: [], tasks: [task], activities, activityRecords }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.activities, [{ id: uuid(1), kind: 'task', workspace: 'hive', slug: 'hive-1-t', worktree: '/w/1' }], 'setup and deleting never survive a boot; uuid(3) has no record');
  assert.deepEqual(loaded.activityRecords, [{ id: uuid(1), taskIds: ['board:item1'], sessions: [] }], 'a malformed session goes; a gone task\'s record with no activity is pruned');
});

const at = '2026-09-30T10:00:00.000Z';
const savedItem = (n: number) => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const sessionAt = (n: number, stage: string) => ({ id: uuid(n), startedAt: at, stages: [stage], lastUsedAt: at });
// A state.json written before #629: every task carries its own work
const PRE_629 = {
  maxConcurrent: 1, signal: 'green', workspaces: ['hive', 'web'],
  workers: [
    { id: 'w1', runId: uuid(8), status: 'working', taskId: 'board:item1', startedAt: at },
    { id: 'w2', runId: uuid(9), status: 'working', workspace: 'web', freeSession: true, sessionId: uuid(7), startedAt: at },
    { id: 'w3', runId: 'c1b2c3d4-0000-4000-8000-00000000000a', status: 'working', taskId: 'board:gone', startedAt: at },
  ],
  tasks: [
    { item: savedItem(1), stage: 'dev', boardColumn: 'In progress', auto: true, slug: 'hive-1-task-1', workspace: 'hive', worktree: '/w/hive-1-task-1', branch: 'hive/1-task-1',
      workerId: 'w1', inFlight: true, sessionId: uuid(2), sessions: [sessionAt(2, 'dev')], stageStart: { stage: 'dev', commit: 'abc1234' } },
    { item: savedItem(2), stage: 'review', boardColumn: 'In review', auto: true, slug: 'hive-2-task-2', workspace: 'hive', worktree: '/w/hive-2-task-2',
      approval: { since: at }, sessions: [sessionAt(3, 'review')], result: { spec: 'a.md' } },
    { item: savedItem(3), stage: 'done', boardColumn: 'Done', auto: true, slug: 'hive-3-task-3', workspace: 'hive', sessions: [sessionAt(4, 'dev')],
      result: { pr: 'x' }, prs: [{ url: 'https://github.com/o/r/pull/3', state: 'merged' }] },
    { item: savedItem(4), stage: 'dev', boardColumn: 'Ready', auto: true, slug: 'hive-4-task-4', local: true },
  ],
  localSessions: { hive: [{ id: uuid(6), startedAt: at, stages: [], lastUsedAt: at }], web: [{ id: uuid(7), startedAt: at, stages: [], lastUsedAt: at }], gone: [] },
};

test('loadState turns a pre-#629 file\'s task work into activities and records, every worktree, session, run and approval intact (#629)', async (t) => {
  const dir = await tempDir(t, '');
  await writeFile(join(dir, 'state.json'), JSON.stringify(PRE_629));
  const loaded = await loadState(dir, { workspaces: ['hive', 'web'], sourceWorkspaces: {} });
  const of = (n: number) => activityOf(loaded, `board:item${n}`);
  const running = of(1);
  assert.ok(running);
  const { id: _id, ...fields } = running;
  assert.deepEqual(fields, {
    kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', worktree: '/w/hive-1-task-1', branch: 'hive/1-task-1',
    workerId: 'w1', sessionId: uuid(2), stageStart: { stage: 'dev', commit: 'abc1234' },
  });
  assert.deepEqual(recordOf(loaded, running.id)?.sessions, [sessionAt(2, 'dev')]);
  assert.deepEqual(of(2)?.approval, { since: at });
  assert.deepEqual(resultOf(loaded, 'board:item2'), { spec: 'a.md' });
  assert.equal(of(3), undefined, 'a deleted activity: a record alone');
  assert.deepEqual(recordsOf(loaded, 'board:item3').map(({ id: _rid, ...r }) => r), [{
    taskIds: ['board:item3'], slug: 'hive-3-task-3', sessions: [{ ...sessionAt(4, 'dev'), repo: true }], result: { pr: 'x' }, prs: [{ url: 'https://github.com/o/r/pull/3', state: 'merged' }],
  }]);
  assert.deepEqual(recordsOf(loaded, 'board:item4'), [], 'a lone local: nothing');
  for (const [workspace, n] of [['hive', 6], ['web', 7]] as const) {
    assert.deepEqual(loaded.activities.find((a) => a.id === localActivityId(workspace)), { id: localActivityId(workspace), kind: 'local', workspace });
    assert.deepEqual(recordOf(loaded, localActivityId(workspace))?.sessions, [{ id: uuid(n), startedAt: at, stages: [], lastUsedAt: at }]);
  }
  assert.equal(loaded.activities.some((a) => a.workspace === 'gone'), false, 'a workspace the file no longer names gets nothing');
  assert.equal('sessions' in loaded.tasks[0], false, 'the record keys left the task');
  assert.deepEqual(loaded.workers.map((w) => [w.id, w.activityId]), [['w1', of(1)?.id], ['w2', localActivityId('web')], ['w3', undefined]]);
  assert.equal(loaded.workers[2].status, 'empty', 'a worker that maps to no activity is emptied, as an unknown one is');
  await saveState(dir, loaded);
  assert.ok('activities' in JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), 'the next save writes the new shape');
  const written = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown> & { tasks: Record<string, unknown>[] };
  assert.equal('localSessions' in written, false);
  for (const key of ['sessions', 'result', 'prs', 'usage']) assert.equal(written.tasks.some((c) => key in c), false, `${key} left every task`);
  for (const key of ['slug', 'worktree', 'branch', 'workerId', 'inFlight', 'sessionId', 'stageStart', 'approval', 'feedback', 'error', 'local', 'base']) {
    assert.equal(written.tasks.some((c) => key in c), false, `${key} left every task`);
  }
});

test('loadState keeps an occupied worker and a terminal only on a loaded activity, and a worker on a local one only as a free session (#590, #629)', async (t) => {
  const dir = await tempDir(t, '');
  const item = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const local = localActivityId('hive');
  const activities = [{ id: uuid(5), kind: 'task', workspace: 'hive', slug: 'hive-1-t' }, { id: local, kind: 'local', workspace: 'hive' }];
  const records = [savedRecord(uuid(5), {}), { id: local, taskIds: [], sessions: [] }];
  const run = { status: 'working', runId: uuid(1) };
  const workers = [
    { ...run, id: 'a', activityId: uuid(5) }, { ...run, id: 'b', activityId: uuid(6) }, { ...run, id: 'c', activityId: local, freeSession: true },
    { ...run, id: 'd', activityId: local }, { ...run, id: 'e', activityId: localActivityId('gone'), freeSession: true }, { ...run, id: 'f' },
  ];
  const terminal = (n: number, activityId: string) => ({ terminalId: uuid(n), activityId, startedAt: '2026-09-26T10:00:00.000Z', cwd: '/repo' });
  const terminals = [terminal(1, uuid(5)), terminal(2, local), terminal(3, uuid(6)), terminal(4, localActivityId('gone'))];
  const file = { ...initialState(0), workspaces: ['hive'], tasks: [{ item, stage: 'dev', boardColumn: 'Ready', auto: true }], activities, activityRecords: records, workers, terminals };
  await writeFile(join(dir, 'state.json'), JSON.stringify(file));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.workers.map((w) => [w.id, w.status, w.activityId]), [
    ['a', 'working', uuid(5)], ['b', 'empty', undefined], ['c', 'working', local], ['d', 'empty', undefined], ['e', 'empty', undefined], ['f', 'empty', undefined],
  ]);
  assert.deepEqual(loaded.terminals, [terminal(1, uuid(5)), terminal(2, local)]);
});

test('the sleeping runs are never saved: saveState writes none and loadState reads none (#672)', async (t) => {
  const dir = await tempDir(t, 'state-');
  const run: SleptRun = { ptyId: 'W1', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001', agent: 'claude', kind: 'session', at: 1 };
  await saveState(dir, { ...initialState(1), slept: [run] });
  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('slept' in raw, false);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), slept: [run] }));
  assert.equal((await loadState(dir)).slept, undefined);
});

test('loadState keeps a terminal\'s cwd, its asleep mark and its command, and drops a terminal saved without a cwd (#696)', async (t) => {
  const dir = await tempDir(t, '');
  const at = '2026-10-03T10:00:00.000Z';
  const asleep = { terminalId: uuid(1), activityId: OWNER, startedAt: at, cwd: '/repo/src', asleep: true };
  const command = { terminalId: uuid(2), activityId: OWNER, startedAt: at, cwd: '/repo', command: 'Run Frontend' };
  const old = { terminalId: uuid(3), activityId: OWNER, startedAt: at };
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), ...owned, terminals: [asleep, command, old, { ...asleep, terminalId: uuid(4), asleep: 'yes' }] }));
  const { asleep: _yes, ...plain } = asleep;
  assert.deepEqual((await loadState(dir)).terminals, [asleep, command, { ...plain, terminalId: uuid(4) }]);
});

test('a record keeps its stageRuns on load, counts only; a PR keeps the times the poll read, dates only (#742)', () => {
  assert.deepEqual(loadRecord({ id: 'r1', taskIds: ['board:I1'], sessions: [], stageRuns: { dev: 2, spec: 'x', review: -1, plan: 0, build: 1.5 } })?.stageRuns, { dev: 2 }, 'a whole count of at least 1');
  assert.equal(loadRecord({ id: 'r1', taskIds: ['board:I1'], sessions: [], stageRuns: 'x' })?.stageRuns, undefined);
  const url = 'https://github.com/acme/r/pull/9';
  assert.deepEqual(savedPrs([{ url, state: 'merged', openedAt: '2026-10-01T10:00:00.000Z', mergedAt: 'soon' }], undefined), [{ url, state: 'merged', openedAt: '2026-10-01T10:00:00.000Z' }]);
});

test('a worker in backoff keeps its wait, its count and its apiError event across a load; a malformed wait or count drops only that field; rateLimitWaitMinutes reads as the default (#805)', async (t) => {
  const dir = await tempDir(t, '');
  const waiting: Worker = {
    id: 'a', status: 'backoff', runId: uuid(1), activityId: OWNER, apiErrors: 2,
    backoff: { error: 'overloaded', until: '2026-10-06T12:02:00.000Z' }, lastEvent: { kind: 'apiError', detail: 'overloaded' },
  };
  const workers = [
    waiting,
    { ...waiting, id: 'b', runId: uuid(2), backoff: { error: 'overloaded', until: 'soon' } },
    { ...waiting, id: 'c', runId: uuid(3), apiErrors: 0 },
    { ...waiting, id: 'd', runId: uuid(4), backoff: 'x', apiErrors: 1.5 },
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), ...owned, workers, rateLimitWaitMinutes: 'lots' }));
  const loaded = await loadState(dir);
  assert.deepEqual(loaded.workers[0], waiting, 'the shape the reducer writes is kept whole');
  assert.deepEqual(loaded.workers.slice(1).map((w) => [w.id, w.status, w.backoff, w.apiErrors]), [
    ['b', 'backoff', undefined, 2], ['c', 'backoff', waiting.backoff, undefined], ['d', 'backoff', undefined, undefined],
  ], 'the field goes, never the worker');
  assert.equal(loaded.rateLimitWaitMinutes, RATE_LIMIT_WAIT_DEFAULT, 'overwritten by the config on boot');
});
