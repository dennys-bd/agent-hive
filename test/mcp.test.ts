import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ASK_REPLY, canCloseTask, mountMcp, NO_SESSION_MESSAGE, NOT_PARTICIPANT_MESSAGE, REPLY_TEXT_MESSAGE, THREAD_RESOLVED_MESSAGE, UNKNOWN_THREAD_MESSAGE, UNKNOWN_WORKER_MESSAGE } from '../src/mcp.js';
import { conventionsAnswer, forkConventions, nestedConventions } from '../src/mcp-conventions.js';
import { noCreateMessage } from '../src/create-task.js';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import { MEMORY_FULL_MESSAGE, MEMORY_SECRET_MESSAGE, MEMORY_TEXT_MESSAGE, memoryPath, memoryUsed, WHY_MESSAGE } from '../src/memory.js';
import { worktreePath } from '../src/worktree.js';
import { localReviewPath, reviewPath } from '../src/review-store.js';
import { activityOf, localActivityId, prsOf, recordOf, resultOf } from '../src/activities.js';
import { systemLanguage } from '../src/language.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import type { Activity, Config, Exec, SourceConfig, State, Task, ItemAction, ReviewFile, SettingsBody, Worker, Workspace } from '../src/types.js';
import { FEEDBACK_MAX, type MemoryFile } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT, MCP_DEFAULTS } from '../src/types.js';
import { AUTH, STAGES, fakeFacts, fakeSourceFactory, GITHUB_ENTRY, fakeLog, fakeSpawn, WORKSPACE, workspacesAt, tempHive } from './fakes.js';
import type { RecordInput } from '../src/facts.js';
import { SECRET_HEADER } from '../src/secret.js';
import { reviewEventDuring, send } from './review-server.js';
import { hiveFetch, SECRET } from './secret-client.js';

// One worker: the fake source's task runs in it, so its worker is the live one. `later` is a second Comb stage without a prompt.
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY],
  stages: [...STAGES, { name: 'later', from: {} }], onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const EVENT_TYPES = ['done', 'pr', 'ask', 'createTask', 'stop'];

interface Hive { base: string; server: HiveServer; lines: string[]; ptyId: string; actions: ItemAction[]; home: string; repo: string; records: RecordInput[] }

const worker0 = (server: HiveServer): Worker => server.getState()!.workers[0];
const task0 = (server: HiveServer): Task => server.getState()!.tasks[0];
// Its live activity (#629): the run fields
const work0 = (server: HiveServer): Activity | undefined => activityOf(server.getState()!, task0(server).item.itemId);
// dispatch logs every event it reduces at debug; the fake log keeps every level
const dispatched = (lines: string[]): string[] => lines.filter((line) => EVENT_TYPES.some((type) => line.startsWith(`DEBUG ${type} `)));

async function start(t: TestContext, sources: SourceConfig[] = [GITHUB_ENTRY], workspace: Partial<Workspace> = {}, stages: unknown[] = BODY.stages ?? [], extra: Partial<ServerDeps> = {}): Promise<Hive> {
  const { home, repo } = await tempHive(t, 1);
  const { log, lines } = fakeLog();
  const { factory, actions } = fakeSourceFactory();
  const { facts, records } = fakeFacts();
  const server = createServer({ secret: SECRET, home, sourceFactory: factory, launchPty: fakeSpawn().spawn, log, facts, exec: async () => ({ stdout: '' }), ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const workspaces = workspacesAt(repo).map((w) => ({ ...w, ...workspace })); // what the workspace card saves: memoryCap (#73)
  const saved = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, sources, workspaces, stages }) });
  assert.equal(saved.status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' }); // the task spawns into the one worker
  return { base, server, lines, ptyId: worker0(server).runId!, actions, home, repo, records };
}

