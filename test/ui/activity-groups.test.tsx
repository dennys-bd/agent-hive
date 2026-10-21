// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx
import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { activitiesOf, isTask, type Slice, type TaskActivity } from '@/lib/activities';
import { type ActivityGroup, groupActivities, isDone, recentOf, workspaceSummary } from '@/lib/activity-groups';
import type { ActivityRecord, PrState, Task, Stage } from '../../src/types';
import { activityIdOf, taskPairOf, type WithWork, withTasks } from '../fixtures/work';

const FLOW: Stage[] = [
  { name: 'dev', prompt: '/hive-build {url}', from: {} },
  { name: 'review', prompt: '/hive-review {url}', from: {} },
  { name: 'done', from: {} },
];
const task = (id: string, stage: string, extra: Partial<Task> = {}): Task => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage, boardColumn: '', auto: true, ...extra,
});
const session: TaskActivity['sessions'][number] = { run: { ptyId: 'W1', label: 'Claude', kind: 'stage' }, status: 'working' };
const activity = (id: string, stage: string, extra: Partial<TaskActivity> = {}, taskExtra: Partial<Task> = {}): TaskActivity => ({
  kind: 'task', ...taskPairOf(`I${id}`), task: task(id, stage, taskExtra), runs: [], sessions: [], status: 'empty', worker: false, ...extra,
});
const live = (status: TaskActivity['status']): Partial<TaskActivity> => ({ status, sessions: [session] });
const shape = (groups: ActivityGroup[]): [string, string[], boolean][] => groups.map((g) => [g.name, g.items.map((a) => a.task.item.id), g.isDone]);

beforeEach(() => setLanguage('pt'));

test('by stage: one group per stage in flow order, named by the stage, empty stages left out, done last and named after the last stage (#586)', () => {
  const list = [activity('1', 'review'), activity('2', 'done'), activity('3', 'dev'), activity('4', 'review')];
  expect(shape(groupActivities(list, 'stage', FLOW))).toEqual([['dev', ['3'], false], ['review', ['1', '4'], false], ['done', ['2'], true]]);
  expect(groupActivities(list, 'stage', FLOW).map((g) => g.key)).toEqual(['stage:dev', 'stage:review', 'done']);
});

test('by stage: a task whose stage left the flow gets a group of its own after the flow\'s, before done (#586)', () => {
  const list = [activity('1', 'done'), activity('2', 'qa'), activity('3', 'dev')];
  expect(shape(groupActivities(list, 'stage', FLOW))).toEqual([['dev', ['3'], false], ['qa', ['2'], false], ['done', ['1'], true]]);
});

test('done: the last stage with no prompt or with delete activity; a last stage with a prompt never is (#586)', () => {
  const withPrompt = FLOW.slice(0, 2);
  const cleanup: Stage[] = [...withPrompt, { name: 'limpar', action: 'deleteActivity', from: {} }];
  expect(isDone(task('1', 'done'), FLOW)).toBe(true);
  expect(isDone(task('1', 'review'), FLOW)).toBe(false);
  expect(isDone(task('1', 'review'), withPrompt)).toBe(false);
  expect(isDone(task('1', 'limpar'), cleanup)).toBe(true);
  expect(isDone(task('1', 'dev'), [])).toBe(false);
  expect(groupActivities([activity('1', 'review')], 'stage', withPrompt).map((g) => g.isDone)).toEqual([false]);
});

test('by status: waiting, approval, working, review, stopped; the status is the activity\'s own, an activity with no working session is empty, and stopped; done last as finalizado (#586, #663)', () => {
  const list = [
    activity('1', 'dev', live('review')), activity('2', 'dev'), activity('3', 'review', live('waiting')),
    activity('4', 'done'), activity('5', 'dev', live('approval')), activity('6', 'dev', { status: 'working' }),
  ];
  expect(shape(groupActivities(list, 'status', FLOW))).toEqual([
    ['esperando você', ['3'], false], ['aguardando aprovação', ['5'], false], ['trabalhando', ['6'], false],
    ['aguardando review', ['1'], false], ['parada', ['2'], false], ['finalizado', ['4'], true],
  ]);
});

