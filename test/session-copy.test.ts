import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyPending, localSessionsOf } from '../src/local-sessions.js';
import { sessionsOf } from '../src/tasks.js';
import { activityOf, localActivityId, recordOf, taskOfWorker } from '../src/activities.js';
import { activityIdOf, withLocal, withWork } from './fixtures/work.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { Activity, Task, Session, SessionTarget, Effect, State } from '../src/types.js';
import { chained } from './fakes.js';

// Copy (#587): a new session from another one, into a task with a directory or a workspace's local, and the local session itself.
const SOURCE = 'a1b2c3d4-0000-4000-8000-000000000001';
const T0 = '2026-09-29T10:00:00.000Z';
const DIR = '/claude/projects/-repo--hive-worktrees-two'; // an opaque string to the reducer
const session = (extra: Partial<Session> = {}): Session => ({ id: SOURCE, startedAt: T0, stages: ['dev'], agent: 'claude' as const, lastUsedAt: T0, tokens: 1200, name: 'review', ...extra });
const worktreeOf = (n: number): string => `/repo/.hive/worktrees/hive-hive-${n}-task-${n}`;
const task = (n: number, extra: Partial<Task> = {}): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `task ${n}`, body: '', url: '' }, stage: 'dev', boardColumn: 'dev',
  workspace: 'hive', created: true, auto: false, ...extra,
});
const A = task(1);
// Every task's activity with its worktree, unless `live` says otherwise, and A's session in its record, its sessionId on A's activity (#629)
const hive = (tasks: Task[], extra: Partial<State> = {}, live: Record<string, Partial<Activity>> = {}): State => {
  const state: State = { ...initialState(0), workspaces: ['hive', 'site'], ...chained([{ name: 'dev', from: {}, prompt: 'x' }]), tasks, ...extra };
  return tasks.reduce((acc, c) => withWork(acc, c.item.itemId, { worktree: worktreeOf(Number(c.item.itemId.split(':')[1])), ...(c === A ? { sessionId: SOURCE } : {}), ...live[c.item.itemId] }, c === A ? { sessions: [session()] } : {}), state);
};
const B = task(2);
type Spawn = Extract<Effect, { type: 'spawnSession' }>;
const spawnOf = (effects: Effect[]): Spawn => effects.find((e): e is Spawn => e.type === 'spawnSession')!;
const copyTo = (state: State, to: SessionTarget, extra = {}) =>
  reduce(state, { type: 'copySession', from: { activityId: activityIdOf('local:1'), sessionId: SOURCE }, to, name: 'no dois', notice: 'Hive: moved', copied: DIR, ...extra });
const stop = (state: State, tokens: number, title?: string) =>
  reduce(state, { type: 'hook', ptyId: state.workers.at(-1)!.runId!, payload: { hook_event_name: 'Stop' }, tokens, ...(title === undefined ? {} : { title }) }).state;

test('a copy into a task appends a named entry that starts from the source\'s tokens, in a free session of the task marked with the temporary copy, and spawns the fork; the source and the task\'s own session id are untouched; a free entry with no stage (#587, #812)', () => {
  const before = hive([A, B]);
  const frozen = structuredClone(before);
  const { state, effects } = copyTo(before, { activityId: activityIdOf('local:2') });
  const spawn = spawnOf(effects);
  const worker = state.workers.at(-1)!;
  assert.deepEqual(before, frozen, 'the input is not mutated');
  assert.deepEqual([taskOfWorker(state, worker)?.item.itemId, worker.freeSession, worker.tokens, worker.copyOf], ['local:2', true, 1200, { from: SOURCE, dir: DIR }]); // #629: the task's activity
  assert.deepEqual([spawn.task?.item.itemId, spawn.continues, spawn.copy, spawn.sessionId], ['local:2', false, { from: SOURCE, name: 'no dois', notice: 'Hive: moved' }, worker.sessionId]);
  assert.deepEqual(sessionsOf(state, 'local:2').map((s) => [s.id, s.name, s.tokens, s.stages, s.free]), [[worker.sessionId, 'no dois', 1200, [], true]], 'a copy runs no stage (#812)');
  assert.equal(activityOf(state, 'local:2')?.sessionId, undefined, 'a free session never becomes the stage run\'s');
  assert.deepEqual([state.tasks.find((c) => c.item.itemId === 'local:1'), sessionsOf(state, 'local:1')], [A, [session()]]);
});