async function connect(t: TestContext, base: string, ptyId?: string): Promise<Client> {
  const client = new Client({ name: 'hive-test', version: '0.0.0' });
  const headers: Record<string, string> = { [SECRET_HEADER]: SECRET, ...(ptyId === undefined ? {} : { 'x-hive-pty': ptyId }) };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/hooks/mcp`), { requestInit: { headers } }));
  t.after(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = result.content;
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true };
}

test('the thirteen tools are listed; hive_done with a live worker marks the worker and merges its result into the task (#99)', async (t) => {
  const { base, server, lines, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['benchmark_draft', 'benchmark_get', 'benchmark_list', 'hive_applied', 'hive_ask', 'hive_conventions', 'hive_create_task', 'hive_done', 'hive_pr', 'hive_remember', 'hive_reply', 'hive_stop', 'hive_task']);
  assert.deepEqual(await call(client, 'hive_done', { result: { spec: 'docs/a.md', n: 1 } }), { text: 'ok', isError: false });
  assert.equal(worker0(server).done, true);
  await call(client, 'hive_done', { result: { n: 2 } });
  assert.deepEqual(resultOf(server.getState()!, task0(server).item.itemId), { spec: 'docs/a.md', n: 2 });
  assert.deepEqual(await call(client, 'hive_done'), { text: 'ok', isError: false }, 'result is optional');
  assert.equal(dispatched(lines).length, 3);
});

test('hive_pr and hive_ask dispatch pr and ask for the live worker (#99)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_pr', { url: 'https://github.com/acme/r/pull/9' }), { text: 'ok', isError: false });
  assert.deepEqual([prsOf(server.getState()!, task0(server).item.itemId), worker0(server).status], [[{ url: 'https://github.com/acme/r/pull/9', state: 'open' }], 'working']);
  assert.deepEqual(await call(client, 'hive_ask', { question: '  Which base?  ' }), { text: ASK_REPLY, isError: false });
  assert.deepEqual([worker0(server).status, worker0(server).question, worker0(server).lastEvent], ['waiting', 'Which base?', { kind: 'ask' }]);
});

test('an unknown or missing worker id gets a tool error from every tool and dispatches nothing (#99)', async (t) => {
  const { base, server, lines } = await start(t);
  const before = JSON.stringify(server.getState());
  const calls: [string, Record<string, unknown>][] = [
    ['hive_done', {}], ['hive_pr', { url: 'https://github.com/acme/r/pull/9' }], ['hive_ask', { question: 'q?' }], ['hive_create_task', { title: 'x' }],
    ['hive_stop', { reason: 'wontDo' }], ['hive_reply', { thread: 'T1', text: 'x' }], ['hive_conventions', {}],
    ['hive_remember', { kind: 'fact', text: 'x' }], ['hive_applied', { id: 'm-1', why: 'x' }], ['hive_task', {}],
  ];
  for (const ptyId of ['ghost', undefined]) {
    const client = await connect(t, base, ptyId);
    for (const [name, args] of calls) {
      assert.deepEqual(await call(client, name, args), { text: UNKNOWN_WORKER_MESSAGE, isError: true }, `${name} as ${String(ptyId)}`);
    }
  }
  assert.deepEqual(dispatched(lines), []);
  assert.equal(JSON.stringify(server.getState()), before);
});

test('each invalid input gets a tool error with its reason and dispatches nothing (#99)', async (t) => {
  const { base, server, lines, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  const refused = async (name: string, args: Record<string, unknown>, reason: RegExp): Promise<void> => {
    const answer = await call(client, name, args);
    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args).slice(0, 60)}`);
    assert.match(answer.text, reason);
  };
  await refused('hive_done', { result: { blob: 'x'.repeat(64 * 1024) } }, /64 KB/);
  await refused('hive_pr', { url: 'http://github.com/acme/r/pull/9' }, /https/);
  await refused('hive_pr', { url: 'not a url' }, /https/);
  await refused('hive_pr', { url: 'https://evil.example/acme/r/pull/9' }, /pull request URL/);
  await refused('hive_ask', { question: '   ' }, /1 to 2000/);
  await refused('hive_ask', { question: 'x'.repeat(2001) }, /1 to 2000/);
  await refused('hive_create_task', { title: ' ' }, /título obrigatório/);
  await refused('hive_create_task', { title: 'x', stage: 'nope' }, /etapa desconhecida/);
  await refused('hive_stop', { duplicateOf: 7 }, /duplicateOf/);
  await refused('hive_stop', { reason: 'wontDo', duplicateOf: 7 }, /duplicateOf/);
  await refused('hive_stop', { reason: 'duplicate', duplicateOf: 0 }, /duplicateOf/);
  await refused('hive_stop', { reason: 'duplicate', duplicateOf: 1.5 }, /duplicateOf/);
  assert.deepEqual(dispatched(lines), []);
  assert.equal(worker0(server).done, undefined);
});

test('hive_done refuses a result whose merge with the task result would pass 64 KB, keeping the task as it was (#99)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_done', { result: { a: 'x'.repeat(40 * 1024) } }), { text: 'ok', isError: false });
  const answer = await call(client, 'hive_done', { result: { b: 'x'.repeat(40 * 1024) } });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /64 KB/);
  assert.deepEqual(Object.keys(resultOf(server.getState()!, task0(server).item.itemId) ?? {}), ['a']);
});

test('hive_create_task lands in the first Comb stage without a stage, in the named one with it, and answers the new id; GET is 405 (#99)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Follow-up', body: 'details' }), { text: 'HIVE-1', isError: false });
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Later', stage: 'later' }), { text: 'HIVE-2', isError: false });
  const created = server.getState()!.tasks.filter((c) => c.created).map((c) => [c.item.id, c.item.title, c.item.body, c.stage]);
  assert.deepEqual(created, [['HIVE-1', 'Follow-up', 'details', 'fila'], ['HIVE-2', 'Later', '', 'later']]);
  assert.equal((await hiveFetch(`${base}/hooks/mcp`)).status, 405, 'stateless: no SSE stream to open');
});

test('hive_create_task takes an optional Comb workspace for the new task and refuses an unknown one (#179)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Placed', workspace: 'hive' }), { text: 'HIVE-1', isError: false });
  assert.equal(server.getState()!.tasks.find((c) => c.created)?.workspace, 'hive');
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Lost', workspace: 'nope' }), { text: 'unknown workspace', isError: true });
});

test('hive_stop without a reason is the Stop button: the task is stopped and nothing is written; with one the issue is closed too, after the kill (#314)', async (t) => {
  const bare = await start(t);
  assert.deepEqual(await call(await connect(t, bare.base, bare.ptyId), 'hive_stop'), { text: 'ok', isError: false });
  assert.deepEqual([work0(bare.server)?.stopped, bare.actions], [true, []]);
  const { base, server, ptyId, actions } = await start(t);
  assert.deepEqual(await call(await connect(t, base, ptyId), 'hive_stop', { reason: 'duplicate', duplicateOf: 7 }), { text: 'ok', isError: false });
  assert.deepEqual([work0(server)?.stopped, actions], [true, [{ type: 'close', reason: 'duplicate', duplicateOf: 7 }]]);
});

test('canCloseTask: only a task on a source whose type can close items; a task of a removed source, a local task and an unknown id cannot (#314)', () => {
  const at = (itemId: string, board?: string): Task => ({ item: { itemId, id: '1', title: 'T', body: '', url: '', ...(board === undefined ? {} : { source: board }) }, stage: 'fila', boardColumn: 'Ready', auto: true });
  const state = { ...initialState(1), tasks: [at('gh:I1', 'gh'), at('old:I2', 'old'), { ...at('local:1'), created: true as const }] };
  const sources: SourceConfig[] = [{ ...GITHUB_ENTRY, name: 'gh' }];
  assert.deepEqual(['gh:I1', 'old:I2', 'local:1', 'gh:I9'].map((id) => canCloseTask(state, sources, id)), [true, false, false, false]);
});