test('a done-stage activity with an awake session sits in its status group, not finalizado; asleep it is done (#666)', () => {
  const list = [activity('1', 'done', live('working')), activity('2', 'done', live('waiting')), activity('3', 'done', { status: 'working' })];
  expect(shape(groupActivities(list, 'status', FLOW))).toEqual([
    ['esperando você', ['2'], false], ['trabalhando', ['1'], false], ['finalizado', ['3'], true],
  ]);
});

test('no grouping: a done-stage activity with an awake session stays in the list; asleep it is done (#666)', () => {
  const list = [activity('1', 'done', live('working')), activity('2', 'done')];
  expect(shape(groupActivities(list, 'none', FLOW))).toEqual([['', ['1'], false], ['finalizado', ['2'], true]]);
});

test('by stage: a done-stage activity stays in the last stage\'s group even with an awake session (#666)', () => {
  expect(shape(groupActivities([activity('1', 'done', live('working'))], 'stage', FLOW))).toEqual([['done', ['1'], true]]);
});

test('no grouping: one list, newest first by the later of its workers\' start and its stage entry, even empty; done still last (#586)', () => {
  const list = [
    activity('1', 'dev', { lastStartedAt: '2026-09-29T10:00:00.000Z' }),
    activity('2', 'dev', {}, { enteredAt: '2026-09-29T12:00:00.000Z' }),
    activity('3', 'review', { lastStartedAt: '2026-09-29T09:00:00.000Z' }, { enteredAt: '2026-09-29T11:00:00.000Z' }),
    activity('4', 'dev'),
    activity('5', 'done'),
  ];
  expect(recentOf(list[2])).toBe('2026-09-29T11:00:00.000Z');
  expect(shape(groupActivities(list, 'none', FLOW))).toEqual([['', ['2', '3', '1', '4'], false], ['finalizado', ['5'], true]]);
  expect(shape(groupActivities([], 'none', FLOW))).toEqual([['', [], false]]);
});

test('a collapsed workspace\'s summary: the count, then the waiting ones, else the approval ones, else the count alone; nothing when empty (#586)', () => {
  const waiting = activity('1', 'dev', live('waiting'));
  const approval = activity('2', 'dev', live('approval'));
  const idle = activity('3', 'dev');
  expect(workspaceSummary([waiting, approval, idle])).toBe('3 · 1 esperando você');
  expect(workspaceSummary([approval, approval, idle])).toBe('3 · 2 aguardando aprovação');
  expect(workspaceSummary([idle])).toBe('1');
  expect(workspaceSummary([])).toBe('');
});

const T0 = '2026-10-01T10:00:00.000Z';

test('by status: the task state groups a stopped activity, under review with an open PR (an approval too), under approval with no worker; a merged or closed PR alone is stopped (#586, #663)', () => {
  const fixture = (id: string, extra: Partial<WithWork> = {}): WithWork => ({ ...task(id, 'dev'), worktree: `/w/${id}`, ...extra });
  // #629: the PRs are the activity's record's
  const prs = (id: string, state: PrState): ActivityRecord => ({ id: activityIdOf(`I${id}`), taskIds: [`I${id}`], sessions: [], prs: [{ url: `https://github.com/o/r/pull/${id}`, state }] });
  const approval = { approval: { since: T0 } };
  const slice: Slice = { tasks: [], workers: [], terminals: [], workspaces: [], activities: [], activityRecords: [prs('1', 'open'), prs('3', 'open'), prs('4', 'merged'), prs('5', 'closed')] };
  const list = activitiesOf(withTasks(slice, [fixture('1'), fixture('2', approval), fixture('3', approval), fixture('4'), fixture('5')])).filter(isTask);
  expect(shape(groupActivities(list, 'status', FLOW))).toEqual([
    ['aguardando aprovação', ['2'], false], ['aguardando review', ['1', '3'], false], ['parada', ['4', '5'], false],
  ]);
});

test('done: a last skill stage runs an agent, so a task there is never done (#710)', () => {
  const planLast: Stage[] = [...FLOW.slice(0, 2), { name: 'plan', action: 'skill', skill: 'new-plan', from: {} }];
  expect(isDone(task('1', 'plan'), planLast)).toBe(false);
});
