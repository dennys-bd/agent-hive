import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordInput } from '../src/events.js';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import { MEMORY_FULL_MESSAGE, MEMORY_KIND_MESSAGE, MEMORY_SECRET_MESSAGE, MEMORY_TEXT_MESSAGE } from '../src/memory.js';
import { STAGE_PROTOCOL } from '../src/protocol.js';
import { createServer } from '../src/server.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from '../src/server-memory.js';
import type { MemoryView, SettingsBody } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, MEMORY_TEXT_MAX, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, WORKSPACE, fakeEvents, fakeSourceFactory, fakeSpawn, tempHive, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// The memory dialog's routes (#797), end to end against a configured Hive with one workspace and no worker
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};
const EMPTY_VIEW = { entries: [], used: 0, cap: 4000, textMax: MEMORY_TEXT_MAX }; // workspacesAt's memoryCap
type MemoryChanged = Extract<RecordInput, { event: 'memory.changed' }>;

const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method, headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const refused = async (res: Promise<Response>, status: number, body: Record<string, string>, why: string): Promise<void> => {
  const answer = await res;
  assert.deepEqual([answer.status, await answer.json()], [status, body], why);
};

async function start(t: TestContext, memoryCap = 4000): Promise<{ base: string; url: string; home: string; records: RecordInput[] }> {
  const { home, repo } = await tempHive(t);
  const { events, records } = fakeEvents(); // no events.jsonl of the server's own: the stats test writes it
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, events, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await send('POST', `${base}/settings`, { ...BODY, workspaces: workspacesAt(repo).map((w) => ({ ...w, memoryCap })) })).status, 200);
  return { base, url: `${base}/workspaces/${WORKSPACE}/memory`, home, records };
}

test('GET lists the workspace memory with its size, cap and lesson limit; POST adds a lesson of the user, PUT edits it keeping its origin, DELETE removes it; each write answers the new view, rewrites the protocol files and writes memory.changed by the user (#797)', async (t) => {
  const { url, home, records } = await start(t);
  const { stage } = workspaceProtocolPaths(home, WORKSPACE);
  assert.deepEqual(await (await hiveFetch(url)).json(), EMPTY_VIEW);
  const added = (await (await send('POST', url, { kind: 'fact', text: ' pnpm test is the gate ' })).json()) as MemoryView;
  assert.deepEqual([added.entries.map((e) => [e.id, e.kind, e.text, e.origin, e.uses]), added.used], [[['m-1', 'fact', 'pnpm test is the gate', 'user', 0]], 21]);
  const edited = (await (await send('PUT', `${url}/m-1`, { kind: 'avoid', text: 'never skip pnpm test' })).json()) as MemoryView;
  assert.deepEqual(edited.entries.map((e) => [e.id, e.kind, e.text, e.origin]), [['m-1', 'avoid', 'never skip pnpm test', 'user']]);
  assert.ok((await readFile(stage, 'utf8')).endsWith('### Avoid\n- [m-1] never skip pnpm test\n'));
  assert.deepEqual(await (await send('DELETE', `${url}/m-1`)).json(), EMPTY_VIEW);
  assert.equal(await readFile(stage, 'utf8'), STAGE_PROTOCOL);
  const changed = records.filter((r): r is MemoryChanged => r.event === 'memory.changed');
  assert.deepEqual(changed.map((r) => [r.action, r.kind, r.by, r.id, r.entries, r.workspace]), [
    ['added', 'fact', 'user', 'm-1', 1, WORKSPACE], ['edited', 'avoid', 'user', 'm-1', 1, WORKSPACE], ['removed', 'avoid', 'user', 'm-1', 0, WORKSPACE],
  ]);
  assert.ok(!JSON.stringify(records).includes('pnpm test'), 'no lesson text in any record');
});

