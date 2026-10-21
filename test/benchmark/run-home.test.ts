import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBenchmark } from '../../src/benchmark-guards.js';
import { prepareRun } from '../../src/benchmark/run-home.js';
import { parseConfig } from '../../src/config.js';
import { shellQuote } from '../../src/shell-init.js';
import { loadState } from '../../src/state-store.js';
import { BENCH_TOKEN, type ArmSetup } from '../../src/types.js';
import { arm, benchHome, experiment, ISOLATION, line, SETUP } from './fixtures.js';

const OVERRIDES: Partial<ArmSetup> = {
  stages: { ...SETUP.stages, build: { agent: 'claude', skill: '/x', prompt: 'ARM-BUILD {title}' } },
  rules: { allow: ['Bash(make:*)'], deny: ['Bash(curl:*)'] }, items: { 'hive:new-spec': 'terse' },
  worktree: { setup: 'RUN pnpm install', teardown: 'RUN echo bye' },
  tasks: [{ key: 'T1', title: 'One', body: 'b', blockedBy: [] }, { key: 'T2', title: 'Two', body: 'c', blockedBy: ['T1'] }],
};
const EXP = experiment({ arms: [arm('a1', 'A'), arm('a2', 'B', OVERRIDES)], isolation: { ...ISOLATION, network: { all: ['registry.npmjs.org'], perArm: { a2: ['example.org'] } } } });
const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8'));

test('prepareRun writes a config that parses: the arm\'s stages and prompts, the clone with the sandbox copy first, its teardown and env, no sources, no port (#471)', async (t) => {
  const { hiveDir, deps } = await benchHome(t);
  const run = await prepareRun(EXP, EXP.arms[1], 1, deps);
  const raw = await readJson(join(run.home, 'hive.config.json'));
  const config = parseConfig(raw);
  assert.deepEqual(config.comb.stages.map((s) => s.prompt), [SETUP.stages.spec.prompt, SETUP.stages.plan.prompt, 'ARM-BUILD {title}', SETUP.stages.pr.prompt, undefined]);
  const [ws] = config.comb.workspaces;
  assert.equal(ws.path, join(hiveDir, 'benchmark', 'exp-1', 'clone'));
  assert.deepEqual(ws.setup?.split('\n'), [`RUN mkdir -p .claude && cp ${shellQuote(join(run.home, 'sandbox.json'))} .claude/settings.local.json`, 'RUN pnpm install']);
  assert.deepEqual([ws.teardown, ws.env, ws.nestedRepos, ws.baseBranch], ['RUN echo bye', { A: '1', CI: '1' }, ['docs'], undefined]);
  assert.deepEqual([config.comb.sources, config.comb.hiveSource, config.baseBranch, 'port' in raw, 'branch' in raw], [[], true, run.branch, false, false]);
  for (const rule of ['Bash(make:*)', 'Bash(curl:*)', '--max-turns']) assert.ok(config.agentArgs.claude.join(' ').includes(rule), rule);
});

test('prepareRun writes the tasks with the right auto and cap, only the mapped version for the run workspace, the arm\'s sandbox and the marker (#471)', async (t) => {
  const { hiveDir, deps } = await benchHome(t);
  const run = await prepareRun(EXP, EXP.arms[1], 2, deps);
  const state = await loadState(run.home);
  assert.deepEqual([state.maxConcurrent, state.tasks.map((x) => x.auto)], [3, [true, false]]);
  assert.deepEqual(await readdir(join(run.home, 'custom', 'hive', 'new-spec')), ['terse']);
  assert.deepEqual((await readJson(join(run.home, 'custom', 'hive', 'new-spec', 'terse', 'version.json'))).workspaces, ['hive']);
  const sandbox = (await readJson(join(run.home, 'sandbox.json'))).sandbox as { network: { allowedDomains: string[] }; filesystem: { denyRead: string[]; allowRead: string[] } };
  assert.deepEqual(sandbox.network.allowedDomains, ['example.org']);
  assert.ok(sandbox.filesystem.denyRead.includes(join(hiveDir, 'benchmark', 'exp-1')));
  assert.ok(sandbox.filesystem.allowRead.includes(join(run.home, 'plugins', 'hive')));
  assert.deepEqual(await readJson(join(run.home, 'benchmark.json')), { experiment: { id: 'exp-1', name: 'Skills' }, arm: { letter: 'B', name: 'arm B' }, round: 2, pairs: 3, token: run.token, frozen: false });
  assert.equal((await stat(run.home)).mode & 0o777, 0o700);
});

test('the token is drawn, not derived: two arms on the same draw get the same name; the branch and prefix are the token\'s and the run passes the guard (#471)', async (t) => {
  const a = await prepareRun(EXP, EXP.arms[0], 1, (await benchHome(t)).deps);
  const env = await benchHome(t);
  const b = await prepareRun(EXP, EXP.arms[1], 1, env.deps);
  assert.equal(a.token, b.token);
  assert.match(b.token, /^[a-z][a-z0-9]{7}$/);
  assert.ok(BENCH_TOKEN.test(b.token));
  assert.deepEqual([b.branch, b.status, b.total, b.armId], [`work/${b.token}`, 'queued', 2, 'a2']);
  for (const repo of ['clone', join('clone', 'docs')]) assert.ok(env.calls.some((c) => c.cwd === join(env.hiveDir, 'benchmark', 'exp-1', repo) && line(c) === `git push -u origin work/${b.token}`), repo);
  const loaded = loadBenchmark({ experiments: [{ ...EXP, rounds: [{ n: 1, runs: [b] }] }] }, env.hiveDir);
  assert.equal(loaded.experiments[0].rounds[0].runs.length, 1);
  assert.ok(env.lines.every((l) => !l.includes(env.hiveDir) && l.startsWith(`benchmark exp-1 ${b.token}:`)), env.lines.join('\n'));
});