test('a copy into a workspace\'s local appends a local session with no stage, in a worker of the workspace with no task; a copy with no temporary file carries no mark (#587)', () => {
  const before = hive([A, B]);
  const frozen = structuredClone(before);
  const { state, effects } = copyTo(before, { activityId: localActivityId('hive') }, { copied: undefined, notice: undefined });
  const worker = state.workers.at(-1)!;
  const spawn = spawnOf(effects);
  assert.deepEqual(before, frozen, 'the input is not mutated');
  assert.deepEqual([worker.activityId, worker.copyOf], [localActivityId('hive'), undefined]); // #629: the workspace's local activity, no task
  assert.deepEqual([spawn.activity.workspace, spawn.task, spawn.copy], ['hive', undefined, { from: SOURCE, name: 'no dois' }]);
  assert.deepEqual(localSessionsOf(state, 'hive').map((s) => [s.id, s.name, s.stages, s.tokens]), [[worker.sessionId, 'no dois', [], 1200]]);
});

test('copySession refuses in silence: the source\'s own task or own local, a task with no directory or one being cleaned, an unknown session, task or workspace (#587)', () => {
  const state = hive([A, B, task(3), task(4), task(5)], {}, { 'local:3': { worktree: undefined }, 'local:4': { worktreeGone: true }, 'local:5': { deleting: true } });
  for (const to of [{ activityId: activityIdOf('local:1') }, { activityId: activityIdOf('local:3') }, { activityId: activityIdOf('local:4') }, { activityId: activityIdOf('local:5') }, { activityId: 'nope' }, { activityId: localActivityId('nope') }]) {
    assert.equal(copyTo(state, to).state, state, JSON.stringify(to));
  }
  assert.equal(reduce(state, { type: 'copySession', from: { activityId: activityIdOf('local:1'), sessionId: 'b1b2c3d4-0000-4000-8000-000000000009' }, to: { activityId: activityIdOf('local:2') } }).state, state);
  const local = withLocal(state, 'hive', [session({ stages: [] })]);
  assert.equal(reduce(local, { type: 'copySession', from: { activityId: localActivityId('hive'), sessionId: SOURCE }, to: { activityId: localActivityId('hive') } }).state, local, 'its own local');
});

test('the copy\'s SessionStart drops the mark and removes the temporary transcript, once; a copy with no mark never does (#587)', () => {
  const copied = copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }).state;
  const { runId: ptyId, sessionId } = copied.workers.at(-1)!;
  const start = { type: 'hook' as const, ptyId: ptyId!, payload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: worktreeOf(2) } };
  const started = reduce(copied, start);
  assert.deepEqual(started.effects, [{ type: 'dropCopiedTranscript', dir: DIR, sessionId: SOURCE }]);
  assert.equal(started.state.workers.at(-1)!.copyOf, undefined);
  assert.deepEqual(reduce(started.state, start).effects, [], 'settled already');
  const unmarked = copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }, { copied: undefined }).state;
  assert.deepEqual(reduce(unmarked, { ...start, ptyId: unmarked.workers.at(-1)!.runId! }).effects, []);
});

test('a copy that ends before its SessionStart removes the temporary transcript too; a local copy that failed to spawn forgets its entry (#587)', () => {
  const copied = copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }).state;
  const exited = reduce(copied, { type: 'exit', ptyId: copied.workers.at(-1)!.runId! });
  assert.deepEqual(exited.effects.filter((e) => e.type === 'dropCopiedTranscript'), [{ type: 'dropCopiedTranscript', dir: DIR, sessionId: SOURCE }]);
  const local = copyTo(hive([A, B]), { activityId: localActivityId('hive') }).state;
  const failed = reduce(local, { type: 'spawnFailed', ptyId: local.workers.at(-1)!.runId!, message: 'pty: no' });
  assert.deepEqual([localSessionsOf(failed.state, 'hive'), failed.state.error], [[], 'pty: no']);
  assert.deepEqual(failed.effects.filter((e) => e.type === 'dropCopiedTranscript').length, 1);
});