const ANCHOR = { scope: 'worktree', path: 'a.ts', side: 'new', start: 1, end: 1, excerpt: ['x'] } as const;
const threadFor = (id: string, participants: string[]) => ({ id, anchor: ANCHOR, participants, messages: [{ id: `${id}-m`, author: 'user', at: 'T', text: 'why?', to: participants }] });
async function seed(home: string, itemId: string, threads: unknown[]): Promise<void> {
  const path = reviewPath(home, itemId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ reviewed: [], drafts: [], threads }));
}
// The stage run's session id, as its SessionStart reports it
async function withSession(t: TestContext) {
  const hive = await start(t);
  const sessionId = work0(hive.server)!.sessionId!;
  await hive.server.dispatch({ type: 'hook', ptyId: hive.ptyId, payload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: hive.repo } });
  return { ...hive, sessionId, itemId: task0(hive.server).item.itemId };
}

test('hive_reply appends a participant\'s trimmed answer to its task\'s conversation and broadcasts the review event (#591)', async (t) => {
  const h = await withSession(t);
  await seed(h.home, h.itemId, [threadFor('T1', [h.sessionId])]);
  const client = await connect(t, h.base, h.ptyId);
  const event = await reviewEventDuring(h.base, async () => assert.deepEqual(await call(client, 'hive_reply', { thread: 'T1', text: '  because  ' }), { text: 'ok', isError: false }));
  assert.deepEqual(event, { type: 'review', taskId: h.itemId });
  const file = JSON.parse(await readFile(reviewPath(h.home, h.itemId), 'utf8')) as ReviewFile;
  assert.deepEqual(file.threads[0].messages.at(-1)?.author, { session: h.sessionId });
  assert.equal(file.threads[0].messages.at(-1)?.text, 'because');
});

test('hive_reply refuses a non-participant, another task\'s or an unknown conversation, a bad text and a worker with no session yet (#591)', async (t) => {
  const bare = await start(t);
  assert.deepEqual(await call(await connect(t, bare.base, bare.ptyId), 'hive_reply', { thread: 'T1', text: 'x' }), { text: NO_SESSION_MESSAGE, isError: true });
  const h = await withSession(t);
  await seed(h.home, h.itemId, [threadFor('T2', ['other-session-0001'])]);
  await seed(h.home, 'local:9', [threadFor('T3', [h.sessionId])]);
  const client = await connect(t, h.base, h.ptyId);
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T2', text: 'x' }), { text: NOT_PARTICIPANT_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T3', text: 'x' }), { text: UNKNOWN_THREAD_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T9', text: 'x' }), { text: UNKNOWN_THREAD_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T2', text: ' ' }), { text: REPLY_TEXT_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T2', text: 'x'.repeat(10_001) }), { text: REPLY_TEXT_MESSAGE, isError: true });
});

test('hive_reply resolve: true marks the thread agent-resolved and leaves it open; confirm keeps the mark, reopen drops it, a resolved one refuses (#111)', async (t) => {
  const h = await withSession(t);
  await seed(h.home, h.itemId, [threadFor('T1', [h.sessionId]), { ...threadFor('T2', [h.sessionId]), resolved: true }]);
  const client = await connect(t, h.base, h.ptyId);
  const onDisk = async (): Promise<ReviewFile> => JSON.parse(await readFile(reviewPath(h.home, h.itemId), 'utf8')) as ReviewFile;
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T1', text: 'done', resolve: true }), { text: 'ok', isError: false });
  const [marked] = (await onDisk()).threads;
  assert.deepEqual([marked.messages.at(-1)?.text, marked.agentResolved?.session, marked.agentResolved?.at, marked.resolved], ['done', h.sessionId, marked.messages.at(-1)?.at, undefined]);
  const resolveRoute = (resolved: boolean) => send(h.base, 'POST', `/tasks/${encodeURIComponent(h.itemId)}/review/threads/T1/resolve`, { resolved });
  assert.equal((await resolveRoute(true)).status, 200);
  assert.deepEqual([(await onDisk()).threads[0].resolved, (await onDisk()).threads[0].agentResolved?.session], [true, h.sessionId]);
  assert.equal((await resolveRoute(false)).status, 200);
  assert.deepEqual([(await onDisk()).threads[0].resolved, (await onDisk()).threads[0].agentResolved], [undefined, undefined]);
  assert.deepEqual(await call(client, 'hive_reply', { thread: 'T2', text: 'done', resolve: true }), { text: THREAD_RESOLVED_MESSAGE, isError: true });
  assert.equal((await onDisk()).threads[1].messages.length, 1, 'the refused call wrote nothing');
});

async function seedLocal(home: string, threads: unknown[]): Promise<void> {
  const path = localReviewPath(home, WORKSPACE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ reviewed: [], drafts: [], threads }));
}
const localOnDisk = async (home: string): Promise<ReviewFile> => JSON.parse(await readFile(localReviewPath(home, WORKSPACE), 'utf8')) as ReviewFile;
// withSession's Hive plus a local session of its workspace, its id named at the spawn (#590)
async function withLocalSession(t: TestContext) {
  const h = await withSession(t);
  await h.server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const local = h.server.getState()!.workers.find((s) => s.activityId === localActivityId(WORKSPACE) && s.status !== 'empty');
  if (!local?.runId || !local.sessionId) throw new Error('the local run did not start');
  return { ...h, localPty: local.runId, localSession: local.sessionId };
}

