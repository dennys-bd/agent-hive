import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { newBoardText } from '../src/boards/markdown.js';
import type { Config, SetupBody, SetupInfo, State } from '../src/types.js';
import { fakeBoardFactory, OPTIONS } from './fakes.js';

const BODY: SetupBody = {
  board: { type: 'github', owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 0, // zero slots: nothing is ever spawned (spawn would start a real claude)
};

interface Started { repo: string; base: string; port: number; server: HiveServer; configs: Config[] }

async function start(t: TestContext, resolveDelayMs = 0): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-setup-'));
  const { factory, configs } = fakeBoardFactory(resolveDelayMs);
  const server = createServer({ repo, boardFactory: factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { repo, base: `http://127.0.0.1:${port}`, port, server, configs };
}

const postSetup = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const configFile = (repo: string): string => join(repo, 'hive.config.json');

// fetch()/undici always sets Host from the URL, so a spoofed Host header needs node:http directly.
function getWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/setup', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /setup reports configured: false and the repo in setup mode', async (t) => {
  const { base, repo } = await start(t);
  assert.deepEqual(await json<SetupInfo>(fetch(`${base}/setup`)), { configured: false, repo });
});

test('GET /events streams { configured: false } until setup is saved', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  assert.match(new TextDecoder().decode(value), /^data: \{"configured":false\}\n\n/);
});

test('setup listings reject a missing owner, number, path or type with 400 naming the field', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/setup/projects`)).status, 400);
  const noNumber = await fetch(`${base}/setup/columns?type=github&owner=acme`);
  assert.equal(noNumber.status, 400);
  assert.match((await json<{ error: string }>(noNumber)).error, /board\.number/);
  const noPath = await fetch(`${base}/setup/columns?type=markdown`);
  assert.equal(noPath.status, 400);
  assert.match((await json<{ error: string }>(noPath)).error, /board\.path/);
  const noType = await fetch(`${base}/setup/columns?owner=acme&number=6`);
  assert.equal(noType.status, 400);
  assert.match((await json<{ error: string }>(noType)).error, /board\.type/);
});

test('dashboard routes answer 409 before setup', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/board/refresh`, { method: 'POST' })).status, 409);
});

test('POST /setup writes the config with defaults, boots the runtime and reports the port mismatch', async (t) => {
  const { base, repo, port, server } = await start(t);
  const res = await postSetup(base, BODY);
  assert.equal(res.status, 200);
  // the test binds an ephemeral port, so the saved default port differs from the one in use
  assert.deepEqual(await json(res), { ok: true, restartForPort: DEFAULT_CONFIG.port });
  assert.deepEqual(JSON.parse(await readFile(configFile(repo), 'utf8')), { ...DEFAULT_CONFIG, ...BODY });
  const state = server.getState();
  assert.equal(state?.slots.length, 0);
  assert.deepEqual(state?.queue.map((task) => task.title), ['from Ready']);
  assert.match(await readFile(join(repo, '.hive', 'hooks.json'), 'utf8'), new RegExp(`127\\.0\\.0\\.1:${port}/hooks/event`));
  const info = await json<SetupInfo>(fetch(`${base}/setup`));
  assert.equal(info.configured, true);
  assert.deepEqual(info.config?.board, BODY.board);
  assert.equal(info.config?.promptTemplate, DEFAULT_CONFIG.promptTemplate);
});

test('POST /setup with a column the board does not have answers 400 and writes nothing', async (t) => {
  const { base, repo, server } = await start(t);
  const res = await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Todo' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /"Todo".*Ready, In progress, In review, Done/);
  await assert.rejects(stat(configFile(repo)));
  await assert.rejects(stat(join(repo, '.hive', 'hooks.json')), 'the runtime dir is never prepared: only the logger touched .hive/');
  assert.equal(server.getState(), undefined);
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).configured, false);
});

