import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { mountMcp } from '../src/mcp.js';
import { TASK_DESCRIPTION } from '../src/mcp-optional.js';
import { taskAnswer, taskComments } from '../src/mcp-task.js';
import { initialState } from '../src/orchestrator.js';
import { MCP_DEFAULTS } from '../src/types.js';
import type { Config, Exec, Item, OptionalTool, Source, State, Task, TaskComment, Worker, Workspace } from '../src/types.js';
import { fakeFacts } from './fakes.js';
import { activityIdOf, withKeptRecord, withLocal, withWork } from './fixtures/work.js';

const ITEM_ID = 'gh:I7';
type Fields = Partial<Item> & Pick<Item, 'itemId' | 'id'>;
const taskOf = (fields: Fields, stage: string): Task =>
  ({ item: { title: `Task ${fields.id}`, body: '', url: `https://github.com/acme/r/issues/${fields.id}`, source: 'gh', ...fields }, stage, boardColumn: 'Ready', auto: true });

const LEAF: Task = { ...taskOf({ itemId: ITEM_ID, id: '7', title: 'hive_task', body: 'The worker reads its task.' }, 'plan'), workspace: 'hive' };
const LEAF_ANSWER = {
  id: '7', itemId: ITEM_ID, title: 'hive_task', body: 'The worker reads its task.', url: 'https://github.com/acme/r/issues/7',
  source: 'gh', workspace: 'hive', stage: 'plan', result: { spec: 'docs/s.md', issue: 7 },
};
const STAGE_WORKER: Worker = { id: 'w1', runId: 'p1', status: 'working', activityId: activityIdOf(ITEM_ID) };
const LOCAL_WORKER: Worker = { id: 'w2', runId: 'p2', status: 'working', activityId: localActivityId('hive') };
const COMMENT: TaskComment = { author: 'someone', createdAt: '2026-10-20T10:00:00Z', body: 'Comments always.', url: 'https://github.com/acme/r/issues/7#issuecomment-1' };

// Two records of the task, the older first: what resultOf merges, a newer key winning
function stateWith(tasks: Task[], workers: Worker[] = [STAGE_WORKER]): State {
  const kept = withKeptRecord({ ...initialState(1), tasks, workers }, ITEM_ID, 'old', { result: { spec: 'docs/old.md', issue: 7 } });
  return withWork(kept, ITEM_ID, {}, { result: { spec: 'docs/s.md' } });
}

test('taskAnswer gives a stage run and a free session on the task the same answer: identity, the current stage and every result merged, a newer key winning (#7)', () => {
  const state = stateWith([LEAF]);
  assert.deepEqual(taskAnswer(state, STAGE_WORKER, 'hive'), { task: LEAF_ANSWER });
  assert.deepEqual(taskAnswer(state, { ...STAGE_WORKER, freeSession: true }, 'hive'), { task: LEAF_ANSWER });
  const { workspace: _workspace, ...unplaced } = LEAF_ANSWER;
  assert.deepEqual(taskAnswer(state, STAGE_WORKER, undefined), { task: unplaced }, 'no workspace resolved: none named');
});

test('a session with no task answers task: null (#7)', () => {
  assert.deepEqual(taskAnswer(withLocal(stateWith([LEAF], [LOCAL_WORKER]), 'hive'), LOCAL_WORKER, 'hive'), { task: null });
});

const TREE: Task = {
  ...LEAF,
  item: {
    ...LEAF.item, parent: 'gh:I1', children: ['gh:I8', 'gh:I9', 'gh:I10'], closedChildren: ['gh:I10'],
    blockers: { blockedBy: [{ id: '5', title: 'Blocker', state: 'open' }, { id: 'acme/o#2', title: 'Elsewhere', state: 'closed' }], blocking: [{ id: '8', title: 'Task 8', state: 'open' }] },
  },
};
const PARENT = taskOf({ itemId: 'gh:I1', id: '1', title: 'Goal' }, 'decomposition');
const CHILD = taskOf({ itemId: 'gh:I8', id: '8' }, 'spec');
const BLOCKER = taskOf({ itemId: 'gh:I5', id: '5', title: 'Blocker' }, 'build');

test('the tree: parent, children and blockers carry id, title and stage when the Hive holds them, the itemId alone when not, closed: true on a closed child (#7)', () => {
  const answer = taskAnswer(stateWith([TREE, PARENT, CHILD, BLOCKER]), STAGE_WORKER, 'hive').task;
  assert.deepEqual(answer?.parent, { id: '1', title: 'Goal', stage: 'decomposition' });
  assert.deepEqual(answer?.children, [{ id: '8', title: 'Task 8', stage: 'spec' }, { id: 'gh:I9' }, { id: 'gh:I10', closed: true }]);
  assert.deepEqual(answer?.blockers, {
    blockedBy: [{ id: '5', title: 'Blocker', state: 'open', stage: 'build' }, { id: 'acme/o#2', title: 'Elsewhere', state: 'closed' }],
    blocking: [{ id: '8', title: 'Task 8', state: 'open', stage: 'spec' }],
  });
  assert.deepEqual(taskAnswer(stateWith([TREE]), STAGE_WORKER, 'hive').task?.parent, { id: 'gh:I1' }, 'a parent the Hive does not hold');
});

const CREATED: Task = { item: { itemId: 'local:3', id: 'HIVE-3', title: 'Mine', body: 'b', url: '' }, stage: 'spec', boardColumn: '', auto: true, created: true };