test('hive_reply from a local session appends to its workspace\'s local conversation and broadcasts the workspace\'s review event (#344)', async (t) => {
  const h = await withLocalSession(t);
  await seedLocal(h.home, [threadFor('T1', [h.localSession])]);
  const client = await connect(t, h.base, h.localPty);
  const event = await reviewEventDuring(h.base, async () => assert.deepEqual(await call(client, 'hive_reply', { thread: 'T1', text: ' fixed ', resolve: true }), { text: 'ok', isError: false }));
  assert.deepEqual(event, { type: 'review', workspace: WORKSPACE });
  const [thread] = (await localOnDisk(h.home)).threads;
  assert.deepEqual([thread.messages.at(-1)?.author, thread.messages.at(-1)?.text, thread.agentResolved?.session], [{ session: h.localSession }, 'fixed', h.localSession]);
});

test('hive_reply keeps local and task conversations apart and refuses a local session that is not a participant (#344)', async (t) => {
  const h = await withLocalSession(t);
  await seedLocal(h.home, [threadFor('L1', ['other-session-0001']), threadFor('L2', [h.sessionId])]);
  await seed(h.home, h.itemId, [threadFor('T1', [h.localSession])]);
  const local = await connect(t, h.base, h.localPty);
  assert.deepEqual(await call(local, 'hive_reply', { thread: 'L1', text: 'x' }), { text: NOT_PARTICIPANT_MESSAGE, isError: true });
  assert.deepEqual(await call(local, 'hive_reply', { thread: 'T1', text: 'x' }), { text: UNKNOWN_THREAD_MESSAGE, isError: true }, 'a local session never reaches a task\'s file');
  const task = await connect(t, h.base, h.ptyId);
  assert.deepEqual(await call(task, 'hive_reply', { thread: 'L2', text: 'x' }), { text: UNKNOWN_THREAD_MESSAGE, isError: true }, 'a task\'s session never reaches a local file');
});

test('hive_done and hive_pr from a worker land in its activity\'s record (#629)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  await call(client, 'hive_done', { result: { spec: 'docs/a.md' } });
  await call(client, 'hive_pr', { url: 'https://github.com/acme/r/pull/9' });
  const state = server.getState()!;
  const record = recordOf(state, activityOf(state, task0(server).item.itemId)!.id);
  assert.deepEqual([record?.result, record?.prs], [{ spec: 'docs/a.md' }, [{ url: 'https://github.com/acme/r/pull/9', state: 'open' }]]);
});

test('hive_pr takes a slice: a valid one reaches the record; a k of 0, a fraction or an unknown type is refused by the schema and dispatches nothing; without one none is stored (#698)', async (t) => {
  const { base, server, lines, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  const url = 'https://github.com/acme/r/pull/9';
  for (const slice of [{ k: 0, type: 'stacked' }, { k: 1.5, type: 'stacked' }, { k: 1, type: 'single' }]) {
    const answer = await call(client, 'hive_pr', { url, slice });
    assert.equal(answer.isError, true, JSON.stringify(slice));
    assert.match(answer.text, /Input validation error/);
  }
  assert.deepEqual(dispatched(lines), []);
  assert.deepEqual(await call(client, 'hive_pr', { url, slice: { k: 2, type: 'stacked' } }), { text: 'ok', isError: false });
  await call(client, 'hive_pr', { url: 'https://github.com/acme/r/pull/10' });
  assert.deepEqual(prsOf(server.getState()!, task0(server).item.itemId), [
    { url, state: 'open', slice: { k: 2, type: 'stacked' } }, { url: 'https://github.com/acme/r/pull/10', state: 'open' },
  ]);
});

test('hive_conventions answers the Hive\'s language, the stage\'s approval and its name, and no conventions key; its description names only those (#692, #318)', async (t) => {
  const { base, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  const description = (await client.listTools()).tools.find((tool) => tool.name === 'hive_conventions')?.description ?? '';
  assert.match(description, /approval/);
  assert.doesNotMatch(description, /conventions set|docs folders|delivery|slice size|feature flags|UI check|test command|decomposition label/);
  const answer = await call(client, 'hive_conventions');
  assert.deepEqual([answer.isError, JSON.parse(answer.text)], [false, { hiveLanguage: systemLanguage(), approval: false, stage: 'fila', nestedRepos: [] }]);
});

test('conventionsAnswer: a stage run reads its stage\'s approval; a free session has no stage; a local session neither (#692, #318)', () => {
  const config = {
    language: 'pt' as const,
    comb: { prefix: 'HIVE', sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }] },
  };
  const task: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'T', body: '', url: '' }, stage: 'spec', boardColumn: '', auto: true, workspace: 'site' };
  const state = {
    ...initialState(0), stages: [{ name: 'spec', from: {}, prompt: '/x', approval: true as const }], tasks: [task],
    activities: [{ id: 'a1', kind: 'task' as const, workspace: 'site' }, { id: 'local:hive', kind: 'local' as const, workspace: 'hive' }],
    activityRecords: [{ id: 'a1', taskIds: ['local:1'], sessions: [] }],
  };
  const run: Worker = { id: 'w1', runId: 'r1', activityId: 'a1', status: 'working' };
  assert.deepEqual(conventionsAnswer(state, config, run), { hiveLanguage: 'pt', approval: true, stage: 'spec', nestedRepos: [] });
  assert.deepEqual(conventionsAnswer(state, config, { ...run, freeSession: true }), { hiveLanguage: 'pt', approval: false, nestedRepos: [] });
  const local: Worker = { id: 'w2', runId: 'r2', activityId: 'local:hive', status: 'working' };
  assert.deepEqual(conventionsAnswer(state, { ...config, language: undefined }, local), { hiveLanguage: systemLanguage(), approval: false, nestedRepos: [] });
});

