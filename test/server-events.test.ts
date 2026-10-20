import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZERO_TOKENS, type RecordInput } from '../src/events.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { memoryPath, renderMemory } from '../src/memory.js';
import { editorDir } from '../src/editor-install.js';
import { createServerEvents } from '../src/server-events.js';
import type { MemoryFile } from '../src/types.js';
import type { HookPayload, SettingsBody, State } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeEvents, fakeLog, fakeSourceFactory, fakeSpawn, tempHive, WORKSPACE, workspacesAt } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { withWork, withLocal } from './fixtures/work.js';
import { tempDir } from './temp-dir.js';
import { localDay, OTHER, SESSION, sessionMeta, turnContext, usageRecord, writeRollout } from './codex-rollouts.js';

// One worker and one stage (fila): the fake source's task spawns at the green signal
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], stages: STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS,
  shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep',
  closeSessionTabNotice: true, closeStageTabNotice: true, closeTerminalTab: 'keep', closeTerminalTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true,
  defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Hive { server: HiveServer; records: RecordInput[]; base: string; ptyId: string; home: string; repo: string }

// Every record the server writes, kept by a fake event log
async function start(t: TestContext, seed?: (home: string) => Promise<void>, body: Omit<SettingsBody, 'workspaces'> = BODY): Promise<Hive> {
  const { home, repo } = await tempHive(t, 1); // one worker: the fake source's task starts
  await seed?.(home);
  const { events, records } = fakeEvents();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, log: fakeLog().log, events, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const saved = await hiveFetch(`http://127.0.0.1:${port}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...body, workspaces: workspacesAt(repo) }) });
  assert.equal(saved.status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  const ptyId = server.getState()?.workers[0]?.runId;
  assert.ok(ptyId !== undefined, 'the task spawned');
  return { server, records, base: `http://127.0.0.1:${port}`, ptyId, home, repo };
}

const pick = (record: RecordInput | undefined, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, (record as Record<string, unknown> | undefined)?.[key]]));

test('every dispatch writes what its reduction derived: the boot, the task found, the run spawned, its first stage run, the workers, the signal (#742)', async (t) => {
  const { records } = await start(t);
  const names = records.map((r) => r.event);
  for (const name of ['hive.booted', 'task.discovered', 'run.spawned', 'stage.started', 'workers.changed', 'signal.changed'] as const) assert.ok(names.includes(name), `${name} in ${names.join(',')}`);
  assert.deepEqual(pick(records.find((r) => r.event === 'stage.started'), ['task_id', 'stage', 'attempt', 'run_kind']), { task_id: 'board:I1', stage: 'fila', attempt: 1, run_kind: 'spawn' });
  assert.deepEqual(pick(records.find((r) => r.event === 'workers.changed'), ['active', 'max']), { active: 1, max: 1 });
});

test('close writes hive.quit with its reason once; hive.booted is timed from the server\'s creation (#742)', async (t) => {
  const { server, records } = await start(t);
  assert.equal(typeof pick(records.find((r) => r.event === 'hive.booted'), ['duration_ms']).duration_ms, 'number');
  await server.close('stop');
  await server.close('stop');
  assert.deepEqual(records.filter((r) => r.event === 'hive.quit'), [{ event: 'hive.quit', level: 'info', reason: 'stop' }]);
});

test('createServerEvents writes the signal on its first reduction, then nothing for a reduction that kept the state (#742)', () => {
  const { events, records } = fakeEvents();
  const state = initialState(1);
  const wiring = createServerEvents(events, fakeLog().log, () => 0);
  wiring.afterDispatch(state, state, { type: 'tick' });
  wiring.afterDispatch(state, state, { type: 'tick' });
  assert.deepEqual(records, [{ event: 'signal.changed', level: 'info', from: state.signal, to: state.signal }]);
});

const postHook = (base: string, ptyId: string, payload: HookPayload): Promise<Response> =>
  hiveFetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(payload) });