test('a leaf leaves parent, children and blockers out; a blocker never takes the stage of a task of another source under the same id (#7)', () => {
  const leaf = taskAnswer(stateWith([LEAF]), STAGE_WORKER, 'hive').task ?? {};
  for (const key of ['parent', 'children', 'blockers']) assert.equal(Object.hasOwn(leaf, key), false, key);
  const created5: Task = { ...CREATED, item: { ...CREATED.item, itemId: 'local:5', id: '5' } };
  const blockers = taskAnswer(stateWith([TREE, created5]), STAGE_WORKER, 'hive').task?.blockers;
  assert.deepEqual(blockers?.blockedBy[0], { id: '5', title: 'Blocker', state: 'open' });
});

test('a task created in the Hive names no source and reads no comments, even from a source that has them (#7)', async () => {
  const worker: Worker = { ...STAGE_WORKER, activityId: activityIdOf('local:3') };
  const state = withWork({ ...initialState(1), tasks: [CREATED], workers: [worker] }, 'local:3');
  assert.deepEqual(taskAnswer(state, worker, 'hive'), { task: { id: 'HIVE-3', itemId: 'local:3', title: 'Mine', body: 'b', url: '', workspace: 'hive', stage: 'spec' } });
  assert.deepEqual(await taskComments({ comments: async () => [COMMENT] }, CREATED), {});
});

test('taskComments reads the comments by the task\'s itemId, leaves them out for a source without comments, and turns a throw into commentsError (#7)', async () => {
  const asked: string[] = [];
  const reading = { comments: async (itemId: string): Promise<TaskComment[]> => { asked.push(itemId); return [COMMENT]; } };
  assert.deepEqual(await taskComments(reading, LEAF), { comments: [COMMENT] });
  assert.deepEqual(asked, [ITEM_ID]);
  assert.deepEqual(await taskComments({}, LEAF), {});
  assert.deepEqual(await taskComments(undefined, LEAF), {});
  const failing = { comments: async (): Promise<TaskComment[]> => { throw new Error('API rate limit exceeded'); } };
  assert.deepEqual(await taskComments(failing, LEAF), { commentsError: 'API rate limit exceeded' });
  const dumping = { comments: async (): Promise<TaskComment[]> => { throw new Error('HTTP 500\nrequest: GET /x'); } };
  assert.deepEqual(await taskComments(dumping, LEAF), { commentsError: 'HTTP 500' });
});

type Sources = ReadonlyMap<string, Pick<Source, 'create' | 'comments'>>;
const NO_SOURCES: Sources = new Map();
const APP: Workspace = { name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' };
// git -C /repo remote get-url origin: the workspace's GitHub origin
const exec: Exec = async (_file, args) => ({ stdout: args[1] === '/repo' ? 'https://github.com/acme/r.git\n' : '' });
const configWith = (off: OptionalTool[]): Config =>
  ({ mcp: { ...MCP_DEFAULTS, off }, comb: { prefix: 'HIVE', sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive', workspaces: [APP] } }) as unknown as Config;

async function harness(t: TestContext, state: State, sources: Sources, off: OptionalTool[] = [], ptyId = 'p1'): Promise<Client> {
  const { facts } = fakeFacts();
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const app = express().use(express.json());
  mountMcp(app, {
    exec, live: () => ({ state, config: configWith(off), sources }), poll: async () => undefined, dispatch: async () => [],
    canClose: () => false, relate: unused, canRelate: () => false, facts, memory: { read: unused, update: unused },
    reviews: { read: unused, update: unused }, notifyReview: () => undefined, localReviews: { read: unused, update: unused }, notifyLocalReview: () => undefined,
  });
  const http = app.listen(0);
  t.after(() => http.close());
  await once(http, 'listening');
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/hooks/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-hive-pty': ptyId } } }));
  t.after(() => client.close());
  return client;
}

async function call(client: Client): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: 'hive_task', arguments: {} })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

test('hive_task is listed by default and answers the stage worker\'s task as JSON, with the workspace\'s GitHub repository and the comments its source reads on the call (#7)', async (t) => {
  const client = await harness(t, stateWith([LEAF]), new Map([['gh', { comments: async () => [COMMENT] }]]));
  assert.equal((await client.listTools()).tools.find((tool) => tool.name === 'hive_task')?.description, TASK_DESCRIPTION);
  const answer = await call(client);
  assert.equal(answer.isError, false);
  assert.deepEqual(JSON.parse(answer.text) as unknown, { task: { ...LEAF_ANSWER, repository: 'acme/r', comments: [COMMENT] } });
});

test('a source whose comments throw answers commentsError beside the rest of the task (#7)', async (t) => {
  const failing = { comments: async (): Promise<TaskComment[]> => { throw new Error('boom'); } };
  const answer = await call(await harness(t, stateWith([LEAF]), new Map([['gh', failing]])));
  assert.deepEqual(JSON.parse(answer.text) as unknown, { task: { ...LEAF_ANSWER, repository: 'acme/r', commentsError: 'boom' } });
});

test('a local session has hive_task and gets task: null, no error (#7)', async (t) => {
  const client = await harness(t, withLocal(stateWith([LEAF], [LOCAL_WORKER]), 'hive'), NO_SOURCES, [], 'p2');
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'hive_task'));
  assert.deepEqual(await call(client), { text: '{"task":null}', isError: false });
});

test('mcp.off with hive_task leaves it out of tools/list, and a call gets the SDK\'s unknown-tool answer (#7)', async (t) => {
  const client = await harness(t, stateWith([LEAF]), NO_SOURCES, ['hive_task']);
  assert.equal((await client.listTools()).tools.some((tool) => tool.name === 'hive_task'), false);
  const answer = await call(client);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Tool hive_task not found/);
});