// Each mcp.call without its latency, which only has to be a number
const mcpCalls = (records: RecordInput[]): Record<string, unknown>[] => records.filter((r) => r.event === 'mcp.call').map((r) => {
  const { latency_ms: latency, ...rest } = r as unknown as Record<string, unknown>;
  assert.equal(typeof latency, 'number');
  return rest;
});

test('an accepted call writes mcp.call ok; hive_done names its result\'s keys only, never the values (#742)', async (t) => {
  const { base, records, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  await call(client, 'hive_done', { result: { spec: 'docs/secret-path.md', n: 1 } });
  await call(client, 'hive_ask', { question: 'Which base?' });
  const calls = mcpCalls(records);
  assert.deepEqual(calls.map((c) => [c.tool, c.level, c.outcome, c.result_keys, c.reason]), [['hive_done', 'info', 'ok', ['spec', 'n'], undefined], ['hive_ask', 'info', 'ok', undefined, undefined]]);
  assert.equal(calls[0].stage, 'fila');
  assert.ok(!JSON.stringify(records).includes('secret-path'));
  assert.ok(!JSON.stringify(records).includes('Which base'));
});

test('every refusal writes mcp.call at warn with its code (#742)', async (t) => {
  // No source type today refuses close, but a task created in the Hive has no source at all: the worker is freed for one, so hive_stop
  // refuses its reason
  const { base, server, records, ptyId: first } = await start(t);
  await server.dispatch({ type: 'stop', ptyId: first });
  await server.dispatch({ type: 'exit', ptyId: first });
  await server.dispatch({ type: 'createTask', title: 'Local', body: '', stage: 'fila', prefix: 'HIVE', auto: true });
  const ptyId = worker0(server).runId;
  assert.ok(ptyId !== undefined, 'the local task spawned');
  const client = await connect(t, base, ptyId);
  await call(await connect(t, base, 'ghost'), 'hive_done');
  await call(client, 'hive_done', { result: { blob: 'x'.repeat(64 * 1024) } });
  await call(client, 'hive_pr', { url: 'not a url' });
  await call(client, 'hive_ask', { question: '   ' });
  await call(client, 'hive_create_task', { title: ' ' });
  await call(client, 'hive_stop', { duplicateOf: 7 });
  await call(client, 'hive_stop', { reason: 'wontDo' });
  await call(client, 'hive_reply', { thread: 'T1', text: 'x' }); // no SessionStart yet: no session id
  assert.deepEqual(mcpCalls(records).map((c) => [c.tool, c.level, c.outcome, c.reason]), [
    ['hive_done', 'warn', 'refused', 'unknown_worker'], ['hive_done', 'warn', 'refused', 'bad_result'], ['hive_pr', 'warn', 'refused', 'bad_url'],
    ['hive_ask', 'warn', 'refused', 'bad_question'], ['hive_create_task', 'warn', 'refused', 'event'], ['hive_stop', 'warn', 'refused', 'duplicate_of'],
    ['hive_stop', 'warn', 'refused', 'cannot_close'], ['hive_reply', 'warn', 'refused', 'no_session'],
  ]);
});

test('result_keys keeps at most 20 keys of a safe shape and counts the ones left out (#742)', async (t) => {
  const { base, records, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  const keys = Array.from({ length: 22 }, (_, i) => `key_${i}`);
  const result = Object.fromEntries([['bad key /Users/x', 1], ['k'.repeat(41), 1], ...keys.map((key) => [key, 1])]);
  assert.deepEqual(await call(client, 'hive_done', { result }), { text: 'ok', isError: false });
  const [done] = mcpCalls(records);
  assert.deepEqual([done?.result_keys, done?.result_keys_dropped], [keys.slice(0, 20), 4]);
});

test('a handler that throws still writes mcp.call with outcome error at error, and the agent still gets the failure (#742)', async (t) => {
  const { facts, records } = fakeFacts();
  const state = { ...initialState(1), workers: [{ id: 'w1', runId: 'p1', status: 'working' }] } as State;
  const app = express().use(express.json());
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  mountMcp(app, {
    exec: async () => ({ stdout: '' }),
    live: () => ({ state, config: { mcp: MCP_DEFAULTS } as Config, sources: new Map() }), poll: async () => undefined, dispatch: async () => { throw new Error('reducer'); }, canClose: () => false,
    relate: unused, canRelate: () => false,
    reviews: { read: unused, update: unused }, notifyReview: () => undefined, localReviews: { read: unused, update: unused }, notifyLocalReview: () => undefined, facts, memory: { read: unused, update: unused }, benchmark: { draft: unused },
  });
  const http = app.listen(0);
  t.after(() => http.close());
  await once(http, 'listening');
  const client = await connect(t, `http://127.0.0.1:${(http.address() as AddressInfo).port}`, 'p1');
  assert.equal((await call(client, 'hive_ask', { question: 'Which base?' })).isError, true);
  assert.deepEqual(mcpCalls(records).map((c) => [c.tool, c.level, c.outcome]), [['hive_ask', 'error', 'error']]);
});

type MemoryChanged = Extract<RecordInput, { event: 'memory.changed' }>;
type MemoryApplied = Extract<RecordInput, { event: 'memory.applied' }>;
const memoryFile = async (home: string): Promise<MemoryFile> => JSON.parse(await readFile(memoryPath(home, WORKSPACE), 'utf8')) as MemoryFile;

test('hive_remember saves a lesson with its task and stage from a stage run and only its task from a free session; the stage protocol carries it; memory.changed and mcp.call name its kind, never its text (#797)', async (t) => {
  const { base, server, home, repo, records, ptyId } = await start(t);
  assert.deepEqual(await call(await connect(t, base, ptyId), 'hive_remember', { kind: 'fact', text: '  pnpm test is the gate here  ' }), { text: 'saved as m-1', isError: false });
  const slug = work0(server)!.slug!;
  await server.dispatch({ type: 'worktreeReady', activityId: work0(server)!.id, path: worktreePath(repo, slug), branch: `hive/${slug}`, base: null, local: false }); // a session needs the activity's worktree
  await server.dispatch({ type: 'openSession', activityId: work0(server)!.id }); // appended beside the stage run (#459)
  const free = server.getState()!.workers.find((w) => w.freeSession)?.runId;
  assert.ok(free !== undefined, 'the free session runs');
  assert.deepEqual(await call(await connect(t, base, free), 'hive_remember', { kind: 'pref', text: 'answer in Portuguese' }), { text: 'saved as m-2', isError: false });
  assert.deepEqual((await memoryFile(home)).entries.map((e) => [e.id, e.kind, e.text, e.origin, e.uses]), [
    ['m-1', 'fact', 'pnpm test is the gate here', { task: '1', stage: 'fila' }, 0], ['m-2', 'pref', 'answer in Portuguese', { task: '1' }, 0],
  ]);
  const stage = await readFile(workspaceProtocolPaths(home, WORKSPACE).stage, 'utf8');
  assert.ok(stage.endsWith('### Preferences\n- [m-2] answer in Portuguese\n\n### Repository facts\n- [m-1] pnpm test is the gate here\n'), stage);
  const changed = records.filter((r): r is MemoryChanged => r.event === 'memory.changed');
  assert.deepEqual(changed.map((r) => [r.action, r.kind, r.by, r.id, r.entries, r.used, r.workspace, r.stage]), [
    ['added', 'fact', 'worker', 'm-1', 1, 26, WORKSPACE, 'fila'], ['added', 'pref', 'worker', 'm-2', 2, 46, WORKSPACE, undefined],
  ]);
  assert.deepEqual(mcpCalls(records).filter((c) => c.tool === 'hive_remember').map((c) => [c.outcome, c.kind]), [['ok', 'fact'], ['ok', 'pref']]);
  assert.ok(!JSON.stringify(records).includes('gate here') && !JSON.stringify(records).includes('Portuguese'), 'no lesson text in any record');
});

test('hive_remember refuses an unknown worker, a text that is not one line of 1 to 300 characters, a secret and a lesson that would pass the workspace\'s memoryCap, and writes nothing for them (#797, #73)', async (t) => {
  const { base, home, records, ptyId } = await start(t, [GITHUB_ENTRY], { memoryCap: 500, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' });
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(await connect(t, base, 'ghost'), 'hive_remember', { kind: 'fact', text: 'x' }), { text: UNKNOWN_WORKER_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_remember', { kind: 'fact', text: 'two\nlines' }), { text: MEMORY_TEXT_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_remember', { kind: 'avoid', text: `never paste ${'Zx9'.repeat(11)}` }), { text: MEMORY_SECRET_MESSAGE, isError: true });
  const answers: { text: string; isError: boolean }[] = [];
  for (let n = 1; n <= 3; n += 1) answers.push(await call(client, 'hive_remember', { kind: 'fact', text: `lesson ${n} ${'y'.repeat(240)}` })); // 249 characters: two fit in 500
  assert.deepEqual(answers.map((a) => a.isError), [false, false, true]);
  assert.deepEqual(answers.at(-1), { text: MEMORY_FULL_MESSAGE, isError: true });
  const { entries } = await memoryFile(home);
  assert.deepEqual([entries.length, memoryUsed(entries)], [2, 498]);
  const reasons = mcpCalls(records).filter((c) => c.tool === 'hive_remember' && c.outcome === 'refused').map((c) => c.reason);
  assert.deepEqual([...reasons.slice(0, 3), reasons.at(-1)], ['unknown_worker', 'bad_memory', 'memory_secret', 'memory_full']);
});

test('hive_applied counts a citation with the stage from a stage run, refuses an unknown id and a bad why, writes memory.applied without the why and leaves the protocol files alone (#797)', async (t) => {
  const { base, home, records, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  await call(client, 'hive_remember', { kind: 'avoid', text: 'never edit dist/ by hand' });
  const { stage } = workspaceProtocolPaths(home, WORKSPACE);
  await writeFile(stage, 'as launched');
  assert.deepEqual(await call(client, 'hive_applied', { id: 'm-1', why: ' rebuilt instead of patching dist/ ' }), { text: 'ok', isError: false });
  assert.deepEqual(await call(client, 'hive_applied', { id: 'm-7', why: 'x' }), { text: "no lesson m-7 in this workspace's memory", isError: true });
  assert.deepEqual(await call(client, 'hive_applied', { id: 'm-1', why: '' }), { text: WHY_MESSAGE, isError: true });
  assert.deepEqual(await call(client, 'hive_applied', { id: 'm-1', why: `used ${'Zx9'.repeat(11)}` }), { text: MEMORY_SECRET_MESSAGE, isError: true });
  const [lesson] = (await memoryFile(home)).entries;
  const { at, ...used } = lesson.lastUsed ?? { at: '' };
  assert.deepEqual([lesson.uses, used], [1, { task: '1', stage: 'fila', why: 'rebuilt instead of patching dist/' }]);
  assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await readFile(stage, 'utf8'), 'as launched', 'a citation is not rendered');
  const applied = records.filter((r): r is MemoryApplied => r.event === 'memory.applied');
  assert.deepEqual(applied.map((r) => [r.id, r.kind, r.uses, r.stage, r.workspace]), [['m-1', 'avoid', 1, 'fila', WORKSPACE]]);
  assert.deepEqual(mcpCalls(records).filter((c) => c.tool === 'hive_applied').map((c) => c.reason), [undefined, 'unknown_memory', 'bad_memory', 'memory_secret']);
  assert.ok(!JSON.stringify(records).includes('rebuilt'), 'no why in any record');
});

test('forkConventions answers a fork\'s PR target, both repositories, the base remote and the effective base; nothing for a workspace that is not a fork or whose remotes are off GitHub; conventionsAnswer carries it only when given (#854)', async () => {
  const urls: Record<string, string> = { upstream: 'https://github.com/acme/app.git\n', origin: 'git@github.com:me/app.git\n' };
  const exec: Exec = async (_file, args) => {
    if (args.includes('get-url')) return { stdout: urls[args.at(-1) ?? ''] ?? '' };
    return { stdout: args.includes('symbolic-ref') ? 'upstream/master\n' : '' };
  };
  const app: Workspace = { name: 'app', path: '/app', env: {}, fork: { remote: 'upstream', pr: 'original' }, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' };
  const original = { pr: 'original', original: 'acme/app', fork: 'me/app', baseRemote: 'upstream', base: 'master' };
  assert.deepEqual(await forkConventions(exec, app, {}), original);
  assert.deepEqual(await forkConventions(exec, { ...app, baseBranch: 'devtest' }, { baseBranch: 'main' }), { ...original, base: 'devtest' });
  assert.deepEqual(await forkConventions(exec, { ...app, fork: { remote: 'upstream', pr: 'fork', sync: 'github' } }, { baseBranch: 'main' }), { ...original, pr: 'fork', baseRemote: 'origin', base: 'main' });
  assert.equal(await forkConventions(exec, { ...app, fork: null }, {}), undefined);
  assert.equal(await forkConventions(async () => ({ stdout: 'https://gitlab.com/a/b.git\n' }), app, {}), undefined);
  assert.equal(await forkConventions(exec, undefined, {}), undefined);
  const config = { language: 'pt' as const, comb: { prefix: 'HIVE', sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive', workspaces: [app] } };
  const state = { ...initialState(0), activities: [{ id: 'local:app', kind: 'local' as const, workspace: 'app' }] };
  const local: Worker = { id: 'w1', runId: 'r1', activityId: 'local:app', status: 'working' };
  assert.deepEqual(conventionsAnswer(state, config, local, { ...original, pr: 'original' }), { hiveLanguage: 'pt', approval: false, fork: original, nestedRepos: [] });
  assert.equal('fork' in conventionsAnswer(state, config, local), false);
});

test('hive_done takes one of the stage\'s verdicts and its evidence into result.verdict and the worker; an unknown verdict, an evidence over the cap or an evidence alone is refused (#134)', async (t) => {
  const { base, server, ptyId } = await start(t, [GITHUB_ENTRY], undefined, [{ ...STAGES[0], verdicts: ['ok', 'redo'] }, { name: 'later', from: {} }]);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'maybe' }), { text: 'verdict must be one of this stage\'s: ok, redo', isError: true });
  assert.deepEqual(await call(client, 'hive_done', { evidence: 'x' }), { text: 'evidence needs a verdict', isError: true });
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'redo', evidence: 'x'.repeat(FEEDBACK_MAX + 1) }), { text: `evidence must be at most ${FEEDBACK_MAX} characters`, isError: true });
  assert.equal(worker0(server).done, undefined, 'nothing refused reached the worker');
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'redo', evidence: 'src/a.ts:3' }), { text: 'ok', isError: false });
  assert.deepEqual([worker0(server).done, worker0(server).verdict], [true, 'redo']);
  assert.deepEqual(resultOf(server.getState()!, task0(server).item.itemId)?.verdict, { name: 'redo', evidence: 'src/a.ts:3' });
});