test('the hook route feeds the human signals: the spawn\'s own prompt is no takeover, a second one is, timed to the Stop (#742)', async (t) => {
  const { base, records, ptyId } = await start(t);
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit' });
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit' });
  await postHook(base, ptyId, { hook_event_name: 'Stop' });
  const takeovers = records.filter((r) => r.event === 'run.takeover');
  assert.equal(takeovers.length, 1);
  assert.deepEqual(pick(takeovers[0], ['task_id', 'stage', 'attempt', 'run_kind']), { task_id: 'board:I1', stage: 'fila', attempt: 1, run_kind: 'spawn' });
});

test('a stage run cut with a takeover still open writes run.takeover unresolved before stage.ended, once (#742)', async (t) => {
  const { base, server, records, ptyId } = await start(t);
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit' }); // the spawn's own
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit' }); // the user's: a takeover
  await server.dispatch({ type: 'stop', ptyId, cause: 'manual' });
  await server.close('stop');
  const names = records.map((r) => r.event);
  const takeovers = records.filter((r) => r.event === 'run.takeover');
  assert.deepEqual(takeovers.map((r) => pick(r, ['outcome', 'task_id'])), [{ outcome: 'unresolved', task_id: 'board:I1' }]);
  assert.ok(names.indexOf('run.takeover') < names.indexOf('stage.ended'), names.join(','));
});

