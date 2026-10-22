import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blindTells, hasTell } from '../../src/benchmark/blind.js';
import { type Click, TESTER_SCHEMA } from '../../src/benchmark/browser.js';
import { type EvaluateDeps, evaluateRun } from '../../src/benchmark/evaluate.js';
import type { Run } from '../../src/benchmark/exec.js';
import { JUDGE_SCHEMA } from '../../src/evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../../src/headless-run.js';
import type { BenchEvaluation, BenchScenario } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import { experiment, run } from './fixtures.js';

const TOKEN = 'tok1a';
const BRANCH = `neutral/${TOKEN}`;
const AT = Date.parse('2026-10-21T12:00:00.000Z');
const SCENARIOS: BenchScenario[] = [{ id: 'S1', title: 'Sign in', text: 'Expected: the list shows.' }, { id: 'S2', title: 'Add', text: 'Expected: a row.' }];

function fakeGit(o: { branch?: boolean } = {}) {
  const calls: { line: string; cwd?: string }[] = [];
  const exec: Run = async (file, args, opts = {}) => {
    const line = [file, ...args].join(' ');
    calls.push({ line, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
    if (line.startsWith('git ls-remote')) return { stdout: o.branch === false ? '' : `abc\trefs/heads/${BRANCH}\n` };
    if (line.startsWith('git worktree add')) { await mkdir(args[3] ?? '', { recursive: true }); return { stdout: '' }; }
    if (line.startsWith('git diff --shortstat')) return { stdout: ' 1 file changed, 1 insertion(+)\n' };
    if (line.startsWith('git diff')) return { stdout: '+ /hive:new-build wrote this\n' };
    return { stdout: '' };
  };
  return { exec, calls };
}

function fakeAgents(o: { judge?: HeadlessResult; collectorFails?: boolean } = {}) {
  const inputs: HeadlessInput[] = [];
  const headless = async (input: HeadlessInput): Promise<HeadlessResult> => {
    inputs.push(input);
    if (input.schema === TESTER_SCHEMA) {
      await writeFile(join(input.cwd ?? '', 'S1-1.png'), 'png');
      return { answer: JSON.stringify({ scenarios: [{ scenario: 'S1', passed: true, notes: 'ok', screenshots: ['S1-1.png'] }, { scenario: 'S2', passed: false, notes: 'the button did nothing', screenshots: [] }] }) };
    }
    if (input.schema === JUDGE_SCHEMA) return o.judge ?? { answer: JSON.stringify({ scores: [{ dimension: 'a', score: 4, evidence: 'diff.patch' }, { dimension: 'b', score: 3, evidence: 'scenarios.json' }] }) };
    if (o.collectorFails && input.prompt.includes('Your focus: security')) return { failure: 'timed out after 1200000 ms', detail: '' };
    return { answer: '{"findings":[{"file":"a.ts","line":1,"finding":"x"}]}' };
  };
  return { headless, inputs };
}

async function setup(t: TestContext, evaluation: Partial<BenchEvaluation> = {}) {
  const folder = await tempDir(t, 'bench-');
  await mkdir(join(folder, 'tmp'));
  await mkdir(join(folder, 'plugin', 'source', 'agents'), { recursive: true });
  const home = join(folder, 'runs', TOKEN);
  await mkdir(join(home, 'eval', 'screens'), { recursive: true });
  await writeFile(join(home, 'eval', 'screens', 'stale.png'), 'old');
  const base = experiment();
  const exp = experiment({
    seed: { ...base.seed, sample: { command: 'pnpm start', url: 'http://127.0.0.1:5173/', files: [] }, scenarios: SCENARIOS },
    evaluation: { collectors: [{ agent: 'claude', focus: 'security' }, { agent: 'claude', focus: 'tests' }], dynamic: true, tester: { agent: 'claude', model: 'sonnet' }, scenarioWalks: 2, judge: { agent: 'claude', model: 'opus' }, rubric: 'Correct?\nTested?', ...evaluation },
  });
  return { folder, home, ctx: { experiment: exp, run: run(TOKEN, { status: 'done', home, branch: BRANCH }), folder } };
}

function depsOf(folder: string, exec: Run, headless: EvaluateDeps['headless'], o: { chromium?: { path: string } | { reason: string } } = {}) {
  const kills: [number, string][] = [];
  const spawned: string[][] = [];
  const lines: string[] = [];
  let chromiumAsked = 0;
  const events = new EventEmitter();
  const deps: EvaluateDeps = {
    exec, headless, log: (line) => lines.push(line), signal: new AbortController().signal, tmpRoot: join(folder, 'tmp'), now: () => AT, sleep: async () => undefined,
    browser: { ensureChromium: async () => { chromiumAsked += 1; return o.chromium ?? { path: '/pw/chrome' }; }, mcpBinary: async () => '/pkg/mcp/cli.js' },
    spawnSample: (file, args) => { spawned.push([file, ...args]); return { pid: 4242, exitCode: null, once: (event, listener) => events.once(event, listener) }; },
    kill: (pid, signal) => { kills.push([pid, signal]); events.emit('exit'); },
    fetch: async () => ({ status: 200 }),
  };
  return { deps, kills, spawned, lines, chromiumAsked: () => chromiumAsked };
}

const removed = (calls: { line: string }[], home: string): boolean => calls.some((c) => c.line === `git worktree remove --force ${join(home, 'eval', 'worktree')}`);

test('evaluateRun reviews, walks and judges the run branch: one result per collector, per scenario over the walks and per rubric line; every file written, the worktree removed (#474)', async (t) => {
  const { folder, home, ctx } = await setup(t);
  const git = fakeGit();
  const agents = fakeAgents();
  const d = depsOf(folder, git.exec, agents.headless);
  const evaluation = await evaluateRun(ctx, d.deps);
  assert.ok(evaluation);
  assert.equal(evaluation.at, new Date(AT).toISOString());
  assert.deepEqual(evaluation.collectors.map((c) => [c.name, c.status, c.summary]), [['claude · security', 'warn', '1 findings'], ['claude · tests', 'warn', '1 findings']]);
  assert.deepEqual(evaluation.scenarios, [{ id: 'S1', passed: 2, total: 2, screenshots: ['1-S1-1.png', '2-S1-1.png'] }, { id: 'S2', passed: 0, total: 2, screenshots: [] }]);
  assert.deepEqual(evaluation.judge.scores.map((s) => [s.dimension, s.score]), [['Correct?', 4], ['Tested?', 3]]);
  assert.deepEqual([evaluation.judge.agent, evaluation.judge.model, evaluation.judge.rubricHash.length], ['claude', 'opus', 12]);
  const evalDir = join(home, 'eval');
  assert.deepEqual(JSON.parse(await readFile(join(evalDir, 'judge.json'), 'utf8')), evaluation.judge);
  assert.equal((JSON.parse(await readFile(join(evalDir, 'clicks.json'), 'utf8')) as Click[][]).length, 2);
  assert.deepEqual((await readdir(join(evalDir, 'screens'))).sort(), ['1-S1-1.png', '2-S1-1.png'], 'a re-evaluation starts clean');
  const tells = blindTells(ctx.experiment, []);
  for (const name of ['diff.patch', 'metrics.json', 'findings.json', 'scenarios.json']) assert.equal(hasTell(await readFile(join(evalDir, 'bundle', name), 'utf8'), tells), false, name);
  assert.deepEqual((await readdir(join(evalDir, 'bundle', 'screens'))).sort(), ['S1-1-1.png', 'S1-2-1.png']);
  const judge = agents.inputs.find((i) => i.schema === JUDGE_SCHEMA);
  assert.ok(judge?.cwd?.startsWith(join(folder, 'tmp')), 'the judge runs in a temp folder, not the worktree');
  assert.equal(judge?.prompt.includes('/hive:new-build'), false, 'the judge prompt is scrubbed too');
  for (const input of agents.inputs.filter((i) => i.schema !== JUDGE_SCHEMA && i.schema !== TESTER_SCHEMA)) assert.equal(input.cwd, join(evalDir, 'worktree'));
  assert.deepEqual(d.spawned, [[process.env.SHELL ?? '/bin/sh', '-c', 'pnpm start']]);
  assert.deepEqual(d.kills, [[-4242, 'SIGTERM']]);
  assert.ok(removed(git.calls, home));
  assert.deepEqual(await readdir(join(folder, 'tmp')), []);
  assert.ok(git.calls.some((c) => c.line === `git worktree add --detach ${join(evalDir, 'worktree')} origin/${BRANCH}` && c.cwd === join(folder, 'clone')));
});

test('a failing collector is error with its reason and the other collectors and the judge go on (#474)', async (t) => {
  const { folder, ctx } = await setup(t);
  const evaluation = await evaluateRun(ctx, depsOf(folder, fakeGit().exec, fakeAgents({ collectorFails: true }).headless).deps);
  assert.deepEqual(evaluation?.collectors.map((c) => [c.status, c.summary]), [['error', 'timed out after 1200000 ms'], ['warn', '1 findings']]);
  assert.equal(evaluation?.judge.scores.length, 2);
});

test('without Chromium, or with a tester whose agent takes no MCP config, every scenario is 0 over the walks with the reason, no sample starts, and the judge still runs (#474)', async (t) => {
  const cases: [Partial<BenchEvaluation>, { path: string } | { reason: string } | undefined, string][] = [
    [{}, { reason: 'Chromium is not installed: no network' }, 'Chromium is not installed: no network'],
    [{ tester: { agent: 'codex' } }, undefined, 'codex cannot run the tester (no MCP config in a headless run)'],
  ];
  for (const [evaluation, chromium, reason] of cases) {
    const { folder, home, ctx } = await setup(t, evaluation);
    const git = fakeGit();
    const agents = fakeAgents();
    const d = depsOf(folder, git.exec, agents.headless, chromium === undefined ? {} : { chromium });
    const result = await evaluateRun(ctx, d.deps);
    assert.deepEqual(result?.scenarios.map((s) => [s.passed, s.total]), [[0, 2], [0, 2]], reason);
    const clicks = JSON.parse(await readFile(join(home, 'eval', 'clicks.json'), 'utf8')) as Click[][];
    assert.ok(clicks.flat().every((c) => c.notes === reason), reason);
    assert.deepEqual([d.spawned.length, agents.inputs.filter((i) => i.schema === TESTER_SCHEMA).length], [0, 0], reason);
    assert.equal(result?.judge.scores.length, 2, reason);
    assert.ok(removed(git.calls, home), reason);
    if (evaluation.tester) assert.equal(d.chromiumAsked(), 0, 'the refusal comes before Chromium');
  }
});

test('a run branch missing from repo.git gets the no-branch evaluation: every collector error, every scenario 0 over the walks, every score 1, and no headless run (#474)', async (t) => {
  const { folder, home, ctx } = await setup(t);
  const git = fakeGit({ branch: false });
  const agents = fakeAgents();
  const evaluation = await evaluateRun(ctx, depsOf(folder, git.exec, agents.headless).deps);
  assert.deepEqual(evaluation?.collectors.map((c) => [c.status, c.summary]), [['error', 'the run branch does not exist'], ['error', 'the run branch does not exist']]);
  assert.deepEqual(evaluation?.scenarios, [{ id: 'S1', passed: 0, total: 2, screenshots: [] }, { id: 'S2', passed: 0, total: 2, screenshots: [] }]);
  assert.deepEqual(evaluation?.judge.scores, [{ dimension: 'Correct?', score: 1, evidence: 'the run branch does not exist' }, { dimension: 'Tested?', score: 1, evidence: 'the run branch does not exist' }]);
  assert.equal(agents.inputs.length, 0);
  assert.equal(git.calls.some((c) => c.line.startsWith('git worktree add') || c.line.startsWith('git fetch')), false);
  assert.ok(existsSync(join(home, 'eval', 'judge.json')));
});

test('a judge that fails answers undefined, writes no judge.json and still removes the worktree (#474)', async (t) => {
  const { folder, home, ctx } = await setup(t);
  const git = fakeGit();
  const d = depsOf(folder, git.exec, fakeAgents({ judge: { failure: 'timed out after 1200000 ms', detail: 'evidence' } }).headless);
  assert.equal(await evaluateRun(ctx, d.deps), undefined);
  assert.equal(existsSync(join(home, 'eval', 'judge.json')), false);
  assert.ok(removed(git.calls, home));
  assert.ok(d.lines.includes('judge: error'));
  assert.equal(d.lines.some((l) => l.includes('evidence') || l.includes('pnpm start')), false, 'no evidence and no command line in the log');
});

test('with dynamic off there is no scenario, no tester and no sample (#474)', async (t) => {
  const { folder, ctx } = await setup(t, { dynamic: false });
  const agents = fakeAgents();
  const d = depsOf(folder, fakeGit().exec, agents.headless);
  const evaluation = await evaluateRun(ctx, d.deps);
  assert.deepEqual(evaluation?.scenarios, []);
  assert.deepEqual([d.spawned.length, d.chromiumAsked(), agents.inputs.filter((i) => i.schema === TESTER_SCHEMA).length], [0, 0, 0]);
});
