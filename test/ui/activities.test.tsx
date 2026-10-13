import { expect, test } from 'vitest';
import { renderHook } from '@testing-library/react';
import { mainRef, useCenterLayouts } from '@/hooks/use-center-layouts';
import { activitiesOf, activityKey, isTask, type LocalActivity, type TaskActivity } from '@/lib/activities';
import { readView, resetViewState } from '@/lib/view-state';
import type { Task, Session, SleptRun, Stage, Terminal, Worker } from '../../src/types';
import { activityIdOf, localPairOf, localPairs, movedWork, withLocal, withPointedWork, withWork, type WithWork } from '../fixtures/work';
import { initialState } from '../../src/orchestrator';
import { localActivityId } from '../../src/activities';

const T0 = '2026-09-27T10:00:00.000Z';
const task = (n: number): WithWork => ({ item: { itemId: `I${n}`, id: String(n), title: `Task ${n}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true });
const TASKS = [task(1), task(2), task(3)];
const worker = (id: string, taskId: string, extra: Partial<Worker> = {}): Worker => ({ id, status: 'working', activityId: activityIdOf(taskId), runId: `W-${id}`, ...extra });
const terminal = (terminalId: string, taskId: string, command?: string): Terminal => ({ terminalId, activityId: activityIdOf(taskId), startedAt: T0, cwd: '/repo', command });
const of = (workers: Worker[], terminals: Terminal[] = []): TaskActivity[] => activitiesOf(withPointedWork({ tasks: TASKS, workers, terminals, workspaces: [], activities: [], activityRecords: [] })).filter(isTask);
const ids = (list: TaskActivity[]): string[] => list.map((activity) => activity.task.item.itemId);

test('a task with no live run is left out, a worker with no worker yet included; the rest keep the board order, not the workers\' (#457)', () => {
  expect(ids(of([worker('s3', 'I3'), worker('s1', 'I1'), worker('s2', 'I2', { runId: undefined })]))).toEqual(['I1', 'I3']);
});

test('a run command alone makes no activity and a project shell never does; a plain terminal does, its runs the workers first then the terminals (#457)', () => {
  const projectShell: Terminal = { terminalId: 'P1', activityId: localActivityId('hive'), startedAt: T0, cwd: '/repo' };
  expect(of([], [terminal('C1', 'I1', 'test'), projectShell])).toEqual([]);
  const [only] = of([worker('s2', 'I2', { sessionId: 'abcdef123456' })], [terminal('C1', 'I1', 'test'), terminal('S2', 'I2')]);
  expect(only.task.item.itemId).toBe('I2');
  expect(only.runs).toEqual([{ ptyId: 'W-s2', label: 'Claude · abcdef12', kind: 'stage', agent: 'claude', session: 'abcdef12' }, { ptyId: 'S2', label: 'Terminal', kind: 'terminal' }]);
});

test('status is the most urgent of the task\'s workers, and empty for a task with terminals only (#457)', () => {
  const list = of([worker('s1', 'I1'), worker('s2', 'I1', { status: 'waiting', freeSession: true })], [terminal('S2', 'I2')]);
  expect(list.map((activity) => activity.status)).toEqual(['waiting', 'empty']);
});

test('worker is true only when one of the task\'s workers is not a free session (#457)', () => {
  const list = of([worker('s1', 'I1', { freeSession: true }), worker('s2', 'I2', { freeSession: true }), worker('s3', 'I2')], [terminal('S3', 'I3')]);
  expect(list.map((activity) => [activity.task.item.itemId, activity.worker])).toEqual([['I1', false], ['I2', true], ['I3', false]]);
});

test('startedAt is the oldest of the task\'s workers, and none for a task with terminals only (#457)', () => {
  const list = of([worker('s1', 'I1', { startedAt: '2026-09-27T10:05:00.000Z' }), worker('s2', 'I1', { startedAt: '2026-09-27T10:01:00.000Z' })], [terminal('S2', 'I2')]);
  expect(list.map((activity) => activity.startedAt)).toEqual(['2026-09-27T10:01:00.000Z', undefined]);
});

test('lastStartedAt is the newest of the task\'s workers, and none for a task with terminals only (#586)', () => {
  const list = of([worker('s1', 'I1', { startedAt: '2026-09-27T10:05:00.000Z' }), worker('s2', 'I1', { startedAt: '2026-09-27T10:01:00.000Z' })], [terminal('S2', 'I2')]);
  expect(list.map((activity) => activity.lastStartedAt)).toEqual(['2026-09-27T10:05:00.000Z', undefined]);
});

test('a task with its worktree on disk is an activity with nothing running; a gone worktree is not (redesign 03)', () => {
  const tasks = [{ ...task(1), worktree: '/w/1' }, { ...task(2), worktree: '/w/2', worktreeGone: true as const }, task(3)];
  const list = activitiesOf(movedWork({ tasks, workers: [], terminals: [], workspaces: [], activities: [], activityRecords: [] })).filter(isTask); // #629: on each task's activity
  expect(ids(list)).toEqual(['I1']);
  expect(list[0].runs).toEqual([]);
  expect(list[0].sessions).toEqual([]);
});

test('sessions are the agent runs with their own worker\'s status, the terminals left out (redesign 03)', () => {
  const [only] = of([worker('s1', 'I1', { status: 'waiting' }), worker('s2', 'I1', { freeSession: true })], [terminal('S1', 'I1')]);
  expect(only.sessions.map((s) => [s.run?.ptyId, s.status])).toEqual([['W-s1', 'waiting'], ['W-s2', 'working']]);
});

test('one local activity per workspace comes first, in the config\'s order, with its live runs, its agent sessions and each kept session with the run continuing it (#590)', () => {
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const kept = { id, startedAt: T0, stages: [], agent: 'claude' as const, lastUsedAt: T0, name: 'fix login' };
  const other = { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302', startedAt: T0, stages: [], agent: 'claude' as const, lastUsedAt: T0 };
  const workers: Worker[] = [{ id: 's9', status: 'waiting', activityId: localActivityId('hive'), freeSession: true, runId: 'L1', sessionId: id }, worker('s1', 'I1')];
  const terminals: Terminal[] = [{ terminalId: 'P1', activityId: localActivityId('hive'), startedAt: T0, cwd: '/repo' }];
  // #629: each workspace's local activity and record, as withLocalActivities keeps them in state
  const [hive, site] = [localPairOf('hive', [kept, other]), localPairOf('site')];
  const list = activitiesOf(withPointedWork({ tasks: TASKS, workers, terminals, workspaces: ['hive', 'site'], activities: [hive.activity, site.activity], activityRecords: [hive.record, site.record] }));
  expect(list.map(activityKey)).toEqual(['local/hive', 'local/site', 'I1']);
  const run = { ptyId: 'L1', label: 'Claude · fix login', kind: 'session', agent: 'claude', session: 'fix login' };
  expect(list[0]).toEqual({
    kind: 'local', ...hive, workspace: 'hive', runs: [run, { ptyId: 'P1', label: 'Terminal', kind: 'terminal' }], sessions: [{ run, status: 'waiting', sessionId: id }],
    kept: [{ session: kept, run, status: 'waiting' }, { session: other, status: 'empty' }], slept: [], // #672: none asleep
    terminals: [{ terminalId: 'P1', label: 'Terminal', asleep: false }], sleeping: false, // #696
  });
  expect(list[1]).toEqual({ kind: 'local', ...site, workspace: 'site', runs: [], sessions: [], kept: [], slept: [], terminals: [], sleeping: false });
});

test('activityKey is a task\'s item id, or local/<workspace> for a local activity (#590)', () => {
  expect(activityKey({ kind: 'task', task: task(1), activity: { id: 'a-I1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1' } })).toBe('I1');
  expect(activityKey({ kind: 'local', workspace: 'hive', activity: localPairOf('hive').activity })).toBe('local/hive');
});

test('a local activity\'s center layout is stored under local/<workspace> (#590)', () => {
  resetViewState();
  const local: LocalActivity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [{ ptyId: 'P1', label: 'Terminal', kind: 'terminal' }], sessions: [], kept: [] };
  const request = { tab: { kind: 'run' as const, ptyId: 'P1' } }; // one object: a new one on every render would apply again and again
  renderHook(() => useCenterLayouts([local], local, request));
  expect(Object.keys(readView('centerLayouts') as object)).toEqual(['local/hive']);
});

const A = '11111111-0000-4000-8000-000000000001';
const B = '22222222-0000-4000-8000-000000000002';
const kept = (id: string, extra: Partial<Session> = {}): Session => ({ id, startedAt: T0, stages: ['dev'], agent: 'claude' as const, lastUsedAt: T0, ...extra });
// Task 1's kept sessions, in its record (#629)
const tasks = (tasks: Task[], workers: Worker[], sessions: Session[] = []): TaskActivity[] =>
  activitiesOf(withPointedWork({ tasks, workers, terminals: [], workspaces: [], activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions }] })).filter(isTask);
const rows = (activity: TaskActivity): unknown[][] => activity.sessions.map((s) => [s.session?.id, s.run?.ptyId, s.status]);

test('a task activity lists every kept session oldest first: the one a live run holds with that run\'s status, the rest sleeping (empty) (#614)', () => {
  const withSessions: WithWork = { ...task(1), worktree: '/w/1' };
  const [only] = tasks([withSessions], [worker('s1', 'I1', { status: 'waiting', freeSession: true, sessionId: B })], [kept(A), kept(B)]);
  expect(rows(only)).toEqual([[A, undefined, 'empty'], [B, 'W-s1', 'waiting']]);
});

test('a live agent run whose session is not kept yet comes after the kept ones; a stage run holds task.sessionId before its SessionStart (#614)', () => {
  const withSessions: WithWork = { ...task(1), worktree: '/w/1', sessionId: A };
  const [only] = tasks([withSessions], [worker('s1', 'I1'), worker('s2', 'I1', { freeSession: true })], [kept(A)]);
  expect(rows(only)).toEqual([[A, 'W-s1', 'working'], [undefined, 'W-s2', 'working']]);
});

test('a session of a removed worktree (repo) is listed like the others (#614)', () => {
  const removed: Task = task(1);
  const [only] = tasks([removed], [worker('s1', 'I1', { freeSession: true, sessionId: B })], [kept(A, { repo: true })]);
  expect(rows(only)).toEqual([[A, undefined, 'empty'], [undefined, 'W-s1', 'working']]);
});

test('a task with kept sessions but no worktree and no live run is not an activity (#614)', () => {
  expect(tasks([task(1)], [], [kept(A), kept(B)])).toEqual([]);
});

test('activitiesOf builds every activity from state.activities: each local one with its activity and record, each task one with its task (#629)', () => {
  const plain = { ...initialState(0), workspaces: ['hive'], tasks: [task(1), task(2)] };
  const state = withWork(withLocal(plain, 'hive'), 'I1', { worktree: '/w/1' });
  const [local, first, ...rest] = activitiesOf(state);
  if (local.kind !== 'local' || first?.kind !== 'task') throw new Error('a local activity, then a task one');
  expect([local.activity.id, local.record.id, local.workspace]).toEqual([localActivityId('hive'), localActivityId('hive'), 'hive']);
  expect([first.activity.id, first.record.taskIds, first.task.item.itemId]).toEqual(['a-I1', ['I1'], 'I1']);
  expect(rest).toEqual([]); // task 2 has no activity: nothing to list
  expect(activityKey(first)).toBe('I1');
});

test('a held worker\'s session is listed empty, so its line reads sleeping, and the activity takes the task\'s approval (#663)', () => {
  const held: WithWork = { ...task(1), worktree: '/w/1', approval: { since: T0 } };
  const [only] = tasks([held], [worker('s1', 'I1', { status: 'approval', sessionId: A })], [kept(A)]);
  expect(rows(only)).toEqual([[A, 'W-s1', 'empty']]);
  expect(only.status).toBe('approval');
});

test('a task\'s and a workspace\'s sleeping runs are listed apart from their live runs, named by their session as their run was (#672)', () => {
  const S = 'abcdef12-0000-4000-8000-000000000002';
  const sleepy: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt' };
  const slept: SleptRun[] = [
    { ptyId: 'W2', sessionId: S, agent: 'claude', kind: 'session', taskId: 'I1', cause: 'manual', at: 1 },
    { ptyId: 'W5', sessionId: 'fedcba98-0000-4000-8000-000000000005', agent: 'claude', kind: 'session', workspace: 'hive', at: 2 },
  ];
  const pairs = localPairs(['hive']);
  const [local, own] = activitiesOf(withPointedWork({ tasks: [sleepy], workers: [], terminals: [], workspaces: ['hive'], ...pairs, slept }));
  expect(own?.runs).toEqual([]);
  expect(own?.slept).toEqual([{ run: { ptyId: 'W2', label: 'Claude · abcdef12', kind: 'session', agent: 'claude', session: 'abcdef12' }, sessionId: S, cause: 'manual' }]);
  expect(local?.slept?.map((s) => s.run.ptyId)).toEqual(['W5']);
});

test('an activity lists the terminals it keeps, numbered among them, and sleeps once it keeps something and nothing is live (#696)', () => {
  const kept = (terminals: Terminal[]): TaskActivity[] =>
    activitiesOf(movedWork({ tasks: [{ ...task(1), worktree: '/w/1' }], workers: [], terminals, workspaces: [], activities: [], activityRecords: [] })).filter(isTask);
  const asleep: Terminal = { ...terminal('S1', 'I1'), asleep: true };
  const [both] = kept([asleep, terminal('S2', 'I1')]);
  expect([both.terminals, both.sleeping]).toEqual([[
    { terminalId: 'S1', label: 'Terminal 1', n: 1, asleep: true }, { terminalId: 'S2', label: 'Terminal 2', n: 2, asleep: false },
  ], false]);
  const [sleeping] = kept([asleep]);
  expect([sleeping.terminals, sleeping.sleeping]).toEqual([[{ terminalId: 'S1', label: 'Terminal', asleep: true }], true]);
  expect(kept([]).map((activity) => activity.sleeping)).toEqual([false]);
});

test('the first pick never shows a captured run, which has no pty of its own: its terminal instead (#696)', () => {
  const captured = { ptyId: 'R1', label: 'Claude', kind: 'session' as const, terminalId: 'T1' };
  const shell = { ptyId: 'T1', label: 'Terminal', kind: 'terminal' as const };
  expect(mainRef({ kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [captured, shell], sessions: [], kept: [] })).toEqual({ kind: 'run', ptyId: 'T1' });
});

test('an activity waiting for CI is listed with no run, so the waiting task shows in the bar (#834)', () => {
  const waiting: WithWork = { ...task(1), ci: { stage: 'ci', since: T0, reran: [] } };
  const listed = activitiesOf(withPointedWork({ tasks: [waiting, task(2)], workers: [], terminals: [], workspaces: [], activities: [], activityRecords: [] })).filter(isTask);
  expect(ids(listed)).toEqual(['I1']);
});

test('an activity whose only run slept before its first prompt sleeps: the run keeps no session yet (#931)', () => {
  const sleepy: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt' };
  const slept: SleptRun[] = [
    { ptyId: 'W2', agent: 'codex', kind: 'session', taskId: 'I1', cause: 'manual', at: 1 },
    { ptyId: 'W5', agent: 'codex', kind: 'session', workspace: 'hive', cause: 'manual', at: 2 },
  ];
  const [local, own] = activitiesOf(withPointedWork({ tasks: [sleepy], workers: [], terminals: [], workspaces: ['hive'], ...localPairs(['hive']), slept }));
  expect([own?.sleeping, local?.sleeping]).toEqual([true, true]);
});

test('a task queued in its prompt stage, with a handover, an open PR, no worker and auto on, is not review once the stages are given; without them it still reads review (#264)', () => {
  const queued: WithWork = { ...task(1), worktree: '/w/1', handover: { prompt: 'CI failed' } };
  const record = { id: 'a-I1', taskIds: ['I1'], sessions: [], prs: [{ url: 'https://github.com/o/r/pull/7', state: 'open' as const }] };
  const slice = movedWork({ tasks: [queued], workers: [], terminals: [], workspaces: [], activities: [], activityRecords: [record] });
  const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
  expect(activitiesOf(slice).filter(isTask).map((a) => a.status)).toEqual(['review']);
  expect(activitiesOf({ ...slice, stages }).filter(isTask).map((a) => a.status)).toEqual(['empty']);
});