test('an unknown workspace or lesson is 404, a bad kind, a bad text or a secret 400 and a lesson past the cap 409, each with its code and nothing written (#797)', async (t) => {
  const { base, url } = await start(t);
  await refused(hiveFetch(`${base}/workspaces/ghost/memory`), 404, { error: UNKNOWN_WORKSPACE_MESSAGE }, 'GET, unknown workspace');
  await refused(send('POST', `${base}/workspaces/ghost/memory`, { kind: 'fact', text: 'x' }), 404, { error: UNKNOWN_WORKSPACE_MESSAGE }, 'POST, unknown workspace');
  const gone = { error: "no lesson m-9 in this workspace's memory", code: 'unknown_memory' };
  await refused(send('PUT', `${url}/m-9`, { kind: 'fact', text: 'x' }), 404, gone, 'PUT, unknown lesson');
  await refused(send('DELETE', `${url}/m-9`), 404, gone, 'DELETE, unknown lesson');
  await refused(send('POST', url, { kind: 'correction', text: 'x' }), 400, { error: MEMORY_KIND_MESSAGE, code: 'bad_memory' }, 'a kind');
  await refused(send('POST', url, { kind: 'fact', text: 'a\nb' }), 400, { error: MEMORY_TEXT_MESSAGE, code: 'bad_memory' }, 'two lines');
  await refused(send('POST', url, { kind: 'fact', text: `key ${'Zx9'.repeat(11)}` }), 400, { error: MEMORY_SECRET_MESSAGE, code: 'memory_secret' }, 'a secret');
  assert.deepEqual(((await (await hiveFetch(url)).json()) as MemoryView).entries, [], 'nothing written');
  let last: Response | undefined;
  for (let n = 1; n <= 20; n += 1) last = await send('POST', url, { kind: 'fact', text: `lesson ${n} ${'y'.repeat(280)}` });
  await refused(Promise.resolve(last as Response), 409, { error: MEMORY_FULL_MESSAGE, code: 'memory_full' }, 'past the cap');
});

test('GET …/memory/stats reads events.jsonl.1 then events.jsonl for the workspace\'s last 7 days, skipping a bad line; an unknown workspace is 404 (#797)', async (t) => {
  const { base, url, home } = await start(t);
  await send('POST', url, { kind: 'fact', text: 'pnpm test is the gate' }); // m-1
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const line = (record: Record<string, unknown>): string => `${JSON.stringify({ schema_version: 1, ts: at, level: 'info', ...record })}\n`;
  await writeFile(join(home, 'events.jsonl.1'), line({ event: 'run.spawned', workspace: WORKSPACE, worker: 1, memory_ids: ['m-1'], memory_chars: 400, task: '1', stage: 'fila', session_id: 's1' }));
  await writeFile(join(home, 'events.jsonl'), `${line({ event: 'memory.applied', workspace: WORKSPACE, id: 'm-1', kind: 'fact', uses: 1, session_id: 's1' })}{"workspace": broken\n`);
  assert.deepEqual(await (await hiveFetch(`${url}/stats`)).json(), { runs: 1, cited: 1, tokensPerRun: 100, last: { at, task: '1', stage: 'fila', cited: 1 } });
  await refused(hiveFetch(`${base}/workspaces/ghost/memory/stats`), 404, { error: UNKNOWN_WORKSPACE_MESSAGE }, 'unknown workspace');
});

test('the routes answer and enforce the workspace\'s own memoryCap: the view carries it, a POST or a PUT that grows the sum past it is 409, a shrink passes (#73)', async (t) => {
  const { url } = await start(t, 500);
  assert.deepEqual(await (await hiveFetch(url)).json(), { ...EMPTY_VIEW, cap: 500 });
  for (const c of ['a', 'b']) assert.equal((await send('POST', url, { kind: 'fact', text: c.repeat(250) })).status, 200); // exactly 500
  const full = { error: MEMORY_FULL_MESSAGE, code: 'memory_full' };
  await refused(send('POST', url, { kind: 'fact', text: 'c' }), 409, full, 'one more character than the cap');
  await refused(send('PUT', `${url}/m-1`, { kind: 'fact', text: 'd'.repeat(251) }), 409, full, 'an edit that grows the sum past the cap');
  const shrunk = (await (await send('PUT', `${url}/m-1`, { kind: 'fact', text: 'short' })).json()) as MemoryView;
  assert.deepEqual([shrunk.used, shrunk.cap], [255, 500]);
});