test('quit flushes every open wait of every pty before hive.quit: a pending permission is unresolved, once (#742)', async (t) => {
  const { base, server, records, ptyId } = await start(t);
  await postHook(base, ptyId, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  await postHook(base, ptyId, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await server.close('stop');
  const names = records.map((r) => r.event);
  assert.deepEqual(records.filter((r) => r.event === 'permission.answered').map((r) => pick(r, ['outcome', 'tool'])), [{ outcome: 'unresolved', tool: 'Bash' }]);
  assert.ok(names.indexOf('permission.answered') < names.indexOf('hive.quit'), names.join(','));
});

test('the Stop after hive_done ends the stage run with its outcome and tool counts; no transcript read means zero tokens (#742)', async (t) => {
  const { base, server, records, ptyId } = await start(t);
  await postHook(base, ptyId, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  await server.dispatch({ type: 'done', ptyId });
  await postHook(base, ptyId, { hook_event_name: 'Stop' });
  const ended = records.filter((r) => r.event === 'stage.ended');
  assert.equal(ended.length, 1);
  assert.deepEqual(pick(ended[0], ['stage', 'attempt', 'run_kind', 'outcome', 'tokens', 'models', 'subagent_tokens', 'tool_counts']),
    { stage: 'fila', attempt: 1, run_kind: 'spawn', outcome: 'done', tokens: ZERO_TOKENS, models: [], subagent_tokens: ZERO_TOKENS, tool_counts: { Bash: 1 } });
});

test('a 4xx or 5xx is http.error with the route\'s pattern, never the URL; a request no route matched is unmatched (#742)', async (t) => {
  const { base, records } = await start(t);
  const refused = await hiveFetch(`${base}/signal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ signal: 'blue' }) });
  assert.equal(refused.status, 400);
  assert.equal((await hiveFetch(`${base}/nowhere/SECRET-PATH`)).status, 404);
  await new Promise((resolve) => setImmediate(resolve)); // 'finish' fires as the response leaves
  assert.deepEqual(records.filter((r) => r.event === 'http.error'), [
    { event: 'http.error', level: 'warn', route: '/signal', status: 400 }, { event: 'http.error', level: 'debug', route: 'unmatched', status: 404 },
  ]);
});

test('a source poll writes source.polled at debug; a source write writes source.action with its outcome (#742)', async (t) => {
  const { records } = await start(t);
  assert.deepEqual(pick(records.find((r) => r.event === 'source.polled'), ['level', 'source', 'items']), { level: 'debug', source: 'board', items: 1 });
  assert.deepEqual(pick(records.find((r) => r.event === 'source.action'), ['level', 'task_id', 'task', 'action', 'outcome']), { level: 'info', task_id: 'board:I1', task: '1', action: 'move', outcome: 'ok' });
});

test('no record holds a path, the home, a link, or the text of a prompt, a question, a title or feedback (#742)', async (t) => {
  const { base, server, records, ptyId, home, repo } = await start(t);
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit', message: 'SECRET-PROMPT' });
  await postHook(base, ptyId, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${repo}/.env` }, cwd: repo, transcript_path: join(home, 'x.jsonl') });
  await server.dispatch({ type: 'ask', ptyId, question: 'SECRET-QUESTION' });
  await postHook(base, ptyId, { hook_event_name: 'UserPromptSubmit', message: 'SECRET-ANSWER' });
  await server.dispatch({ type: 'createTask', title: 'SECRET-TITLE', body: `see ${repo}`, stage: 'fila', prefix: 'HIVE', auto: false });
  await server.dispatch({ type: 'feedback', activityId: server.getState()?.workers[0]?.activityId ?? 'none', text: 'SECRET-FEEDBACK', start: false });
  await server.dispatch({ type: 'done', ptyId });
  await postHook(base, ptyId, { hook_event_name: 'Stop' });
  const text = JSON.stringify(records);
  for (const banned of ['SECRET-', home, repo, homedir(), tmpdir(), 'http://', 'https://']) assert.ok(!text.includes(banned), `${banned} in ${text}`);
  assert.ok(records.length > 10, 'the scenario wrote records to check');
});

test('a throw inside any recorder is one error line and never reaches dispatch, the hook route, the effects or the source call (#742)', async () => {
  const { log, lines } = fakeLog();
  const throwing = { write: (): void => { throw new Error('disk'); }, setLevel: () => undefined };
  const wiring = createServerEvents(throwing, log, () => 0);
  const bad = { ...initialState(1), get workers(): never { throw new Error('derive'); } } as State;
  assert.doesNotThrow(() => wiring.afterDispatch(initialState(1), bad, { type: 'tick' }));
  assert.doesNotThrow(() => wiring.beforeHook(bad, 'p1', { hook_event_name: 'Stop' }));
  assert.doesNotThrow(() => wiring.prActivity(bad, [{ url: 'https://github.com/o/r/pull/1', commits: 1, afterOpen: 0, recent: [], checks: [] }]));
  assert.doesNotThrow(() => wiring.booted(0));
  assert.doesNotThrow(() => wiring.quit(bad, 'stop'));
  assert.equal(await wiring.sourceAction(undefined, 'board:I1', 'move', Promise.resolve('done')), 'done');
  await assert.rejects(wiring.sourceAction(undefined, 'board:I1', 'move', Promise.reject(new Error('gh'))), { message: 'gh' });
  assert.deepEqual(await wiring.polled('board', Promise.resolve([])), []);
  assert.ok(lines.filter((l) => l.startsWith('ERROR events: ')).length >= 8, 'at least one line per failing recorder; afterDispatch guards each of its steps');
  assert.ok(lines.every((l) => !l.includes('derive') && !l.includes('disk')), 'a fixed context, never the message');
});

test('a writer that throws leaves the Hive working: the task spawns, a hook is answered, a refused request is answered (#742)', async (t) => {
  const { home, repo } = await tempHive(t, 1); // one worker: the fake source's task starts
  const events = { write: (): void => { throw new Error('disk'); }, setLevel: () => undefined };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, log: fakeLog().log, events, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const saved = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, workspaces: workspacesAt(repo) }) });
  assert.equal(saved.status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  const ptyId = server.getState()?.workers[0]?.runId;
  assert.ok(ptyId !== undefined, 'the task spawned');
  assert.equal((await postHook(base, ptyId, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).status, 204);
  assert.equal((await hiveFetch(`${base}/nowhere`)).status, 404);
});

test('an input effect counts as the Hive\'s prompt only once its write went through (typed); onEffect leaves it alone (#742)', () => {
  const { events, records } = fakeEvents();
  const wiring = createServerEvents(events, fakeLog().log, () => 0);
  const state = { ...initialState(1), workers: [{ id: 'w1', runId: 'p1', status: 'working' }] } as State;
  wiring.onEffect({ type: 'input', ptyId: 'p1', text: 'x' });
  wiring.beforeHook(state, 'p1', { hook_event_name: 'UserPromptSubmit' });
  wiring.typed('p1');
  wiring.beforeHook(state, 'p1', { hook_event_name: 'UserPromptSubmit' });
  wiring.beforeHook(state, 'p1', { hook_event_name: 'Stop' });
  assert.equal(records.filter((r) => r.event === 'run.takeover').length, 1, 'the first prompt was not the Hive\'s, the second was');
});

