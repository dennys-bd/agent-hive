import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClean, fakeId, mapStage, missingStates, sanitizeState, sanitizeText } from '../../scripts/experiment/snapshot.js';

const O = { liveStages: ['Backlog', 'Plan', 'Dev', 'In Review', 'Done'], seedStages: ['Spec', 'Plan', 'Build', 'Merge', 'Done'], username: 'ana', home: '/Users/ana' };
const SESSION = { id: 's-1111111111', startedAt: '2026-09-30T10:00:00.000Z', lastUsedAt: '2026-09-30T11:00:00Z', stages: ['Plan', 'Dev'], tokens: 5, name: 'private' };
// #629: the work of a task sits on its activity and the activity's record
const LIVE = {
  signal: 'yellow', workers: [{ id: 'w', status: 'working' }], terminals: [{ terminalId: 't' }], rateLimits: {}, crash: { at: 'x', tasks: [] },
  tasks: [
    { item: { itemId: 'gh:3', id: '3', title: 'Fix /Users/ana/repo for ana (@ana)', body: 'private body', url: 'https://github.com/ana/repo/issues/3' }, stage: 'Dev', enteredAt: '2026-10-01T00:00:00.000Z', result: { a: 1 } },
    { item: { itemId: 'gh:4', id: '4', title: 'No worktree', body: '', url: '' }, stage: 'Backlog' },
    { item: { itemId: 'gh:5', id: '5', title: 'Gone', body: '', url: '' }, stage: 'Plan' },
    { item: { itemId: 'gh:6', id: '6', title: 'Stopped', body: '', url: '' }, stage: 'In Review' },
  ],
  activities: [
    {
      id: 'act-3', kind: 'task', workspace: 'ana-ws', slug: 'hive-3-fix', worktree: '/Users/ana/repo/.hive/worktrees/hive-3', branch: 'hive/3-fix', error: 'boom at /Users/ana', feedback: 'x',
      sessionId: 's-1111111111', approval: { since: '2026-10-01T00:00:00.000Z' },
    },
    { id: 'act-5', kind: 'task', workspace: 'ana-ws', worktree: '/Users/ana/x', worktreeGone: true },
    { id: 'act-6', kind: 'task', workspace: 'ana-ws', worktree: '/Users/ana/y', stopped: true, stoppedAt: '2026-10-01T01:00:00.000Z' },
  ],
  activityRecords: [
    { id: 'act-3', taskIds: ['gh:3'], sessions: [SESSION], usage: { tokens: 9, ms: 8, waitingMs: 7 }, prs: [{ url: 'https://github.com/ana/repo/pull/42', state: 'open' }], result: { a: 1 } },
    { id: 'act-5', taskIds: ['gh:5'], sessions: [] },
    { id: 'act-6', taskIds: ['gh:6'], sessions: [] },
  ],
};

test('sanitizeState keeps only the tasks with a live activity, renumbered as local MON tasks on the seed stages, with nothing machine-specific (#105)', () => {
  const state = sanitizeState(LIVE, O);
  const [first, second] = state.tasks as Record<string, unknown>[];
  const [firstActivity, secondActivity] = state.activities as Record<string, unknown>[];
  const [firstRecord, secondRecord] = state.activityRecords as Record<string, unknown>[];
  assert.equal((state.tasks as unknown[]).length, 2);
  assert.deepEqual([state.signal, state.workers, state.terminals, state.localCount, state.maxConcurrent, state.rateLimits, state.crash], ['green', [], [], 2, 0, undefined, undefined]);
  assert.deepEqual(first.item, { itemId: 'local:1', id: 'MON-1', title: 'Fix ~/repo for user (@user)', body: '', url: '' });
  assert.deepEqual([first.stage, first.auto, first.created, first.workspace, first.enteredAt], ['Build', false, true, 'agent-hive', '2026-10-01T00:00:00.000Z']);
  for (const gone of ['branch', 'error', 'feedback', 'result']) assert.equal(first[gone] ?? firstActivity[gone] ?? firstRecord[gone], undefined, gone);
  assert.deepEqual([firstActivity.id, firstActivity.kind, firstActivity.workspace, firstActivity.worktree, firstActivity.slug], [fakeId('act-3'), 'task', 'agent-hive', '{worktree}', undefined]);
  assert.deepEqual([firstActivity.approval, firstActivity.sessionId], [{ since: '2026-10-01T00:00:00.000Z' }, fakeId('s-1111111111')]);
  assert.deepEqual([firstRecord.id, firstRecord.taskIds], [fakeId('act-3'), ['local:1']]);
  assert.deepEqual(firstRecord.sessions, [{ id: fakeId('s-1111111111'), startedAt: '2026-09-30T10:00:00.000Z', lastUsedAt: '2026-09-30T11:00:00Z', stages: ['Plan', 'Build'], tokens: 5 }]);
  assert.deepEqual([firstRecord.prs, firstRecord.usage], [[{ url: 'https://github.com/acme/app/pull/42', state: 'open' }], { tokens: 9, ms: 8, waitingMs: 7 }]);
  assert.deepEqual([(second.item as { id: string }).id, second.stage, secondActivity.stopped, secondActivity.stoppedAt, secondRecord.taskIds], ['MON-2', 'Merge', true, '2026-10-01T01:00:00.000Z', ['local:2']]);
  assert.doesNotThrow(() => assertClean(JSON.stringify(state), O));
});

