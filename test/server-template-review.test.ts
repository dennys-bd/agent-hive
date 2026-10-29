import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { createCustomStore } from '../src/custom-store.js';
import type { HeadlessInput, HeadlessResult } from '../src/headless-run.js';
import { REVIEW_SCHEMA, REVIEWER_ID } from '../src/reviewer.js';
import { createServer } from '../src/server.js';
import { registerTemplateReviewRoutes } from '../src/server-template-review.js';
import { type AgentAvailability, type Config, REVIEWER_DEFAULTS, type ReviewerConfig } from '../src/types.js';
import { assertUntouched, BUILD, type Fixture, fixture, put, snapshot } from './custom-fixture.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

type Answer = (input: HeadlessInput) => Promise<HeadlessResult>;
const BOTH: AgentAvailability[] = [{ agent: 'claude', available: true }, { agent: 'codex', available: true }];
const REVIEWER_TEXT = (line: string): string => `---\nname: template-reviewer\ndescription: Reviews templates\ntools: Read\nmodel: sonnet\n---\n${line}\n`;
// Ten lines; the chain on 6..10 orders opposite things for the same lang
const CHAIN = '---\nname: new-build\ndescription: Build it\n---\n# new-build\n{% if lang == "ts" %}\nRun the tests first.\n{% elsif lang == "ts" %}\nNever run the tests.\n{% endif %}\n';
const BODY = { version: null, path: 'SKILL.md', text: CHAIN };
const NOTE = { line: 8, severity: 'red', title: 'Contradicting branches', body: 'Both branches hold for lang ts.' } as const;
const answer = (annotations: unknown[]): HeadlessResult => ({ answer: JSON.stringify({ annotations }) });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  while (!check()) await sleep(10);
}

// The custom fixture with the shipped reviewer in its fake plugin; the snapshot is retaken so assertUntouched still guards the plugin
async function reviewFixture(t: TestContext): Promise<Fixture> {
  const f = await fixture(t);
  await put(f.pluginSource, { 'agents/template-reviewer.md': REVIEWER_TEXT('You review the shipped way.') });
  return { ...f, initial: { ...f.initial, plugin: await snapshot(f.pluginSource) } };
}

interface Served { base: string; lines: string[]; calls: HeadlessInput[]; use(reviewer: Partial<ReviewerConfig>): void }
const AGENT_CONFIG: Pick<Config, 'agentModels' | 'agentEnabled'> = { agentModels: { claude: null, codex: null }, agentEnabled: { claude: true, codex: true } };

