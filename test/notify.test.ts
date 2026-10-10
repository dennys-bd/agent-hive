import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationFeed, notificationsFor } from '../src/notify.js';
import { initialState } from '../src/orchestrator.js';
import type { Activity, ActivityRecord, EffectiveLimits, EventsPayload, NotificationSettings, State, Task, TaskPr, Worker } from '../src/types.js';
import { setLanguage, t } from '../src/ui/i18n.js';

const ALL: NotificationSettings = { waiting: true, approval: true, pr: true, failed: true };
const TASK: Task = { item: { itemId: 'board:12', id: '12', title: 'Fix login', body: '', url: '' }, stage: 'build', boardColumn: 'In progress', auto: true };
const ACTIVITY: Activity = { id: 'a1', kind: 'task', workspace: 'hive' };
const LOCAL: Activity = { id: 'local:site', kind: 'local', workspace: 'site' };
const RECORD: ActivityRecord = { id: 'a1', taskIds: ['board:12'], sessions: [] };
const EFFECTIVE: EffectiveLimits = { signal: 'green', floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
const SINCE = '2026-10-09T10:00:00.000Z';
const pr = (n: number): TaskPr => ({ url: `https://github.com/acme/hive/pull/${n}`, state: 'open' });

// The task with its activity and record, beside a workspace's local activity; `patch` sets the workers, activities or records
const state = (patch: Partial<State> = {}): State => ({ ...initialState(0), tasks: [TASK], activities: [ACTIVITY, LOCAL], activityRecords: [RECORD], ...patch });
const waiting = (since: string, activityId = 'a1'): Worker => ({ id: 'w1', runId: 'r1', activityId, status: 'waiting', waitingSince: since });
const keys = (prev: State, next: State, enabled = ALL): string[] => notificationsFor(prev, next, enabled).map((n) => n.key);

test('waiting: a session that starts waiting notifies once, titled with the task label, opening the task; a standing wait notifies nothing; a new waitingSince on the same run notifies again (#199)', () => {
  const before = state({ workers: [{ id: 'w1', runId: 'r1', activityId: 'a1', status: 'working' }] });
  const after = state({ workers: [waiting(SINCE)] });
  assert.deepEqual(notificationsFor(before, after, ALL), [{ kind: 'waiting', key: `waiting:r1:${SINCE}`, title: '#12 Fix login', body: t('notify.waiting'), taskId: 'board:12' }]);
  assert.deepEqual(notificationsFor(after, after, ALL), [], 'a re-sent identical state');
  assert.deepEqual(keys(after, state({ workers: [waiting('2026-10-09T10:05:00.000Z')] })), ['waiting:r1:2026-10-09T10:05:00.000Z']);
});

test('waiting: a local session is titled with its workspace and opens no task; a session with no activity is skipped (#199, #587)', () => {
  const after = state({ workers: [waiting(SINCE, 'local:site'), { id: 'w2', runId: 'r2', status: 'waiting', waitingSince: SINCE }] });
  assert.deepEqual(notificationsFor(state(), after, ALL), [{ kind: 'waiting', key: `waiting:r1:${SINCE}`, title: 'site', body: t('notify.waiting') }]);
});

test('approval: a new approval.since notifies, the worker holding the Stop or released; the same since notifies nothing (#199, #268, #321)', () => {
  const held = state({ activities: [{ ...ACTIVITY, approval: { since: SINCE, until: '2026-10-09T10:10:00.000Z' } }, LOCAL] });
  assert.deepEqual(notificationsFor(state(), held, ALL), [{ kind: 'approval', key: `approval:a1:${SINCE}`, title: '#12 Fix login', body: t('notify.approval'), taskId: 'board:12' }]);
  const released = state({ activities: [{ ...ACTIVITY, approval: { since: SINCE } }, LOCAL] });
  assert.deepEqual(keys(held, released), [], 'the hold released: the same gate');
});

test('pr: one notification per URL a record gains, three new PRs three notifications; a PR that only changes state notifies nothing (#199)', () => {
  const one = state({ activityRecords: [{ ...RECORD, prs: [pr(1)] }] });
  const four = state({ activityRecords: [{ ...RECORD, prs: [pr(1), pr(2), pr(3), pr(4)] }] });
  assert.deepEqual(keys(one, four), [2, 3, 4].map((n) => `pr:${pr(n).url}`));
  assert.deepEqual(notificationsFor(one, four, ALL)[0], { kind: 'pr', key: `pr:${pr(2).url}`, title: '#12 Fix login', body: t('notify.pr'), taskId: 'board:12' });
  const merged = state({ activityRecords: [{ ...RECORD, prs: [pr(1), pr(2), pr(3), { ...pr(4), state: 'merged' }] }] });
  assert.deepEqual(keys(four, merged), []);
});

test('failed: a new error on a live activity notifies; the same error again nothing; an activity no task holds any more is skipped (#199)', () => {
  const failed = state({ activities: [{ ...ACTIVITY, error: 'spawn failed' }, LOCAL] });
  assert.deepEqual(notificationsFor(state(), failed, ALL), [{ kind: 'failed', key: 'failed:a1:spawn failed', title: '#12 Fix login', body: t('notify.failed'), taskId: 'board:12' }]);
  assert.deepEqual(keys(failed, failed), []);
  assert.deepEqual(keys(state({ tasks: [] }), { ...failed, tasks: [] }), [], 'no task to name');
});

test('a kind turned off notifies nothing while the others still do; the order is the kinds\', then the state\'s (#199)', () => {
  const next = state({
    workers: [waiting(SINCE)],
    activities: [{ ...ACTIVITY, approval: { since: SINCE }, error: 'boom' }, { ...LOCAL, error: 'shell gone' }],
    activityRecords: [{ ...RECORD, prs: [pr(7)] }],
  });
  assert.deepEqual(keys(state(), next), [`waiting:r1:${SINCE}`, `approval:a1:${SINCE}`, `pr:${pr(7).url}`, 'failed:a1:boom', 'failed:local:site:shell gone']);
  assert.deepEqual(keys(state(), next, { ...ALL, waiting: false, pr: false }), [`approval:a1:${SINCE}`, 'failed:a1:boom', 'failed:local:site:shell gone']);
});

test('the body is in the Hive\'s language (#199, #242)', (ctx) => {
  ctx.after(() => setLanguage('en'));
  setLanguage('pt');
  assert.equal(notificationsFor(state(), state({ workers: [waiting(SINCE)] }), ALL)[0].body, 'Esperando sua resposta');
});

test('notificationFeed: the first payload, the first after a stream end and the first after setup mode are a baseline only; the toggles are read at each payload (#199)', () => {
  let enabled = ALL;
  const feed = notificationFeed(() => enabled);
  const payload = (s: State): EventsPayload => ({ ...s, effective: EFFECTIVE });
  const quiet = payload(state());
  const asking = payload(state({ workers: [waiting(SINCE)] }));
  assert.deepEqual(feed(asking), [], 'a boot: the session was already waiting');
  assert.deepEqual(feed(quiet), []);
  assert.equal(feed(asking).length, 1);
  feed(undefined); // the stream ended: a Restart, a daemon that moved
  assert.deepEqual(feed(asking), [], 'the reconnect replays nothing');
  feed({ configured: false });
  assert.deepEqual(feed(quiet), [], 'out of setup mode: a baseline');
  enabled = { ...ALL, waiting: false };
  assert.deepEqual(feed(asking), [], 'a saved toggle applies to the next event');
});
