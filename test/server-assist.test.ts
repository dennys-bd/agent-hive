import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { ASSIST_SCHEMA, type AssistAnswer } from '../src/assist.js';
import type { HeadlessInput, HeadlessResult } from '../src/headless-run.js';
import { createServer } from '../src/server.js';
import { registerAssistRoutes } from '../src/server-assist.js';
import type { AgentAvailability, Config } from '../src/types.js';
import { ARCHITECT, assertUntouched, BUILD, type Fixture, fixture, SKILL, SPECIALIST } from './custom-fixture.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

type Answer = (input: HeadlessInput) => Promise<HeadlessResult>;
const BOTH: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }];
// SKILL is five lines; its fifth is `# new-build`
const BODY = { version: null, path: 'SKILL.md', text: SKILL, request: 'a friendlier title', selection: { startLine: 5, endLine: 5 } };
const answer = (from: number, to: number, text: string): HeadlessResult => ({ answer: JSON.stringify({ from, to, text }) });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  while (!check()) await sleep(10);
}

const AGENT_CONFIG: Pick<Config, 'agentModels' | 'agentEnabled'> = { agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true } };

async function serve(t: TestContext, f: Fixture, run: Answer, agents = BOTH, agentConfig = AGENT_CONFIG): Promise<{ base: string; lines: string[]; calls: HeadlessInput[] }> {
  const app = express();
  app.use(express.json());
  const { log, lines } = fakeLog();
  const calls: HeadlessInput[] = [];
  registerAssistRoutes(app, {
    requireLive: () => ({ runtime: { config: { defaultAgent: 'claude', ...agentConfig, comb: { workspaces: f.workspaces } } } }),
    home: f.home, pluginSource: f.pluginSource, agents, log,
    runHeadless: (input) => { calls.push(input); return run(input); },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lines, calls };
}

const at = (id: string): string => `/api/items/${encodeURIComponent(id)}/assist`;
async function ask(base: string, id: string, body: unknown, signal?: AbortSignal): Promise<[number, Record<string, unknown>]> {
  const res = await fetch(`${base}${at(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  return [res.status, (await res.json()) as Record<string, unknown>];
}

test('a request over a selection answers the proposal, its hunk, the new text and changed; the default agent runs with the schema; nothing is written (#330)', async (t) => {
  const f = await fixture(t);
  const { base, calls } = await serve(t, f, async () => answer(5, 5, '# New build'));
  const [status, body] = await ask(base, BUILD, { ...BODY, model: 'opus' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    proposal: { from: 5, to: 5, text: '# New build' },
    hunk: { header: '@@ -5,1 +5,1 @@', lines: [{ kind: 'del', text: '# new-build', old: 5 }, { kind: 'add', text: '# New build', new: 5 }] },
    text: SKILL.replace('# new-build', '# New build'),
    changed: true,
  } satisfies AssistAnswer);
  assert.deepEqual([calls[0].agent, calls[0].model, calls[0].schema], ['claude', 'opus', ASSIST_SCHEMA]);
  assert.ok(calls[0].prompt.includes('a friendlier title') && calls[0].prompt.includes('lines 5..5') && calls[0].prompt.includes(ARCHITECT));
  const [, same] = await ask(base, BUILD, { ...BODY, selection: undefined }); // no selection: the whole file, and an answer equal to it
  assert.equal(same.changed, true, 'the fake still answers line 5; whole-file target accepts it');
  await assertUntouched(f);
});

test('a second request for the same item while one runs answers 409 busy; another item runs; the item is free once the first ends (#330)', async (t) => {
  const f = await fixture(t);
  const release = deferred<HeadlessResult>();
  let held = true;
  const { base, calls } = await serve(t, f, () => (held ? release.promise : Promise.resolve(answer(5, 5, '# x'))));
  const first = ask(base, BUILD, BODY);
  await until(() => calls.length === 1);
  held = false;
  const [busy, refused] = await ask(base, BUILD, { ...BODY, version: null });
  assert.deepEqual([busy, refused.code], [409, 'busy']);
  assert.equal((await ask(base, ARCHITECT, { version: null, path: 'architect.md', text: SPECIALIST, request: 'r' }))[0], 200, 'per item');
  release.resolve(answer(5, 5, '# x'));
  assert.equal((await first)[0], 200);
  assert.equal((await ask(base, BUILD, BODY))[0], 200, 'free again');
});

test('an answer outside the selection is refused with 502 bad_answer and its reason logged; a failed run answers 502 run_failed (#330)', async (t) => {
  const f = await fixture(t);
  let result: HeadlessResult = answer(1, 5, 'everything');
  const { base, lines } = await serve(t, f, async () => result);
  const [status, body] = await ask(base, BUILD, BODY);
  assert.deepEqual([status, body.code], [502, 'bad_answer']);
  assert.ok(!JSON.stringify(body).includes('everything'), 'the raw answer never reaches the page');
  assert.ok(lines.some((l) => l.startsWith(`WARN assist: ${BUILD} bad answer: lines 1..5 are outside 5..5`)), lines.join('\n'));
  result = { answer: 'not json at all' };
  assert.equal((await ask(base, BUILD, BODY))[1].code, 'bad_answer');
  result = { failure: 'exit code 1', detail: 'boom' };
  const [failed, why] = await ask(base, BUILD, BODY);
  assert.deepEqual([failed, why.code], [502, 'run_failed']);
  assert.ok(lines.some((l) => l.startsWith(`WARN assist: ${BUILD} claude run failed: exit code 1: boom`)), lines.join('\n'));
});

test('400 for a bad body or a selection outside the text; 404 for an unknown item, version or path; 409 agent_unavailable for an undetected agent (#330)', async (t) => {
  const f = await fixture(t);
  const { base, calls } = await serve(t, f, async () => answer(5, 5, 'x'), [{ agent: 'claude', available: true }, { agent: 'codex', available: false }]);
  const status = async (id: string, body: unknown): Promise<number> => (await ask(base, id, body))[0];
  assert.equal(await status(BUILD, { ...BODY, request: undefined }), 400);
  assert.equal(await status(BUILD, { ...BODY, agent: 'gemini' }), 400);
  assert.equal(await status(BUILD, { ...BODY, model: '--help' }), 400, 'a model never reads as an option');
  assert.equal(await status(BUILD, { ...BODY, model: 'x'.repeat(101) }), 400);
  assert.equal(await status(BUILD, { ...BODY, selection: { startLine: 6, endLine: 6 } }), 400);
  assert.equal(await status('hive:nope', BODY), 404);
  assert.equal(await status(BUILD, { ...BODY, version: 'ghost' }), 404);
  assert.equal(await status(BUILD, { ...BODY, path: 'nope.md' }), 404);
  const [unavailable, body] = await ask(base, BUILD, { ...BODY, agent: 'codex' });
  assert.deepEqual([unavailable, body.code], [409, 'agent_unavailable']);
  assert.equal(calls.length, 0, 'no refused request ran the agent');
});

test('a client that goes away aborts the run, which logs no failure and frees the item (#330)', async (t) => {
  const f = await fixture(t);
  const aborted = deferred<void>();
  let hold = true;
  const { base, calls, lines } = await serve(t, f, (input) => (hold
    ? new Promise((resolve) => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve({ failure: 'cancelled', detail: '' }); }))
    : Promise.resolve(answer(5, 5, 'x'))));
  const controller = new AbortController();
  const pending = ask(base, BUILD, BODY, controller.signal).catch(() => 'aborted');
  await until(() => calls.length === 1);
  controller.abort();
  await aborted.promise;
  assert.equal(await pending, 'aborted');
  hold = false;
  assert.equal((await ask(base, BUILD, BODY))[0], 200, 'free again');
  assert.ok(lines.includes(`INFO assist: ${BUILD} cancelled`), lines.join('\n'));
  assert.ok(!lines.some((l) => l.startsWith('ERROR') || l.startsWith('WARN')), lines.join('\n'));
});

test('the daemon registers the route behind its gates, waiting for a config like every live route (#330)', async (t) => {
  const home = await tempDir(t, 'assist-gate-');
  const server = createServer({ home, log: fakeLog().log, secret: SECRET });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  const res = await hiveFetch(`http://127.0.0.1:${port}${at(BUILD)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: '{}' });
  assert.equal(res.status, 409, 'registered: requireLive answers, not a 404');
});

test('a request with no model runs the agent\'s default model; its own model wins (#482)', async (t) => {
  const f = await fixture(t);
  const { base, calls } = await serve(t, f, async () => answer(5, 5, '# x'), BOTH, { ...AGENT_CONFIG, agentModels: { claude: 'opus', codex: null } });
  await ask(base, BUILD, BODY);
  await ask(base, ARCHITECT, { version: null, path: 'architect.md', text: SPECIALIST, request: 'r', model: 'haiku' }); // another item: no busy
  assert.deepEqual(calls.map((c) => c.model), ['opus', 'haiku']);
});