async function serve(t: TestContext, f: Fixture, run: Answer, agents = BOTH, agentConfig = AGENT_CONFIG): Promise<Served> {
  const app = express();
  app.use(express.json());
  const { log, lines } = fakeLog();
  const calls: HeadlessInput[] = [];
  let reviewer = REVIEWER_DEFAULTS;
  registerTemplateReviewRoutes(app, {
    requireLive: () => ({ runtime: { config: { defaultAgent: 'claude', ...agentConfig, reviewer, comb: { workspaces: f.workspaces } } } }),
    home: f.home, pluginSource: f.pluginSource, agents, log,
    runHeadless: (input) => { calls.push(input); return run(input); },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const use = (next: Partial<ReviewerConfig>): void => { reviewer = { ...REVIEWER_DEFAULTS, ...next }; };
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lines, calls, use };
}

const at = (id: string): string => `/api/items/${encodeURIComponent(id)}/review`;
async function review(base: string, id: string, body: unknown): Promise<[number, Record<string, unknown>]> {
  const res = await fetch(`${base}${at(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as Record<string, unknown>];
}

test("a template with two contradicting conditional blocks answers the run's annotations, marked as the agent's; the reviewer's agent and model run it; nothing is written (#328)", async (t) => {
  const f = await reviewFixture(t);
  const { base, calls, use } = await serve(t, f, async () => answer([NOTE]));
  const [status, body] = await review(base, BUILD, BODY);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { annotations: [{ ...NOTE, source: 'agent' }] });
  assert.deepEqual([calls[0].agent, 'model' in calls[0], calls[0].schema], ['claude', false, REVIEW_SCHEMA], 'defaultAgent, the CLI\'s model');
  const { prompt } = calls[0];
  assert.ok(prompt.startsWith('You review the shipped way.\n\n'), 'the shipped reviewer\'s body comes first, without its header');
  for (const part of ['8| {% elsif lang == "ts" %}', '### scripts/run.sh\necho hi', 'hive:architect']) assert.ok(prompt.includes(part), part);
  use({ agent: 'codex', model: 'opus' });
  assert.equal((await review(base, BUILD, BODY))[0], 200);
  assert.deepEqual([calls[1].agent, calls[1].model], ['codex', 'opus']);
  await assertUntouched(f);
});

test('a second review of the same item while one runs answers 409 busy and runs once; the item is free once the first ends (#328)', async (t) => {
  const f = await reviewFixture(t);
  const release = deferred<HeadlessResult>();
  let held = true;
  const { base, calls } = await serve(t, f, () => (held ? release.promise : Promise.resolve(answer([]))));
  const first = review(base, BUILD, BODY);
  await until(() => calls.length === 1);
  const [busy, refused] = await review(base, BUILD, BODY);
  assert.deepEqual([busy, refused.code, calls.length], [409, 'busy', 1]);
  held = false;
  release.resolve(answer([NOTE]));
  assert.equal((await first)[0], 200);
  assert.equal((await review(base, BUILD, BODY))[0], 200, 'free again');
});

test('with reviewer.on false the route answers 409 off and never runs (#328)', async (t) => {
  const f = await reviewFixture(t);
  const { base, calls, use } = await serve(t, f, async () => answer([]));
  use({ on: false });
  const [status, body] = await review(base, BUILD, BODY);
  assert.deepEqual([status, body.code, calls.length], [409, 'off', 0]);
});

test("a reviewer.version the reviewer does not have answers 409 reviewer_unavailable and logs why; a version it has gives its text (#328)", async (t) => {
  const f = await reviewFixture(t);
  const { base, calls, lines, use } = await serve(t, f, async () => answer([]));
  use({ version: 'ghost' });
  const [status, body] = await review(base, BUILD, BODY);
  assert.deepEqual([status, body.code, calls.length], [409, 'reviewer_unavailable', 0]);
  assert.ok(lines.some((l) => l.startsWith(`WARN review: ${BUILD} reviewer unavailable: ${REVIEWER_ID} has no version ghost`)), lines.join('\n'));
  const store = createCustomStore({ home: f.home, pluginSource: f.pluginSource, workspaces: () => f.workspaces, onChange: () => undefined, log: fakeLog().log });
  await store.saveFile(REVIEWER_ID, null, 'template-reviewer.md', REVIEWER_TEXT('You review my way.')); // the first save of an original creates mine
  use({ version: 'mine' });
  assert.equal((await review(base, BUILD, BODY))[0], 200);
  assert.ok(calls[0].prompt.startsWith('You review my way.\n\n'), calls[0].prompt.slice(0, 80));
});

test("an answer that is not the expected JSON answers 502 bad_answer, no annotation, and one review: warn line with the reason (#328)", async (t) => {
  const f = await reviewFixture(t);
  let result: HeadlessResult = { answer: 'Sure! Here are my notes.' };
  const { base, lines } = await serve(t, f, async () => result);
  const [status, body] = await review(base, BUILD, BODY);
  assert.deepEqual([status, body.code, 'annotations' in body], [502, 'bad_answer', false]);
  assert.ok(!JSON.stringify(body).includes('Sure!'), 'the raw answer never reaches the page');
  const warns = lines.filter((l) => l.startsWith('WARN review:'));
  assert.equal(warns.length, 1, lines.join('\n'));
  assert.match(warns[0], new RegExp(`^WARN review: ${BUILD} bad answer: not JSON: Sure!`));
  result = answer([NOTE, { ...NOTE, line: 11 }]);
  assert.equal((await review(base, BUILD, BODY))[1].code, 'bad_answer', 'one line past the text refuses the whole answer');
  assert.ok(lines.some((l) => l.includes('bad answer: line 11 is outside 1..10')), lines.join('\n'));
});

test('400 for a bad body; 404 for an unknown item, version or path; 409 agent_unavailable for an undetected agent; 502 run_failed for a failed run (#328)', async (t) => {
  const f = await reviewFixture(t);
  let result: HeadlessResult = answer([]);
  const { base, calls, lines, use } = await serve(t, f, async () => result, [{ agent: 'claude', available: true }, { agent: 'codex', available: false }]);
  const status = async (id: string, body: unknown): Promise<number> => (await review(base, id, body))[0];
  assert.equal(await status(BUILD, { ...BODY, text: undefined }), 400);
  assert.equal(await status('hive:nope', BODY), 404);
  assert.equal(await status(BUILD, { ...BODY, version: 'ghost' }), 404);
  assert.equal(await status(BUILD, { ...BODY, path: 'nope.md' }), 404);
  use({ agent: 'codex' });
  const [unavailable, refused] = await review(base, BUILD, BODY);
  assert.deepEqual([unavailable, refused.code], [409, 'agent_unavailable']);
  assert.equal(calls.length, 0, 'no refused request ran the agent');
  use({});
  result = { failure: 'exit code 1', detail: 'boom' };
  const [failed, why] = await review(base, BUILD, BODY);
  assert.deepEqual([failed, why.code], [502, 'run_failed']);
  assert.ok(lines.some((l) => l.startsWith(`WARN review: ${BUILD} claude run failed: exit code 1: boom`)), lines.join('\n'));
});

test('the daemon registers the route behind its gates, waiting for a config like every live route (#328)', async (t) => {
  const home = await tempDir(t, 'review-gate-');
  const server = createServer({ home, log: fakeLog().log, secret: SECRET });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  const res = await hiveFetch(`http://127.0.0.1:${port}${at(BUILD)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: '{}' });
  assert.equal(res.status, 409, 'registered: requireLive answers, not a 404');
});

test('a reviewer with model null runs its agent\'s default model; a reviewer naming a disabled agent is refused 409 with the reason and runs nothing (#482)', async (t) => {
  const f = await reviewFixture(t);
  const models = { ...AGENT_CONFIG, agentModels: { claude: 'opus', codex: null } };
  const { base, calls } = await serve(t, f, async () => answer([]), BOTH, models);
  assert.equal((await review(base, BUILD, BODY))[0], 200);
  assert.equal(calls[0].model, 'opus');
  const off = await serve(t, f, async () => answer([]), BOTH, { ...AGENT_CONFIG, agentEnabled: { claude: true, codex: false } });
  off.use({ agent: 'codex' });
  const [status, body] = await review(off.base, BUILD, BODY);
  assert.deepEqual([status, body.code, body.error], [409, 'agent_unavailable', 'agent codex is disabled: enable it in Settings › execution › agents']);
  assert.equal(off.calls.length, 0);
});
