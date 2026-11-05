import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiveProject, WORKSPACE_FIELD } from '../src/hive-project.js';
import { initialState } from '../src/orchestrator.js';
import type { ActivityRecord, Flow, Item, State, Task } from '../src/types.js';

const flow = (name: string, stages: string[]): Flow => ({ name, stages: stages.map((s) => ({ name: s, from: {} })), transitions: [] });
// Two flows: main's spec and dev, then docs' write
const FLOWS: Flow[] = [flow('main', ['spec', 'dev']), flow('docs', ['write'])];
// A task created in the Hive: local:<n> / HIVE-<n>, no source
const hiveTask = (n: number, extra: Partial<Task> = {}, item: Partial<Item> = {}): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `T${n}`, body: `b${n}`, url: '', ...item }, boardColumn: '', auto: false, created: true, ...extra,
});
const SOURCE_TASK: Task = {
  item: { itemId: 'work:PVTI_9', id: '9', title: 'From GitHub', body: '', url: 'https://github.com/acme/r/issues/9', source: 'work' },
  stage: 'dev', boardColumn: 'Ready', auto: true,
};
const TASKS: Task[] = [
  hiveTask(1, { stage: 'dev', workspace: 'hive' }),
  SOURCE_TASK,
  hiveTask(2, {}, { parent: 'local:1' }), // stageless (#566), no workspace, HIVE-1's child
  hiveTask(3, { stage: 'write' }, { parent: 'work:PVTI_9' }), // a parent that is no local:<n>
];
const RECORDS: ActivityRecord[] = [
  { id: 'a1', taskIds: ['local:1'], sessions: [], prs: [{ url: 'https://github.com/acme/r/pull/12', state: 'open' }, { url: 'https://example.com/not-a-pr', state: 'merged' }] },
  { id: 'a2', taskIds: ['local:1'], sessions: [], prs: [{ url: 'https://github.com/acme/r/pull/14', state: 'merged' }, { url: 'https://github.com/acme/r/pull/12', state: 'open' }] }, // #12 again: a re-run on the same branch
  { id: 'a3', taskIds: ['work:PVTI_9'], sessions: [], prs: [{ url: 'https://github.com/acme/r/pull/13', state: 'open' }] },
];
const STATE: State = { ...initialState(0), flows: FLOWS, tasks: TASKS, activityRecords: RECORDS };

test('hiveProject lists the stages of every flow in flow order, each citing itself; one Workspace text field with the status builtin before it; never truncated (#582)', () => {
  const view = hiveProject(STATE);
  assert.deepEqual(view.statuses, [{ name: 'spec', stage: 'spec' }, { name: 'dev', stage: 'dev' }, { name: 'write', stage: 'write' }]);
  assert.deepEqual(view.fields, [{ name: WORKSPACE_FIELD, type: 'text' }]);
  assert.deepEqual(view.builtins, { status: 0 });
  assert.equal(view.truncated, false);
});

test('hiveProject has one row per hive task in the Hive\'s order, a source task left out: the stage as status, the workspace, the records\' PRs and a local:<n> parent as n (#582)', () => {
  assert.deepEqual(hiveProject(STATE).items, [
    {
      itemId: 'local:1', id: 'HIVE-1', title: 'T1', body: 'b1', url: '', status: 'dev', labels: [], assignees: [], fields: { [WORKSPACE_FIELD]: 'hive' },
      pullRequests: [{ number: 12, url: 'https://github.com/acme/r/pull/12', state: 'open' }, { number: 14, url: 'https://github.com/acme/r/pull/14', state: 'merged' }],
    },
    { itemId: 'local:2', id: 'HIVE-2', title: 'T2', body: 'b2', url: '', labels: [], assignees: [], fields: {}, pullRequests: [], parent: 1 },
    { itemId: 'local:3', id: 'HIVE-3', title: 'T3', body: 'b3', url: '', status: 'write', labels: [], assignees: [], fields: {}, pullRequests: [] },
  ]);
});

test('hiveProject with no hive task answers no rows and still every status (#582)', () => {
  const view = hiveProject({ ...STATE, tasks: [SOURCE_TASK] });
  assert.deepEqual([view.items, view.statuses.length], [[], 3]);
});