test('hive_done strips control characters from the evidence and checks the size of the result merged with the verdict (#134)', async (t) => {
  const { base, server, ptyId } = await start(t, [GITHUB_ENTRY], undefined, [{ ...STAGES[0], verdicts: ['redo'] }, { name: 'later', from: {} }]);
  const client = await connect(t, base, ptyId);
  const big = { big: 'x'.repeat(60 * 1024) };
  assert.deepEqual(await call(client, 'hive_done', { result: big, verdict: 'redo', evidence: 'y'.repeat(FEEDBACK_MAX) }), { text: 'result, merged with the task\'s, is over 64 KB serialized', isError: true });
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'redo', evidence: 'a\x1b[31mb\x07' }), { text: 'ok', isError: false });
  assert.deepEqual(resultOf(server.getState()!, task0(server).item.itemId)?.verdict, { name: 'redo', evidence: 'a[31mb' });
});

test('hive_done refuses a verdict passed inside result, naming the stage\'s and its own field, and dispatches nothing (#493)', async (t) => {
  const { base, server, ptyId } = await start(t, [GITHUB_ENTRY], undefined, [{ ...STAGES[0], verdicts: ['leaf', 'split'] }, { name: 'later', from: {} }]);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_done', { result: { verdict: 'leaf' } }), { text: 'verdict is missing: pass one of this stage\'s: leaf, split, in its own verdict field, not inside result', isError: true });
  assert.equal(worker0(server).done, undefined, 'the run goes on');
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'leaf' }), { text: 'ok', isError: false });
});