test('POST /setup with an invalid body answers 400 naming the field', async (t) => {
  const { base, repo } = await start(t);
  const res = await postSetup(base, { ...BODY, board: { type: 'github', owner: 'acme' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /board\.number/);
  await assert.rejects(stat(configFile(repo)));
});

test('a second POST /setup reconfigures in memory and preserves port, claudeArgs and promptTemplate', async (t) => {
  const { base, repo, server, configs } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const saved = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  await writeFile(configFile(repo), JSON.stringify({ ...saved, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: 'só {title}' }));
  const res = await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Done' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, restartForPort: 5000 });
  const rewritten = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(rewritten.status.queue, 'Done');
  assert.equal(rewritten.port, 5000);
  assert.deepEqual(rewritten.claudeArgs, ['--model', 'sonnet']);
  assert.equal(rewritten.promptTemplate, 'só {title}');
  assert.deepEqual(server.getState()?.queue.map((task) => task.title), ['from Done']);
  assert.equal(configs.at(-1)?.status.queue, 'Done');
});

test('a second POST /setup with the same board and status keeps the live board instance', async (t) => {
  const { base, configs } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const afterFirst = configs.length; // validation + activate
  assert.equal((await postSetup(base, { ...BODY, promptTemplate: 'só {title}' })).status, 200);
  assert.equal(configs.length, afterFirst + 1, 'only the pre-write validation creates a board; reconfigure reuses the live one');
  assert.equal((await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Done' } })).status, 200);
  assert.equal(configs.length, afterFirst + 3, 'a different status needs a new board');
});

test('concurrent POST /setup calls run one at a time and the last one wins on disk and in memory', async (t) => {
  const { base, repo } = await start(t, 30);
  const [first, second] = await Promise.all([
    postSetup(base, BODY),
    postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Done' } }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const onDisk = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(onDisk.status.queue, 'Done');
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).config?.status.queue, 'Done');
});

test('boot keeps the maxConcurrent saved in .hive/state.json over the config value', async (t) => {
  const { base, repo, server } = await start(t);
  await mkdir(join(repo, '.hive'), { recursive: true });
  // 0 slots in the saved state, regardless of the config value: nothing can spawn even if this
  // test's board (real spawnWorker, no fake) has a queued task. maxConcurrent 2 vs 0 would risk
  // opening a real `claude` process here, so both sides of the assertion stay at 0/non-zero via
  // the config side only.
  await writeFile(join(repo, '.hive', 'state.json'), JSON.stringify(initialState(0)));
  const res = await postSetup(base, { ...BODY, maxConcurrent: 1 });
  assert.equal(res.status, 200);
  const state = server.getState();
  assert.equal(state?.maxConcurrent, 0, 'state.json wins over the config value');
  assert.equal(state?.slots.length, 0);
});

test('POST /setup without maxConcurrent keeps the value already in hive.config.json', async (t) => {
  const { base, repo, server } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200); // BODY.maxConcurrent is 0
  const { maxConcurrent: _omitted, ...withoutMax } = BODY;
  assert.equal((await postSetup(base, withoutMax)).status, 200);
  const saved = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(saved.maxConcurrent, 0);
  assert.equal(server.getState()?.maxConcurrent, 0);
});

// POST /config with a non-zero maxConcurrent is skipped here: this file's start() uses the real
// spawnWorker (no fake), and a fake board task under a non-zero maxConcurrent would risk spawning
// an actual `claude` process. See test/server.test.ts, which fakes spawnWorker, for that coverage.

test('requests with a Host header that does not match the bound address get 403', async (t) => {
  const { port } = await start(t);
  assert.equal(await getWithHost(port, `evil.example:${port}`), 403);
});

test('requests with a matching Host header are not rejected by the allowlist', async (t) => {
  const { port } = await start(t);
  assert.equal(await getWithHost(port, `127.0.0.1:${port}`), 200);
});

test('POST /setup with a promptTemplate persists it and GET /setup returns it', async (t) => {
  const { base, repo } = await start(t);
  const res = await postSetup(base, { ...BODY, promptTemplate: '/ship #{number}' });
  assert.equal(res.status, 200);
  const saved = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(saved.promptTemplate, '/ship #{number}');
  const info = await json<SetupInfo>(fetch(`${base}/setup`));
  assert.equal(info.config?.promptTemplate, '/ship #{number}');
});

test('POST /setup without a promptTemplate keeps the existing one, and an empty string is ignored', async (t) => {
  const { base, repo } = await start(t);
  assert.equal((await postSetup(base, { ...BODY, promptTemplate: '/ship {url}' })).status, 200);
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).promptTemplate, '/ship {url}');
  assert.equal((await postSetup(base, { ...BODY, promptTemplate: '   ' })).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).promptTemplate, '/ship {url}');
});

test('POST /setup with a non-string promptTemplate answers 400 naming the field', async (t) => {
  const { base } = await start(t);
  const res = await postSetup(base, { ...BODY, promptTemplate: 42 });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /promptTemplate/);
});

