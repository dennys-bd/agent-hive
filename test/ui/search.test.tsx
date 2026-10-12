import { expect, test } from 'vitest';
import type { Task, Session, Worker } from '../../src/types';
import { activitiesOf } from '@/lib/activities';
import type { OperationView } from '@/lib/operations';
import { fuzzyRanges, matchTask, nextScope, parseQuery, type SearchGroup, type SearchInput, searchGroups } from '@/lib/search';
import { recordFor, stateOf, task } from './search-fixtures';
import { activityIdOf, type WithWork } from '../fixtures/work';

const at = '2026-09-28T10:00:00.000Z';
const sessions = (id: string, lastUsedAt: string): Session[] => [{ id, startedAt: lastUsedAt, stages: ['dev'], lastUsedAt, agent: 'claude' }];
const ids = (groups: SearchGroup[]): [string, string[]][] => groups.map((group) => [group.id, group.rows.map((row) => {
  if (row.kind === 'activity') return `a:${row.activity.task.item.id}`;
  return row.kind === 'task' ? `t:${row.task.item.id}` : `o:${row.view.label}`;
})]);
const view = (label: string, target?: string): OperationView => ({
  operation: { id: label, group: 'global', label: () => label, available: () => true }, label, target, isDisabled: false, isChecked: false,
});
const inputOf = (tasks: Task[], workers: Worker[] = [], extra: Partial<SearchInput> = {}): SearchInput => {
  const activityRecords = extra.activityRecords ?? [];
  const state = stateOf(tasks, { workers, activityRecords }); // #629: each run's activity and record
  return { scope: 'all', query: '', tasks: state.tasks, workers, liveActivities: state.activities, activityRecords: state.activityRecords, activities: activitiesOf(state), operations: [], ...extra };
};

test('a # or > typed first picks tarefas or comandos and leaves the field; nextScope cycles both ways (#584)', () => {
  expect(parseQuery('#466', 'all')).toEqual({ scope: 'tasks', query: '466' });
  expect(parseQuery('>sinal', 'activities')).toEqual({ scope: 'commands', query: 'sinal' });
  expect(parseQuery('daemon #2', 'all')).toEqual({ scope: 'all', query: 'daemon #2' });
  expect([nextScope('all', 1), nextScope('commands', 1), nextScope('all', -1)]).toEqual(['activities', 'all', 'commands']);
});

test('fuzzyRanges: one range for a substring, one per run of a subsequence, none for a blank query, undefined for no match (#584)', () => {
  expect(fuzzyRanges('#466 The daemon binds', 'DAEMON')).toEqual([[9, 15]]);
  expect(fuzzyRanges('#466 The daemon binds', 'thdb')).toEqual([[5, 7], [9, 10], [16, 17]]);
  expect(fuzzyRanges('anything', '  ')).toEqual([]);
  expect(fuzzyRanges('daemon', 'dz')).toBeUndefined();
});

// #629: the branch is the live activity's, which the caller reads
const match = (c: WithWork, query: string, sessions: Session[]) => matchTask(c, c.branch ?? '', query, sessions);

test('matchTask reads the number and the title, drawn, then the branch and the session ids, not drawn and ranked last (#584)', () => {
  const daemon = task('466', 'The daemon binds a free port', { branch: 'hive/466-daemon-port' });
  const kept = sessions('5e6b7939-0000-4000-8000-000000000001', at); // #629: the task's sessions come from its records
  expect(match(daemon, '466', kept)).toEqual({ ranges: [[1, 4]], score: 1 });
  expect(match(daemon, 'daemon-port', kept)).toEqual({ ranges: [], score: 100 });
  expect(match(daemon, '5e6b79', kept)).toEqual({ ranges: [], score: 100 });
  expect(match(daemon, 'zzz', kept)).toBeUndefined();
  expect(match(daemon, 'v46dp', kept)).toBeUndefined(); // only a subsequence of the branch: a hidden field matches by substring alone
  expect(match(daemon, '5e7939', kept)).toBeUndefined();
  expect(match(task('SITE-4', 'Landing', { created: true }), 'site-4', [])).toEqual({ ranges: [[0, 6]], score: 1 });
});

test('in tudo each group shows 3 at most and a task with an activity only under atividades; a filtered scope shows 20; a substring outranks a subsequence (#584)', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(String(i + 1), `Task ${i + 1}`, i < 4 ? { worktree: `/w/${i + 1}` } : {}));
  expect(ids(searchGroups(inputOf(tasks, [], { query: 'task' })))).toEqual([['activities', ['a:1', 'a:2', 'a:3']], ['tasks', ['t:5', 't:6', 't:7']]]);
  expect(searchGroups(inputOf(tasks, [], { scope: 'tasks', query: 'task' }))[0].rows).toHaveLength(20);
  expect(ids(searchGroups(inputOf(tasks, [], { scope: 'activities', query: 'task' })))).toEqual([['activities', ['a:1', 'a:2', 'a:3', 'a:4']]]);
  expect(ids(searchGroups(inputOf([task('1', 'T-a-s-k'), task('2', 'Task')], [], { query: 'task' })))).toEqual([['tasks', ['t:2', 't:1']]]);
});

test('comandos match an operation by its label, then by its target without drawing it; in tudo they come after the tasks (#584)', () => {
  const operations = [view('executar dev', 'hive · #11'), view('ir para fluxo'), view('sinal')];
  expect(ids(searchGroups(inputOf([task('11', 'Fluxo antigo')], [], { query: 'fluxo', operations })))).toEqual([['tasks', ['t:11']], ['commands', ['o:ir para fluxo']]]);
  const byTarget = searchGroups(inputOf([], [], { scope: 'commands', query: 'hive', operations }));
  expect(ids(byTarget)).toEqual([['commands', ['o:executar dev']]]);
  expect(byTarget[0].rows[0].ranges).toEqual([]);
});

test('an empty field shows recentes and precisam de você, one row per activity; tarefas keeps the recent tasks; comandos lists every operation (#584)', () => {
  const live = task('1', 'Live', { worktree: '/w/1' });
  const idle = task('2', 'Idle');
  const activityRecords = [recordFor('I1', { sessions: sessions('s-1', '2026-09-28T10:00:00.000Z') }), recordFor('I2', { sessions: sessions('s-2', '2026-09-28T11:00:00.000Z') })];
  const workers: Worker[] = [{ id: 'a', activityId: activityIdOf('I1'), status: 'waiting', runId: 'W1', waitingSince: at }, { id: 'b', activityId: activityIdOf('I1'), status: 'approval', runId: 'W2' }];
  expect(ids(searchGroups(inputOf([live, idle], workers, { activityRecords })))).toEqual([['recent', ['t:2', 'a:1']], ['pending', ['a:1']]]);
  expect(ids(searchGroups(inputOf([live, idle], workers, { scope: 'tasks', activityRecords })))).toEqual([['recent', ['t:2']]]);
  expect(ids(searchGroups(inputOf([live, idle], workers, { scope: 'activities', activityRecords })))).toEqual([['recent', ['a:1']], ['pending', ['a:1']]]);
  expect(ids(searchGroups(inputOf([], [], { scope: 'commands', operations: [view('sinal'), view('configurações')] })))).toEqual([['commands', ['o:sinal', 'o:configurações']]]);
});