test('hive_done in a stage with no verdicts refuses one (#134)', async (t) => {
  const { base, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_done', { verdict: 'ok' }), { text: 'this stage gives no verdict', isError: true });
});

test('hive_create_task resolves its source like POST /tasks: absent is comb.createIn, hive by name, a source without a repository refused alike (#846)', async (t) => {
  const { base, server, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Default' }), { text: 'HIVE-1', isError: false });
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Named', source: 'hive' }), { text: 'HIVE-2', isError: false });
  assert.deepEqual(await call(client, 'hive_create_task', { title: 'Nope', source: 'board' }), { text: noCreateMessage('board'), isError: true });
  const res = await hiveFetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ title: 'Nope', stage: 'fila', source: 'board' }) });
  assert.deepEqual(await res.json(), { error: noCreateMessage('board') }, 'the route answers the same words');
  assert.equal(server.getState()!.tasks.filter((c) => c.created).length, 2);
});

test('hive_stop with block on a hive task writes the relation through blockerSet and leaves the task blocked, not stopped, and not refilled (#294)', async (t) => {
  const { base, server, ptyId: first } = await start(t);
  await server.dispatch({ type: 'stop', ptyId: first });
  await server.dispatch({ type: 'exit', ptyId: first });
  await server.dispatch({ type: 'createTask', title: 'Local', body: '', stage: 'fila', prefix: 'HIVE', auto: true });
  const ptyId = worker0(server).runId!;
  await server.dispatch({ type: 'createTask', title: 'Blocker', body: '', stage: 'later', prefix: 'HIVE', auto: true }); // later has no prompt: never a run
  assert.deepEqual(await call(await connect(t, base, ptyId), 'hive_stop', { block: ['HIVE-2'] }), { text: 'ok', isError: false });
  await server.dispatch({ type: 'exit', ptyId });
  const local = server.getState()!.tasks.find((c) => c.item.id === 'HIVE-1')!;
  assert.deepEqual([local.item.blockedBy, activityOf(server.getState()!, local.item.itemId)?.stopped], [['HIVE-2'], undefined]);
  assert.equal(server.getState()!.workers.some((w) => w.status !== 'empty'), false, 'the fill does not take it back while blocked');
});

