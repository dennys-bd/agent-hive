import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localActivityId } from '../src/activities.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { createServer, type HiveServer } from '../src/server.js';
import { removeTaskTranscript } from '../src/server-runs.js';
import { worktreePath } from '../src/worktree.js';
import type { Activity, OpenResult, Session, SettingsBody, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, WORKSPACE, workspacesAt, STAGES, fakeSourceFactory, fakeSpawn, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The sleep routes of one flow (#672), end to end through the server: the route, the reducer and the record. No worker (maxConcurrent 0):
// every run below is a local session the test opened
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

const send = (url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<Response> =>
  hiveFetch(url, { method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

async function start(t: TestContext): Promise<{ base: string; server: HiveServer; fake: ReturnType<typeof fakeSpawn> }> {
  const { home, repo } = await tempHive(t);
  const fake = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fake.spawn, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send(`${base}/settings`, 'POST', { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  return { base, server, fake };
}

// A new local claude session seen by its SessionStart: a run whose session is kept (#590, #672). The fake's kill reports no exit, so a
// stopped run stays live until the test dispatches its exit
async function session(server: HiveServer): Promise<string> {
  await server.dispatch({ type: 'newLocalSession', activityId: localActivityId(WORKSPACE) });
  const worker = server.getState()?.workers.filter((s) => s.activityId === localActivityId(WORKSPACE) && s.status !== 'empty').at(-1);
  assert.ok(worker?.runId !== undefined && worker.sessionId !== undefined);
  await server.dispatch({ type: 'hook', ptyId: worker.runId, payload: { hook_event_name: 'SessionStart', session_id: worker.sessionId } });
  return worker.runId;
}

const ending = (server: HiveServer, ptyId: string) => server.getState()?.workers.find((s) => s.runId === ptyId)?.ending;

test('POST /ptys/:id/stop marks the run a manual sleep whatever its body, and its exit records it sleeping (#283, #672)', async (t) => {
  const { base, server } = await start(t);
  const ptyId = await session(server);
  assert.deepEqual(await (await send(`${base}/ptys/${ptyId}/stop`, 'POST', { cause: 'all' })).json(), { ok: true });
  assert.equal(ending(server, ptyId), 'manual');
  await server.dispatch({ type: 'exit', ptyId });
  assert.deepEqual(server.getState()?.slept?.map((s) => [s.ptyId, s.cause]), [[ptyId, 'manual']]);
});

test('POST /ptys/sleep sleeps every listed run with cause all; an unknown id or an empty list sleeps none (#672)', async (t) => {
  const { base, server } = await start(t);
  const first = await session(server);
  const second = await session(server);
  const unknown = await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [first, 'nope'] });
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'nenhuma execução viva com esse id: nope' }]);
  assert.equal(ending(server, first), undefined, 'checked whole before any stop');
  const empty = await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [] });
  assert.deepEqual([empty.status, await empty.json()], [400, { error: 'informe ptyIds: os ids das execuções a dormir' }]);
  assert.deepEqual(await (await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [first, second] })).json(), { ok: true });
  assert.deepEqual([ending(server, first), ending(server, second)], ['all', 'all']);
});

test('POST /ptys/sleep stops a run listed twice once (#672)', async (t) => {
  const { base, server, fake } = await start(t);
  const ptyId = await session(server);
  assert.deepEqual(await (await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [ptyId, ptyId] })).json(), { ok: true });
  assert.deepEqual(fake.workers.map((w) => w.killed), [1]);
});

test('DELETE /ptys/:id/scrollback forgets a sleeping run: its record leaves the state (#672)', async (t) => {
  const { base, server } = await start(t);
  const ptyId = await session(server);
  await server.dispatch({ type: 'exit', ptyId });
  assert.equal(server.getState()?.slept?.length, 1);
  assert.deepEqual(await (await send(`${base}/ptys/${ptyId}/scrollback`, 'DELETE')).json(), { ok: true });
  assert.deepEqual(server.getState()?.slept, []);
});

test('POST /ptys/sleep sleeps the activity\'s live terminals beside its agent runs, and refuses a sleeping one (#696)', async (t) => {
  const { base, server } = await start(t);
  const ptyId = await session(server);
  const shell = ((await (await send(`${base}/activities/${encodeURIComponent(localActivityId(WORKSPACE))}/shell`, 'POST')).json()) as OpenResult).ptyId ?? '';
  assert.deepEqual(await (await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [ptyId, shell] })).json(), { ok: true });
  assert.deepEqual([ending(server, ptyId), server.getState()?.terminals[0]?.asleep], ['all', true]);
  const again = await send(`${base}/ptys/sleep`, 'POST', { ptyIds: [shell] });
  assert.deepEqual([again.status, await again.json()], [404, { error: `nenhuma execução viva com esse id: ${shell}` }]);
});

test('removeTaskTranscript removes the session\'s transcript in its task\'s worktree and nothing else; with no workspace it removes nothing (#494)', async (t) => {
  const env = { CLAUDE_CONFIG_DIR: await tempDir(t, 'claude-') };
  const at = '2026-10-22T10:00:00.000Z';
  const task: Task = { item: { itemId: 'board:1', id: '1', title: 'T', body: '', url: '', source: 'board' }, stage: 'plan', boardColumn: '', auto: true, workspace: 'hive' };
  const activity: Activity = { id: 'a-board:1', kind: 'task', workspace: 'hive', slug: 'hive-1-t' };
  const [run, other] = ['a1b2c3d4-0000-4000-8000-000000000001', 'b1b2c3d4-0000-4000-8000-000000000002'];
  const session: Session = { id: run, startedAt: at, stages: ['spec'], lastUsedAt: at, agent: 'claude' };
  const dir = transcriptDir(worktreePath('/repo', 'hive-1-t'), env);
  await mkdir(dir, { recursive: true });
  for (const id of [run, other]) await writeFile(join(dir, `${id}.jsonl`), '{}\n');
  const errors: string[] = [];
  const log = { debug: () => undefined, error: (line: string) => { errors.push(line); } };
  await removeTaskTranscript(undefined, task, activity, undefined, session, log, env);
  assert.equal((await readdir(dir)).length, 2, 'no workspace: nothing goes');
  await removeTaskTranscript('/repo', task, activity, undefined, session, log, env);
  assert.deepEqual([await readdir(dir), errors], [[`${other}.jsonl`], []]);
});