test('GET /setup/columns builds the board from the query and answers its setupOptions', async (t) => {
  const { base, configs } = await start(t);
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=markdown&path=board.md`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.board, { type: 'markdown', path: 'board.md' });
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=github&owner=acme&number=6`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.board, { type: 'github', owner: 'acme', number: 6 });
});

test('POST /setup with a markdown board creates the file and boots the queue from it (real factory, no gh)', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-setup-'));
  const server = createServer({ repo }); // default factory: the markdown adapter only touches a local file
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SetupBody = { ...BODY, board: { type: 'markdown', path: 'docs/board.md' } };
  const file = join(repo, 'docs', 'board.md');
  assert.equal((await postSetup(base, body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), newBoardText());
  assert.ok(newBoardText().includes('| T-1 | Exemplo | Done |'));
  assert.deepEqual(server.getState()?.queue, [], 'the example row is Done, so nothing is queued');
  await writeFile(file, '| id | título | status |\n|---|---|---|\n| T-1 | Exemplo | Ready |\n');
  assert.equal((await postSetup(base, body)).status, 200);
  assert.deepEqual(server.getState()?.queue.map((task) => [task.id, task.title, task.url]), [['T-1', 'Exemplo', file]]);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.board, body.board);
  // an existing file is never rewritten by setup; a file with its own vocabulary lists only its statuses
  await writeFile(file, '| id | título | status |\n|---|---|---|\n| T-7 | Só esta | Todo |\n');
  assert.equal((await postSetup(base, body)).status, 200);
  assert.deepEqual(server.getState()?.queue, []);
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=markdown&path=docs/board.md`)), ['Todo']);
});

test('POST /signal answers 409 before setup, 400 for an unknown value, then 200 and the state carries it', async (t) => {
  const { base, repo, server } = await start(t);
  const postSignal = (body: unknown): Promise<Response> =>
    fetch(`${base}/signal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await postSignal({ signal: 'red' })).status, 409);
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal(server.getState()?.signal, 'yellow', 'setup boots, and every boot opens under yellow');
  const bad = await postSignal({ signal: 'blue' });
  assert.equal(bad.status, 400);
  assert.equal((await json<{ error: string }>(bad)).error, 'signal must be one of: green, yellow, red');
  const ok = await postSignal({ signal: 'red' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await json(ok), { ok: true });
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const streamed = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as State;
  assert.equal(streamed.signal, 'red');
  // persisted with the rest of the state, so a Hive closed under red reopens under red
  assert.equal((JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State).signal, 'red');
});

test('POST /setup with a budget writes it to hive.config.json, GET /setup returns it and the State carries it', async (t) => {
  const { base, repo, server } = await start(t);
  const budget = { maxTokensPerHour: 50_000, maxTokensPerDay: 400_000 };
  assert.equal((await postSetup(base, { ...BODY, budget })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, budget);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.budget, budget);
  assert.deepEqual(server.getState()?.budget, budget);
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const streamed = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as State;
  assert.deepEqual(streamed.budget, budget);
  assert.deepEqual(streamed.usage, []);
  // a save without budget keeps the file's; a save with {} clears it (the form always sends budget)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, budget);
  assert.equal((await postSetup(base, { ...BODY, budget: {} })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, {});
  assert.deepEqual(server.getState()?.budget, {});
  const bad = await postSetup(base, { ...BODY, budget: { maxTokensPerHour: -5 } });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /budget\.maxTokensPerHour/);
});

test('POST /hooks/event Stop with a transcript_path for an unknown worker answers 200, reads nothing and keeps serving', async (t) => {
  const { base, repo, server } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const transcript = join(repo, 'transcript.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`);
  const postHook = (body: unknown): Promise<Response> =>
    fetch(`${base}/hooks/event`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-worker': 'ghost' }, body: JSON.stringify(body),
    });
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: transcript })).status, 200);
  assert.equal((await postHook({ hook_event_name: 'SessionEnd', transcript_path: join(repo, 'missing.jsonl') })).status, 200);
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: 'relative.jsonl' })).status, 200);
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.deepEqual(server.getState()?.usage, [], 'no occupied slot matches, so nothing is read or recorded');
  assert.equal((await fetch(`${base}/setup`)).status, 200, 'the server is still up');
});