test('a gate refusal is no http.error; a request no route matched is written at debug (#742)', async (t) => {
  const { base, records } = await start(t);
  assert.equal((await fetch(`${base}/state`)).status, 403);
  assert.equal((await hiveFetch(`${base}/nowhere`)).status, 404);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records.filter((r) => r.event === 'http.error'), [{ event: 'http.error', level: 'debug', route: 'unmatched', status: 404 }]);
});

test('a throwing derivation step still runs the other steps, so a later stage.ended is not lost (#742)', () => {
  const { events } = fakeEvents();
  const { log, lines } = fakeLog();
  const wiring = createServerEvents(events, log);
  const broken = new Proxy({} as State, { get: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => wiring.afterDispatch(broken, broken, { type: 'tick' }));
  assert.ok(lines.filter((l) => l.startsWith('ERROR events:')).length >= 2, 'each step is guarded on its own: one failing step does not skip the rest');
});

test('a UI write answered 2xx is ui.action with the route\'s pattern, the method and the correlation of the :id it names; a pty\'s id names its run\'s; never a GET, a hook, a redirect, a refusal, a layout write, a request without the UI header, nor the body (#742)', async (t) => {
  const { events, records } = fakeEvents();
  const wiring = createServerEvents(events, fakeLog().log);
  const task = { item: { itemId: 'board:I1', id: '1', title: 'SECRET-TITLE', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  const worker = { id: 'w1', runId: 'pty-1', status: 'working' as const, activityId: 'a-board:I1' };
  let state: State = withLocal(withWork({ ...initialState(1), tasks: [task], workers: [worker] }, 'board:I1'), 'ws');
  const app = express();
  app.use(wiring.httpRecords(() => state));
  const ok = (_req: express.Request, res: express.Response): void => {
    res.json({ ok: true });
  };
  app.post('/tasks/:id/workspace', (_req, res) => {
    state = { ...state, tasks: [] }; // the action took the task away: the correlation is the state the request found
    res.json({ ok: true });
  });
  app.delete('/activities/:id/reveal', ok);
  app.put('/activities/:id/x', ok);
  app.get('/state', ok);
  app.post('/go/:id', (_req, res) => res.redirect(303, '/state'));
  app.post('/view-state/:key', ok);
  app.post('/ptys/:id/stop', ok);
  app.post('/hooks/event', ok);
  app.post('/signal', (_req, res) => { res.status(400).json({ error: 'no' }); });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ui = { 'content-type': 'application/json', 'x-hive-ui': '1' };
  const call = (method: string, path: string, headers: Record<string, string> = ui) => fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(method === 'GET' ? {} : { body: JSON.stringify({ text: 'SECRET-BODY' }) }) });
  await call('DELETE', '/activities/a-board:I1/reveal');
  await call('PUT', '/activities/local:ws/x');
  await call('POST', '/ptys/pty-1/stop');
  await call('POST', '/tasks/board:I1/workspace');
  await call('GET', '/state');
  await call('POST', '/go/board:I1');
  await call('POST', '/view-state/dock');
  await call('POST', '/hooks/event');
  await call('POST', '/signal');
  await call('PUT', '/activities/a-board:I1/x', { 'content-type': 'application/json' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records.filter((r) => r.event === 'ui.action'), [
    { event: 'ui.action', level: 'info', task_id: 'board:I1', task: '1', activity_id: 'a-board:I1', stage: 'dev', route: '/activities/:id/reveal', method: 'DELETE' },
    { event: 'ui.action', level: 'info', activity_id: 'local:ws', route: '/activities/:id/x', method: 'PUT' },
    { event: 'ui.action', level: 'info', task_id: 'board:I1', task: '1', activity_id: 'a-board:I1', stage: 'dev', route: '/ptys/:id/stop', method: 'POST' },
    { event: 'ui.action', level: 'info', task_id: 'board:I1', task: '1', activity_id: 'a-board:I1', stage: 'dev', route: '/tasks/:id/workspace', method: 'POST' },
  ]);
  assert.ok(!JSON.stringify(records).includes('SECRET'), 'never the body nor a title');
});

test('run.spawned names the lessons in rendered order, the characters of the section its launch got and the workspace, and none of them for an empty memory (#797)', async (t) => {
  const file: MemoryFile = {
    nextId: 3,
    entries: [
      { id: 'm-1', kind: 'fact', text: 'pnpm test is the gate', origin: 'user', at: '2026-10-05T10:00:00.000Z', uses: 0 },
      { id: 'm-2', kind: 'pref', text: 'specs are written in English', origin: { task: '7' }, at: '2026-10-05T10:00:00.000Z', uses: 1 },
    ],
  };
  const seeded = await start(t, async (home) => {
    await mkdir(join(home, 'memory'), { recursive: true });
    await writeFile(memoryPath(home, WORKSPACE), JSON.stringify(file));
  });
  const fields = ['memory_ids', 'memory_chars', 'workspace'];
  assert.deepEqual(pick(seeded.records.find((r) => r.event === 'run.spawned'), fields), { memory_ids: ['m-2', 'm-1'], memory_chars: renderMemory(file.entries).length, workspace: WORKSPACE });
  const bare = await start(t);
  assert.deepEqual(pick(bare.records.find((r) => r.event === 'run.spawned'), fields), { memory_ids: undefined, memory_chars: undefined, workspace: undefined });
});

test('run.spawned names the language servers its workspace\'s plugin holds, and [] without one (#803)', async (t) => {
  const seeded = await start(t, async (home) => {
    const dir = editorDir(home, { kind: 'server', id: 'gopls' }); // the record is all a binary server's launch reads
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'installed.json'), JSON.stringify({ version: '0.20.0', installedAt: '2026-10-09T00:00:00.000Z' }));
  });
  assert.deepEqual(pick(seeded.records.find((r) => r.event === 'run.spawned'), ['lsp_servers']), { lsp_servers: ['gopls'] });
  const bare = await start(t);
  assert.deepEqual(pick(bare.records.find((r) => r.event === 'run.spawned'), ['lsp_servers']), { lsp_servers: [] });
});

