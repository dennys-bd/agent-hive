import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Board } from '../src/board.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Config, SetupBody, SetupInfo } from '../src/types.js';

const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];
const BODY: SetupBody = {
  project: { owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 0, // zero slots: nothing is ever spawned (spawn would open an iTerm tab)
};

// A board that has the OPTIONS columns and returns one task named after the configured queue column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap.
function fakeBoardFactory(resolveDelayMs = 0): { factory: (config: Config) => Board; configs: Config[] } {
  const configs: Config[] = [];
  const factory = (config: Config): Board => {
    configs.push(config);
    return {
      async resolveFields() {
        if (resolveDelayMs > 0) await sleep(resolveDelayMs);
        for (const key of ['queue', 'working', 'review'] as const) {
          const wanted = config.status[key];
          if (!OPTIONS.includes(wanted)) {
            throw new Error(`status.${key} "${wanted}" not found in board Status options: ${OPTIONS.join(', ')}`);
          }
        }
      },
      async listQueue() {
        return [{ itemId: 'I1', number: 1, title: `from ${config.status.queue}`, body: '', url: 'https://github.com/acme/r/issues/1' }];
      },
      async setStatus() {},
    };
  };
  return { factory, configs };
}

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

test('setup listings reject a missing owner or number with 400', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/setup/projects`)).status, 400);
  assert.equal((await fetch(`${base}/setup/columns?owner=acme`)).status, 400);
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
  assert.equal(info.config?.project.number, 6);
  assert.ok(info.config && !('promptTemplate' in info.config));
});

test('POST /setup with a column the board does not have answers 400 and writes nothing', async (t) => {
  const { base, repo, server } = await start(t);
  const res = await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Todo' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /"Todo".*Ready, In progress, In review, Done/);
  await assert.rejects(stat(configFile(repo)));
  assert.equal(server.getState(), undefined);
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).configured, false);
});

test('POST /setup with an invalid body answers 400 naming the field', async (t) => {
  const { base, repo } = await start(t);
  const res = await postSetup(base, { ...BODY, project: { owner: 'acme' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /project\.number/);
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