test('POST /setup with usageRules writes them to hive.config.json, GET /setup and the State carry them, an absent key keeps them and [] clears them', async (t) => {
  const { base, repo, server } = await start(t);
  const usageRules = [{ percent: 50, maxWorkers: 1 }, { percent: 90, signal: 'red' }];
  assert.equal((await postSetup(base, { ...BODY, usageRules })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  // a save without the key keeps the file's; a save with [] clears them (the form always sends the table)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  assert.equal((await postSetup(base, { ...BODY, usageRules: [] })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, []);
  assert.deepEqual(server.getState()?.usageRules, []);
});

test('POST /setup with an invalid usage rule answers 400 naming the rule and writes nothing', async (t) => {
  const { base, repo, server } = await start(t);
  const usageRules = [{ percent: 80, signal: 'yellow' }];
  assert.equal((await postSetup(base, { ...BODY, usageRules })).status, 200);
  const outOfRange = await postSetup(base, { ...BODY, usageRules: [{ percent: 101, signal: 'red' }] });
  assert.equal(outOfRange.status, 400);
  assert.match((await json<{ error: string }>(outOfRange)).error, /usageRules\[0\]\.percent/);
  const noEffect = await postSetup(base, { ...BODY, usageRules: [{ percent: 50 }] });
  assert.equal(noEffect.status, 400);
  assert.match((await json<{ error: string }>(noEffect)).error, /usageRules\[0\]/);
  // both rejected before the write: the file and the State still carry the valid rule
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
});

test('POST /hooks/status answers the limits line for a valid payload, an empty body otherwise, and an unknown worker changes nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const postStatus = (body: unknown, worker?: string): Promise<Response> =>
    fetch(`${base}/hooks/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(worker ? { 'x-hive-worker': worker } : {}) },
      body: JSON.stringify(body),
    });
  const payload = {
    model: { id: 'claude-opus' }, // the rest of the status line JSON rides along and is ignored
    rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1759744800 }, seven_day: { used_percentage: 41, resets_at: 1760263200 } },
  };
  const ok = await postStatus(payload, 'ghost');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await ok.text(), 'sessão 23% · semana 41%');
  const noHeader = await postStatus(payload);
  assert.equal(noHeader.status, 200);
  assert.equal(await noHeader.text(), '');
  const noLimits = await postStatus({ model: { id: 'claude-opus' } }, 'ghost');
  assert.equal(noLimits.status, 200);
  assert.equal(await noLimits.text(), '');
  const noValid = await postStatus({ rate_limits: { five_hour: { used_percentage: 'x' } } }, 'ghost');
  assert.equal(await noValid.text(), '');
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.equal(server.getState()?.rateLimits, undefined, 'no occupied slot matches, so nothing is stored');
  assert.equal((await fetch(`${base}/setup`)).status, 200, 'the server is still up');
});

test('POST /setup with epics writes it, a save without the key keeps it, a change rebuilds the board and a bad value answers 400', async (t) => {
  const { base, repo, configs } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'ignore', 'default on first setup');
  const before = configs.length;
  assert.equal((await postSetup(base, { ...BODY, epics: 'queue' })).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue');
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).config?.epics, 'queue');
  assert.equal(configs.at(-1)?.epics, 'queue', 'the live board is built with the new mode');
  assert.equal(configs.length, before + 2, 'a different epics mode needs a new board: validation + activate');
  // a save without the key keeps the file's (the API caller that omits it, like `workers`)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue');
  const bad = await postSetup(base, { ...BODY, epics: 'label' });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"epics" must be one of: ignore, queue/);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue', 'rejected before the write');
});

test('POST /setup with moves writes the whole object, GET /setup, the State and state.json carry it, a save without the key keeps it, a partial object fills hive and a bad value answers 400', async (t) => {
  const { base, repo, server } = await start(t);
  const all = { working: 'hive', review: 'hive', queue: 'hive' };
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, all, 'all hive on first setup');
  assert.deepEqual(server.getState()?.moves, all, 'configure copies it into the state');
  const moves = { working: 'hive', review: 'agent', queue: 'human' };
  assert.equal((await postSetup(base, { ...BODY, moves })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, moves);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.moves, moves);
  assert.deepEqual(server.getState()?.moves, moves, 'reconfigure copies it into the live state without an event');
  assert.deepEqual((JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State).moves, moves, 'persisted by the poll that follows');
  // a save without the key keeps the file's (the API caller that omits it, like `epics`); a partial object fills the rest with hive
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, moves);
  assert.equal((await postSetup(base, { ...BODY, moves: { queue: 'agent' } })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, { ...all, queue: 'agent' });
  const bad = await postSetup(base, { ...BODY, moves: { review: 'bot' } });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"moves\.review" must be one of: hive, agent, human/);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, { ...all, queue: 'agent' }, 'rejected before the write');
});