async function codexHome(t: TestContext): Promise<string> {
  const home = await tempDir(t, 'codex-');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  return home;
}

test('a Codex Stop naming its own rollout adds the turn\'s tokens to the usage and to the stage run; a rollout of another session id reads nothing (#929)', async (t) => {
  const home = await codexHome(t);
  const { base, server, records, ptyId } = await start(t, undefined, { ...BODY, stages: [{ ...STAGES[0], agent: 'codex' }] });
  const used = (): number => server.getState()!.usage.reduce((sum, sample) => sum + sample.tokens, 0);
  await postHook(base, ptyId, { hook_event_name: 'SessionStart', session_id: SESSION, source: 'startup' });
  const at = new Date(Date.now() + 1000).toISOString(); // after the stage run's start
  const day = localDay(new Date());
  const rollout = await writeRollout(home, day, SESSION, [sessionMeta(SESSION), turnContext(at, 'turn-1', 'gpt-5.6-terra'), usageRecord(at, 'turn-1', 'resp-1', { input: 1200, cached: 200, cacheWrite: 0, output: 34 }, 1234)], Date.now());
  const forged = await writeRollout(home, day, OTHER, [usageRecord(at, 'turn-1', 'resp-9', { input: 9000, cached: 0, cacheWrite: 0, output: 0 }, 9000)], Date.now());
  await postHook(base, ptyId, { hook_event_name: 'Stop', session_id: SESSION, transcript_path: forged });
  assert.equal(used(), 0, 'not its own session\'s file: dropped, nothing read');
  await server.dispatch({ type: 'done', ptyId });
  await postHook(base, ptyId, { hook_event_name: 'Stop', session_id: SESSION, transcript_path: rollout });
  assert.equal(used(), 1234);
  const ended = records.filter((r) => r.event === 'stage.ended');
  assert.deepEqual(pick(ended.at(-1), ['tokens', 'models', 'agent', 'tokens_by_model']), {
    tokens: { input: 1000, output: 34, cache_write: 0, cache_read: 200 }, models: ['gpt-5.6-terra'], agent: 'codex',
    tokens_by_model: { 'gpt-5.6-terra': { input: 1000, output: 34, cache_write: 0, cache_read: 200 } },
  });
});