test('sanitizeText replaces the home folder, home paths, the account name, mentions, emails, tokens and 64-hex secrets (#105)', () => {
  const text = `mail ana.b@x.io, token ghp_abcdefgh1234, key ${'a'.repeat(64)}, path /home/bob/x and /Users/ana/y, banana, Ana, @bob`;
  assert.equal(sanitizeText(text, O), 'mail <email>, token <token>, key <secret>, path ~/x and ~/y, banana, user, @user');
});

test('sanitizeText scrubs any absolute path under the machine roots, AWS and Slack keys, JWTs and bearer values (#105)', () => {
  const jwt = 'eyJhbGciOi.eyJzdWIiOiIx.c2ln_nature-1';
  const text = `/Volumes/Work/a /root/b /private/tmp/c /var/folders/d /Users/x/e AKIAABCDEFGHIJKLMNOP xoxb-123-abc ${jwt} Bearer abc.def`;
  assert.equal(sanitizeText(text, O), '~/a ~ ~/c ~/d ~/e <token> <token> <token> <token>');
});

test('sanitizeState drops timestamps that are not ISO strings and usage fields that are not finite numbers, and keeps the valid ones (#105)', () => {
  const live = structuredClone(LIVE) as unknown as Record<'tasks' | 'activities' | 'activityRecords', Record<string, unknown>[]>;
  live.tasks[0] = { ...live.tasks[0], enteredAt: 'ana at /Users/ana' };
  live.activities[0] = { ...live.activities[0], approval: { since: 'sk-secret123456' } };
  live.activityRecords[0] = { ...live.activityRecords[0], usage: { tokens: 'x', ms: Number.NaN, waitingMs: 7 }, sessions: [{ ...SESSION, startedAt: 'free text', lastUsedAt: 12, tokens: Infinity }] };
  const state = sanitizeState(live, O);
  const [task] = state.tasks as Record<string, unknown>[];
  const [activity] = state.activities as Record<string, unknown>[];
  const [record] = state.activityRecords as { usage: unknown; sessions: Record<string, unknown>[] }[];
  assert.deepEqual([task.enteredAt, activity.approval, record.usage], [undefined, undefined, { waitingMs: 7 }]);
  assert.deepEqual(Object.keys(record.sessions[0]).sort(), ['id', 'stages']);
});

test('sanitizeText scrubs Google, npm and GitLab tokens and a private key block, its body included; assertClean refuses each (#105)', () => {
  const google = `AIza${'B'.repeat(35)}`;
  const npm = `npm_${'c'.repeat(36)}`;
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXk\\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(sanitizeText(`${google} ${npm} glpat-${'d'.repeat(20)} ${key} after`, O), '<token> <token> <token> <token> after');
  for (const text of [google, npm, `glpat-${'d'.repeat(20)}`, '-----BEGIN RSA PRIVATE KEY-----']) assert.throws(() => assertClean(`{"x":"${text}"}`, O), /a token/, text);
});

test('sanitizeState keeps a PR only when its state is one of the PR states, so no free text rides in it (#105)', () => {
  const live = structuredClone(LIVE) as unknown as Record<'activityRecords', Record<string, unknown>[]>;
  live.activityRecords[0] = { ...live.activityRecords[0], prs: [{ url: 'https://x/pull/1', state: 'merged' }, { url: 'https://x/pull/2', state: 'ana at /Users/ana' }, { url: 'https://x/pull/3', state: 7 }] };
  const [record] = sanitizeState(live, O).activityRecords as { prs: unknown }[];
  assert.deepEqual(record.prs, [{ url: 'https://github.com/acme/app/pull/1', state: 'merged' }]);
});

test('mapStage maps a live stage by position onto the seed stages, an unknown one to the first (#105)', () => {
  assert.deepEqual(O.liveStages.map((s) => mapStage(O.liveStages, O.seedStages, s)), O.seedStages);
  assert.deepEqual(['A', 'B', 'C'].map((s) => mapStage(['A', 'B', 'C'], O.seedStages, s)), ['Spec', 'Build', 'Done']);
  assert.equal(mapStage(O.liveStages, O.seedStages, 'Elsewhere'), 'Spec');
  assert.equal(mapStage(['Only'], O.seedStages, 'Only'), 'Spec');
});

test('missingStates names what the scenarios need and the snapshot lacks; assertClean refuses anything machine-specific (#105)', () => {
  assert.deepEqual(missingStates(sanitizeState(LIVE, O)), ['7 activities', '3 stages', 'an activity with two sessions']);
  const bad: [string, RegExp][] = [['{"x":"/Users/bob"}', /a home path/], ['{"x":"Ana"}', /the account name/], ['{"x":"ghp_12345678"}', /a token/], [`{"x":"${'f'.repeat(64)}"}`, /a 64-hex secret/],
    ['{"x":"/Volumes/Work"}', /a home path/], ['{"x":"/private/tmp"}', /a home path/], ['{"x":"AKIAABCDEFGHIJKLMNOP"}', /a token/], ['{"x":"xoxp-1-a"}', /a token/],
    ['{"x":"eyJhbGciOi.eyJzdWIi.c2ln"}', /a token/], ['{"x":"Bearer abc123"}', /a token/]];
  for (const [text, message] of bad) assert.throws(() => assertClean(text, O), message);
});
