import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, ActivityRecord, Task, Worker } from '../src/types.js';
import { setLanguage } from '../src/ui/i18n.js';
import { pendingSessions, recentActivities, relativeTime } from '../src/ui/lib/home.js';
import { workspaceColor } from '../src/ui/lib/workspace-color.js';

const task = (id: string): Task => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true,
});
// The task's sessions live in its record (#629)
const record = (id: string, lastUsed: string[]): ActivityRecord => ({
  id: `a-${id}`, taskIds: [`I${id}`], sessions: lastUsed.map((at, i) => ({ id: `${id}-s${i}`, startedAt: at, stages: ['dev'], lastUsedAt: at })),
});
// A worker on task I<n> points at its activity, `a-<n>` (#629)
const worker = (id: string, taskId: string, status: Worker['status'], waitingSince?: string): Worker =>
  ({ id, activityId: `a-${taskId.slice(1)}`, status, ...(waitingSince ? { waitingSince } : {}) });
const live = (id: string): Activity => ({ id: `a-${id}`, kind: 'task', workspace: 'hive', slug: `hive-${id}` });

test('pendingSessions lists the sessions waiting on the user before those awaiting approval, the longest waiting first, and nothing else (redesign 08)', () => {
  const tasks = [task('1'), task('2'), task('3')];
  const workers = [
    worker('a', 'I1', 'approval', '2026-09-28T10:00:00Z'), worker('b', 'I2', 'waiting', '2026-09-28T11:00:00Z'),
    worker('c', 'I3', 'waiting', '2026-09-28T09:00:00Z'), worker('d', 'I1', 'working'), worker('e', 'gone', 'waiting'),
  ];
  const activityRecords = ['1', '2', '3'].map((id) => record(id, []));
  assert.deepEqual(pendingSessions({ tasks, workers, activityRecords }).map((row) => [row.worker.id, row.status]), [['c', 'waiting'], ['b', 'waiting'], ['a', 'approval']]);
});

test('recentActivities orders the tasks by their sessions\' last use, newest first, with their task state (review with an open PR and no session at work) or empty, and skips tasks without a dated session (redesign 08, #663)', () => {
  const tasks = [task('1'), task('2'), task('3'), task('4')];
  const inReview = { ...record('2', ['2026-09-28T09:00:00Z']), prs: [{ url: 'https://github.com/o/r/pull/2', state: 'open' as const }] };
  const activityRecords = [record('1', ['2026-09-27T10:00:00Z', '2026-09-28T08:00:00Z']), inReview, record('3', [''])];
  const rows = recentActivities({ tasks, workers: [worker('a', 'I1', 'working')], activities: [live('1')], activityRecords });
  assert.deepEqual(rows.map((row) => [row.task.item.id, row.status, row.lastUsedAt]), [['2', 'review', '2026-09-28T09:00:00Z'], ['1', 'working', '2026-09-28T08:00:00Z']]);
  assert.equal(recentActivities({ tasks, workers: [], activities: [], activityRecords }, 1).length, 1, 'at most the limit');
});

test('recentActivities reads the stages: a task queued in a stage that runs reads its open PR as new, not review (#15)', () => {
  const inReview = { ...record('2', ['2026-09-28T09:00:00Z']), prs: [{ url: 'https://github.com/o/r/pull/2', state: 'open' as const }] };
  const rows = recentActivities({ tasks: [task('2')], workers: [], activities: [], activityRecords: [inReview], stages: [{ name: 'dev', from: {}, prompt: 'p' }] });
  assert.deepEqual(rows.map((row) => row.status), ['new']);
});

test('relativeTime reads now, minutes, hours of today, yesterday and days (redesign 08)', () => {
  setLanguage('pt');
  const now = new Date(2026, 8, 28, 15, 0).getTime();
  const at = (ms: number): string => new Date(now - ms).toISOString();
  assert.equal(relativeTime(at(30_000), now), 'agora');
  assert.equal(relativeTime(at(2 * 60_000), now), 'há 2 min');
  assert.equal(relativeTime(at(3 * 3_600_000), now), 'há 3 h');
  assert.equal(relativeTime(new Date(2026, 8, 27, 23, 0).toISOString(), now), 'ontem');
  assert.equal(relativeTime(new Date(2026, 8, 25, 12, 0).toISOString(), now), 'há 3 dias');
  setLanguage('en');
  assert.equal(relativeTime(at(2 * 60_000), now), '2 min ago');
});

test('workspaceColor gives a workspace the same oklch colour every time, at the lightness and chroma of the palette (redesign 08)', () => {
  assert.equal(workspaceColor('agent-hive'), workspaceColor('agent-hive'));
  assert.match(workspaceColor('site'), /^oklch\(0\.72 0\.12 \d+\)$/);
});
