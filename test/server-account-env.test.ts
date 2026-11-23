import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountError } from '../src/account-env.js';
import type { AccountCtx } from '../src/agents/runner.js';
import { runners } from '../src/agents/registry.js';
import { writeCredentials } from '../src/credentials.js';
import type { RecordInput } from '../src/facts.js';
import { createServer, type HiveServer, type ServerDeps } from '../src/server.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeFacts, fakeLog, fakeSourceFactory, fakeSpawn, type FakeWorker, tempHive, workspacesAt } from './fakes.js';
import { settingsBody } from './review-server.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The run env seam end to end (#953): the routes, the reducer and the pool's launches, with the runner's accountEnv faked
const TASK = 'board:I1'; // the fake source's task
const FAKE_TOKEN = 'not-a-real-token-953'; // what the temp credential store holds; never in a log line

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

interface Hive { base: string; server: HiveServer; workers: FakeWorker[]; lines: string[]; records: RecordInput[] }

// A Hive whose one workspace has `env`, a credential store holding a Claude token, every log line and fact kept
async function start(t: TestContext, env: Record<string, string> = {}, extra: Partial<ServerDeps> = {}): Promise<Hive> {
  const { home, repo } = await tempHive(t);
  const { spawn, workers } = fakeSpawn();
  const { log, lines } = fakeLog();
  const { facts, records } = fakeFacts();
  const credentialsEnv = { XDG_CONFIG_HOME: await tempDir(t, 'cred-') };
  await writeCredentials({ claude: { work: { token: FAKE_TOKEN } } }, credentialsEnv);
  const server = createServer({ secret: SECRET, home, log, facts, credentialsEnv, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: async () => ({ stdout: '' }), ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body = { ...settingsBody(repo, STAGES), auth: AUTH, sources: [GITHUB_ENTRY], workspaces: workspacesAt(repo).map((w) => ({ ...w, env })) };
  assert.equal((await postJson(`${base}/settings`, body)).status, 200);
  await server.poll();
  return { base, server, workers, lines, records };
}

// The fake runner's refusal: it reads the store, so the token is in the process, and refuses with a message that never holds it
function refuseClaude(t: TestContext): void {
  t.mock.method(runners.claude, 'accountEnv', async (ctx: AccountCtx) => {
    await ctx.credentials();
    throw new AccountError('claude', 'missing', 'no token named work');
  });
}
const noToken = (lines: readonly string[]): boolean => lines.every((line) => !line.includes(FAKE_TOKEN));
const REFUSAL = 'account claude missing: no token named work';

test('a stage run\'s env carries the runner\'s account env under the workspace\'s, which wins a shared name (#953)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: { X: '1', Y: 'account' } }));
  const { base, workers } = await start(t, { Y: 'workspace' });
  assert.deepEqual(await (await postJson(`${base}/tasks/${TASK}/start`, { base: null })).json(), { ok: true });
  await waitFor(() => workers.length === 1);
  assert.deepEqual([workers[0]?.launch.env?.X, workers[0]?.launch.env?.Y], ['1', 'workspace']);
});

test('a session\'s env carries the account env too (#953)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: { X: '1' } }));
  const { base, workers } = await start(t);
  assert.equal((await postJson(`${base}/tasks/${TASK}/open`, { kind: 'claude' })).status, 200);
  await waitFor(() => workers.length === 1);
  assert.equal(workers[0]?.launch.env?.X, '1');
});

test('a refused account on a task start is a spawn failure with its code: no pty, the reason in hive.log, never the token (#953)', async (t) => {
  refuseClaude(t);
  const { base, workers, lines, records } = await start(t);
  await postJson(`${base}/tasks/${TASK}/start`, { base: null });
  const codes = (): string[] => records.flatMap((r) => (r.event === 'run.spawn_failed' ? [r.code] : []));
  await waitFor(() => codes().length === 1);
  assert.deepEqual([codes(), workers.length], [['account_claude_missing'], 0]);
  assert.ok(lines.some((line) => line.includes(`spawnFailed pty=`) && line.includes(REFUSAL)), 'the spawnFailed line');
  assert.ok(noToken(lines));
});

test('a refused account on a session fails its start: no pty, the reason in the bar and hive.log, never the token (#953)', async (t) => {
  refuseClaude(t);
  const { base, server, workers, lines } = await start(t);
  await postJson(`${base}/tasks/${TASK}/open`, { kind: 'claude' });
  await waitFor(() => server.getState()?.error === REFUSAL);
  assert.equal(workers.length, 0);
  assert.ok(lines.some((line) => line.includes(REFUSAL)));
  assert.ok(noToken(lines));
});

test('a terminal\'s launch goes through the seam: a refusal there leaves no pty and the reason in the bar (#953)', async (t) => {
  const refuse = async (): Promise<never> => { throw new AccountError('github', 'missing'); };
  const { base, server, workers } = await start(t, {}, { accountEnv: refuse });
  await postJson(`${base}/tasks/${TASK}/open`, { kind: 'terminal' });
  await waitFor(() => server.getState()?.error === 'account github missing');
  assert.deepEqual([workers.length, server.getState()?.terminals.length], [0, 0]);
});

const STATUS = { rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1759744800 }, seven_day: { used_percentage: 41, resets_at: 1760263200 } } };
const postStatus = (base: string, ptyId: string): Promise<Response> =>
  hiveFetch(`${base}/hooks/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(STATUS) });
const rateLines = (lines: readonly string[]): string[] => lines.filter((line) => line.includes('rateLimits agent='));

test('a worker\'s status line dispatches rateLimits with the account its run resolved; an unknown pty and the run after its exit carry none (#953)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: {}, account: 'work' }));
  const { base, server, workers, lines } = await start(t);
  await postJson(`${base}/tasks/${TASK}/open`, { kind: 'claude' });
  await waitFor(() => workers.length === 1);
  const ptyId = workers[0]?.launch.ptyId ?? '';
  await postStatus(base, ptyId);
  await postStatus(base, 'ghost');
  await server.dispatch({ type: 'exit', ptyId });
  await postStatus(base, ptyId);
  await waitFor(() => rateLines(lines).length === 3);
  assert.deepEqual(rateLines(lines).map((line) => line.endsWith(' account=work')), [true, false, false]);
});

test('a run on the machine\'s login posts a status line with no account (#953)', async (t) => {
  const { base, workers, lines } = await start(t);
  await postJson(`${base}/tasks/${TASK}/open`, { kind: 'claude' });
  await waitFor(() => workers.length === 1);
  await postStatus(base, workers[0]?.launch.ptyId ?? '');
  await waitFor(() => rateLines(lines).length === 1);
  assert.equal(rateLines(lines)[0]?.includes('account='), false);
});
