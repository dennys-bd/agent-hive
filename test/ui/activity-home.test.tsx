import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import type { KeptTerminal, LocalActivity, TaskActivity } from '@/lib/activities';
import { homeSessions, homeTerminals, metaTime } from '@/lib/activity-home';
import { urgencyIndex } from '@/lib/status';
import type { LiveRun } from '../../src/task-runs';
import type { Session, Task } from '../../src/types';
import { localPairOf, taskPairOf } from '../fixtures/work';

// Noon of 2026-10-06 in the machine's own zone: metaTime compares calendar days locally, as relativeTime does
const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();
const session = (n: number, lastUsedAt: string, stages = ['dev']): Session => ({ id: `0000000${n}-0000-4000-8000-000000000000`, startedAt: lastUsedAt, stages, lastUsedAt, agent: 'claude' });
const run = (ptyId: string, name?: string): LiveRun => ({ ptyId, label: 'Claude', kind: 'session', ...(name === undefined ? {} : { session: name }) });
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const taskOf = (sessions: TaskActivity['sessions'], terminals: KeptTerminal[] = []): TaskActivity => ({
  kind: 'task', ...taskPairOf('I1'), task, runs: [], sessions, terminals, status: 'empty', worker: false,
});

beforeEach(() => setLanguage('pt'));

test('urgencyIndex follows mostUrgent\'s rank and puts empty after every other status (#759)', () => {
  expect((['waiting', 'approval', 'review', 'backoff', 'working', 'empty'] as const).map((status) => urgencyIndex(status))).toEqual([0, 1, 2, 3, 4, 5]);
});

test('sessions sort by urgency, then the newest last use first, a live run not kept yet before the kept ones of its status (#759)', () => {
  const old = session(1, at(4, 9));
  const recent = session(2, at(5, 9));
  const working = session(3, at(6, 8));
  const waiting = session(4, at(6, 7));
  const rows = homeSessions(taskOf([
    { session: old, status: 'empty' },
    { session: working, run: run('W3'), status: 'working' },
    { session: recent, status: 'empty' },
    { session: waiting, run: run('W4'), status: 'waiting' },
    { run: run('W5', 'abcdef12'), status: 'waiting' },
  ]), NOW);
  expect(rows.map((row) => row.key)).toEqual(['W5', waiting.id, working.id, recent.id, old.id]);
  expect(rows.map((row) => row.action)).toEqual(['open', 'open', 'open', 'continue', 'continue']);
});

test('a row\'s meta is the name or short id, the last stage and the time; a part with no value is left out with its separator (#759)', () => {
  const kept = session(1, at(6, 4, 46), ['spec', 'dev']);
  const rows = homeSessions(taskOf([{ session: kept, status: 'empty' }, { run: run('W5', 'abcdef12'), status: 'working' }, { run: run('W6'), status: 'working' }]), NOW);
  expect(rows.map((row) => row.meta)).toEqual([['abcdef12'], [], ['00000001', 'dev', '04:46']]);
});

test('a free session\'s meta names it a free session, before a stage a feedback run gave it; a stage run\'s names its last stage (#812)', () => {
  const ran = session(1, at(6, 4, 46), ['spec']);
  const free: Session = { ...session(2, at(6, 4, 40), []), free: true };
  const answered: Session = { ...session(3, at(6, 4, 30), ['spec']), free: true };
  const rows = homeSessions(taskOf([{ session: ran, status: 'empty' }, { session: free, status: 'empty' }, { session: answered, status: 'empty' }]), NOW);
  expect(rows.map((row) => row.meta)).toEqual([['00000001', 'spec', '04:46'], ['00000002', 'sessão livre', '04:40'], ['00000003', 'sessão livre', 'spec', '04:30']]);
});

test('a session a run holds opens that run whatever its status, a captured one through its terminal; a sleeping one continues its session (#759)', () => {
  const held = session(1, at(6, 9)); // a held approval run: its session reads sleeping, its run is live (#663)
  const asleep = session(2, at(5, 9));
  const rows = homeSessions(taskOf([
    { session: held, run: run('W2'), status: 'empty' }, { session: asleep, status: 'empty' }, { run: { ...run('W7'), terminalId: 'T7' }, status: 'working' },
  ]), NOW);
  expect(rows.map((row) => [row.status, row.action, row.target])).toEqual([
    ['working', 'open', { kind: 'run', ptyId: 'T7' }],
    ['empty', 'open', { kind: 'run', ptyId: 'W2' }],
    ['empty', 'continue', { kind: 'session', session: asleep }],
  ]);
});

test('metaTime is HH:MM for a time today, else relativeTime\'s text (#759)', () => {
  expect(metaTime(at(6, 4, 46), NOW)).toBe('04:46');
  expect(metaTime(at(5, 23, 10), NOW)).toBe('ontem');
  expect(metaTime(at(3, 9), NOW)).toBe('há 3 dias');
});

test('a local activity lists its kept sessions with their live run, then its live runs not kept yet; a local session has no stage in its meta (#759)', () => {
  const live = session(1, at(6, 8), []);
  const asleep = session(2, at(6, 7), []);
  const captured: LiveRun = { ...run('W1', '00000001'), terminalId: 'T1' };
  const unkept = run('W2');
  const activity: LocalActivity = {
    kind: 'local', ...localPairOf('hive', [live, asleep]), workspace: 'hive', runs: [captured, unkept],
    sessions: [{ run: captured, status: 'working' }, { run: unkept, status: 'working' }],
    kept: [{ session: live, run: captured, status: 'working' }, { session: asleep, status: 'empty' }],
  };
  expect(homeSessions(activity, NOW).map((row) => [row.key, row.meta, row.action, row.target])).toEqual([
    ['W2', [], 'open', { kind: 'run', ptyId: 'W2' }],
    [live.id, ['00000001', '08:00'], 'open', { kind: 'session', session: live, live: { runId: 'W1', terminalId: 'T1' } }],
    [asleep.id, ['00000002', '07:00'], 'continue', { kind: 'session', session: asleep }],
  ]);
});

test('terminals list the live ones first, then by their number; none listed reads as none (#759)', () => {
  const terminals: KeptTerminal[] = [
    { terminalId: 'T1', label: 'Terminal 1', n: 1, asleep: true },
    { terminalId: 'T3', label: 'Terminal 3', n: 3, asleep: false },
    { terminalId: 'T2', label: 'Terminal 2', n: 2, asleep: false },
  ];
  expect(homeTerminals(taskOf([], terminals)).map((terminal) => terminal.terminalId)).toEqual(['T2', 'T3', 'T1']);
  expect(homeTerminals({ ...taskOf([]), terminals: undefined })).toEqual([]);
});