test('a tool turned off in mcp.off leaves tools/list and a call to it gets the SDK\'s unknown-tool answer; the locked tools stay (#333)', async (t) => {
  const { base, ptyId, repo } = await start(t);
  const off = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, workspaces: workspacesAt(repo), mcp: { off: ['hive_remember'], servers: [] } }) });
  assert.equal(off.status, 200);
  const client = await connect(t, base, ptyId);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['benchmark_draft', 'benchmark_get', 'benchmark_list', 'hive_applied', 'hive_ask', 'hive_conventions', 'hive_create_task', 'hive_done', 'hive_pr', 'hive_reply', 'hive_stop', 'hive_task']);
  const answer = await call(client, 'hive_remember', { kind: 'fact', text: 'x' });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Tool hive_remember not found/);
});

test('nestedConventions answers each nested repo with its GitHub repository, none for one off GitHub; conventionsAnswer carries the list, [] without one (#653)', async () => {
  const urls: Record<string, string> = { '/app/docs': 'https://github.com/acme/docs.git\n', '/app/ee': 'https://gitlab.com/acme/ee.git\n' };
  const exec: Exec = async (_file, args) => ({ stdout: urls[args[1]] ?? '' });
  const app: Workspace = { name: 'app', path: '/app', env: {}, fork: null, nestedRepos: ['docs', 'ee'], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' };
  const nested = await nestedConventions(exec, app);
  assert.deepEqual(nested, [{ path: 'docs', repository: 'acme/docs' }, { path: 'ee' }]);
  assert.deepEqual(await nestedConventions(exec, undefined), []);
  const config = { language: 'pt' as const, comb: { prefix: 'HIVE', sources: [], transitions: [], stages: [], commands: [], hiveSource: true, createIn: 'hive', workspaces: [app] } };
  const state = { ...initialState(0), activities: [{ id: 'local:app', kind: 'local' as const, workspace: 'app' }] };
  const local: Worker = { id: 'w1', runId: 'r1', activityId: 'local:app', status: 'working' };
  assert.deepEqual(conventionsAnswer(state, config, local, undefined, nested), { hiveLanguage: 'pt', approval: false, nestedRepos: nested });
});

const PR9 = 'https://github.com/acme/r/pull/9';

test('hive_pr answers without waiting for its preload, which it starts with the url; a refused call preloads nothing (#497)', async (t) => {
  const urls: string[] = [];
  const pending = (url: string): Promise<void> => { urls.push(url); return new Promise<void>(() => undefined); }; // never settles
  const { base, ptyId } = await start(t, [GITHUB_ENTRY], {}, BODY.stages ?? [], { preloadPr: pending });
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_pr', { url: PR9 }), { text: 'ok', isError: false });
  assert.deepEqual(urls, [PR9]);
  await call(client, 'hive_pr', { url: 'not a url' });
  assert.deepEqual(urls, [PR9]);
});

test('a rejected preload changes nothing in hive_pr\'s answer or its record (#497)', async (t) => {
  const { base, server, ptyId } = await start(t, [GITHUB_ENTRY], {}, BODY.stages ?? [], { preloadPr: async () => { throw new Error('boom'); } });
  const client = await connect(t, base, ptyId);
  assert.deepEqual(await call(client, 'hive_pr', { url: PR9 }), { text: 'ok', isError: false });
  assert.deepEqual(prsOf(server.getState()!, task0(server).item.itemId), [{ url: PR9, state: 'open' }]);
});

test('the default preload of a Hive with no read model is a debug line by number (#497)', async (t) => {
  const { base, lines, ptyId } = await start(t);
  const client = await connect(t, base, ptyId);
  await call(client, 'hive_pr', { url: PR9 });
  for (let i = 0; i < 100 && !lines.includes('DEBUG pr #9: the changes were not preloaded (no read model)'); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(lines.includes('DEBUG pr #9: the changes were not preloaded (no read model)'), lines.join('\n'));
});

test('mcp.off with the three benchmark tools leaves them out of tools/list; the other tools stay (#478)', async (t) => {
  const { base, ptyId, repo } = await start(t);
  const off = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, workspaces: workspacesAt(repo), mcp: { off: ['benchmark_list', 'benchmark_get', 'benchmark_draft'], servers: [] } }) });
  assert.equal(off.status, 200);
  const client = await connect(t, base, ptyId);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => name.startsWith('benchmark_')), []);
  assert.ok(names.includes('hive_remember'));
});