test('openLocalSession continues a local session no run holds, from its tokens; clearLocalSession forgets one no run holds; both refuse a live one and an unknown one (#587)', () => {
  const kept = session({ stages: [], name: 'no main' });
  const state = withLocal(hive([]), 'hive', [kept]);
  const frozen = structuredClone(state);
  const { state: opened, effects } = reduce(state, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE });
  const worker = opened.workers.at(-1)!;
  assert.deepEqual(state, frozen, 'the input is not mutated');
  assert.deepEqual([worker.activityId, worker.sessionId, worker.tokens, worker.freeSession], [localActivityId('hive'), SOURCE, 1200, true]);
  assert.deepEqual(effects.map((e) => (e.type === 'spawnSession' ? [e.activity.workspace, e.sessionId, e.continues, e.copy] : e.type)), [['hive', SOURCE, true, undefined]]);
  assert.equal(reduce(opened, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE }).state, opened, 'held by its run');
  assert.equal(reduce(opened, { type: 'clearLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE }).state, opened, 'held by its run');
  assert.deepEqual(localSessionsOf(reduce(state, { type: 'clearLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE }).state, 'hive'), []);
  assert.equal(reduce(state, { type: 'openLocalSession', activityId: localActivityId('site'), sessionId: SOURCE }).state, state, 'not listed there');
  assert.equal(reduce(state, { type: 'clearLocalSession', activityId: localActivityId('site'), sessionId: SOURCE }).state, state, 'not listed there');
});

test('a turn end on a local run writes its total and its /rename title into its local entry and counts only its delta (#587)', () => {
  const state = withLocal(hive([]), 'hive', [session({ stages: [] })]);
  const opened = reduce(state, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE }).state;
  const turned = stop(opened, 1500, 'renamed');
  assert.deepEqual(localSessionsOf(turned, 'hive').map((s) => [s.tokens, s.name]), [[1500, 'renamed']]);
  assert.deepEqual(turned.usage.map((u) => u.tokens), [300]);
});

test('a copy\'s turn ends read back the name its first run gave the fork, and a later /rename names it, into a task and into local (#587)', () => {
  const named = (s: State, to: SessionTarget) => recordOf(s, to.activityId)!.sessions.at(-1)!; // #629: the target's record
  for (const to of [{ activityId: activityIdOf('local:2') }, { activityId: localActivityId('hive') }]) {
    const copied = copyTo(hive([A, B]), to).state;
    assert.equal('inheritedTitle' in named(copied, to), false, 'the transcript\'s title is the chosen name: nothing to skip');
    const kept = stop(copied, 1300, 'no dois');
    assert.deepEqual([named(kept, to).name, named(kept, to).tokens], ['no dois', 1300], JSON.stringify(to));
    assert.equal(named(stop(kept, 1400, 'mine'), to).name, 'mine', JSON.stringify(to));
  }
  const unnamed = spawnOf(copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }, { name: undefined }).effects);
  assert.deepEqual(unnamed.copy, { from: SOURCE, notice: 'Hive: moved' }, 'no name: the fork keeps the source\'s title');
});

test('a copy into a task puts the task on top of its stage, as every run opened on it (#356, #587)', () => {
  const C = task(3);
  const state = hive([A, C, B]);
  assert.deepEqual(copyTo(state, { activityId: activityIdOf('local:2') }).state.tasks.map((c) => c.item.itemId), ['local:2', 'local:1', 'local:3']);
});

test('copyPending names only a live copy\'s run whose temporary transcript of that source sits in that dir (#587)', () => {
  const marked = copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }).state;
  assert.equal(copyPending(marked.workers, SOURCE, DIR), true);
  assert.equal(copyPending(marked.workers, SOURCE, '/claude/projects/-repo'), false, 'another dir');
  assert.equal(copyPending(marked.workers, 'b1b2c3d4-0000-4000-8000-000000000009', DIR), false, 'another source');
  assert.equal(copyPending(marked.workers.map((s) => ({ ...s, status: 'empty' as const })), SOURCE, DIR), false, 'no live run');
  assert.equal(copyPending(marked.workers, SOURCE, undefined), false, 'an agent with no transcript dir has no copy pending in one (#929)');
});

test('boot removes the temporary transcript of every copy whose run it closes, and the marks go (#587)', () => {
  const copied = copyTo(hive([A, B]), { activityId: activityIdOf('local:2') }).state;
  const booted = reduce(copied, { type: 'boot' });
  assert.deepEqual(booted.effects.filter((e) => e.type === 'dropCopiedTranscript'), [{ type: 'dropCopiedTranscript', dir: DIR, sessionId: SOURCE }]);
  assert.ok(booted.state.workers.every((s) => s.copyOf === undefined));
  assert.deepEqual(reduce(hive([A, B]), { type: 'boot' }).effects, []);
});

test('the exit of a local run that never opened forgets the entry its copy appended; one that saw a hook, or a continued session, keeps it (#587)', () => {
  const local = copyTo(hive([A, B]), { activityId: localActivityId('hive') }).state;
  const ptyId = local.workers.at(-1)!.runId!;
  assert.deepEqual(localSessionsOf(reduce(local, { type: 'exit', ptyId }).state, 'hive'), []);
  const started = reduce(local, { type: 'hook', ptyId, payload: { hook_event_name: 'SessionStart' } }).state;
  assert.equal(localSessionsOf(reduce(started, { type: 'exit', ptyId }).state, 'hive').length, 1);
  const kept = withLocal(hive([]), 'hive', [session({ stages: [] })]);
  const continued = reduce(kept, { type: 'openLocalSession', activityId: localActivityId('hive'), sessionId: SOURCE }).state;
  assert.equal(localSessionsOf(reduce(continued, { type: 'exit', ptyId: continued.workers.at(-1)!.runId! }).state, 'hive').length, 1);
});
