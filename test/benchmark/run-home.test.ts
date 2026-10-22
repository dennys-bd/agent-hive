import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBenchmark } from '../../src/benchmark-guards.js';
import { blindnessLeak, blindnessMessage, prepareExperiment, prepareRun, renderSource } from '../../src/benchmark/run-home.js';
import { parseConfig } from '../../src/config.js';
import { shellQuote } from '../../src/shell-init.js';
import { loadState } from '../../src/state-store.js';
import { BENCH_TOKEN, type ArmSetup, type Experiment } from '../../src/types.js';
import { WS_PATH, mainConfig, arm, benchHome, experiment, ISOLATION, line, SETUP } from './fixtures.js';

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
  assert.ok(sandbox.filesystem.denyRead.includes(hiveDir), 'the whole Hive home is denied, the run\'s paths re-allowed');
  assert.ok(sandbox.filesystem.denyRead.includes(WS_PATH), 'the user\'s checkout, which holds the harness, is denied');
  assert.deepEqual(sandbox.filesystem.allowRead, [join(hiveDir, 'benchmark', 'exp-1', 'clone'), join(hiveDir, 'benchmark', 'exp-1', 'repo.git'), join(hiveDir, 'benchmark', 'exp-1', 'nested', 'docs.git'), join(run.home, 'plugins', 'hive')]);
  const denyWrite = (sandbox.filesystem as unknown as { denyWrite: string[] }).denyWrite;
  for (const dir of [join('clone', '.git'), join('clone', 'docs', '.git'), 'repo.git', join('nested', 'docs.git')]) for (const f of ['hooks', 'config']) assert.ok(denyWrite.includes(join(hiveDir, 'benchmark', 'exp-1', dir, f)), `${dir}/${f}`);
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

test('a run\'s mcp setting is the default: the user\'s servers and their tokens do not reach a worker (#471)', async (t) => {
  const { deps } = await benchHome(t);
  const server = { name: 'private', workspace: null, on: true, url: 'https://mcp.example', authHeader: 'Bearer secret' };
  const run = await prepareRun(EXP, EXP.arms[0], 1, { ...deps, config: { ...deps.config, mcp: { off: [], servers: [server] } } });
  assert.deepEqual(parseConfig(await readJson(join(run.home, 'hive.config.json'))).mcp, { off: [], servers: [] });
});

test('a symlink in a custom version folder is not copied into the run home (#471)', async (t) => {
  const { hiveDir, deps } = await benchHome(t);
  const files = join(hiveDir, 'benchmark', 'exp-1', 'plugin', 'custom', 'hive', 'new-spec', 'terse', 'files');
  await writeFile(join(hiveDir, 'outside.txt'), 'outside');
  await symlink(join(hiveDir, 'outside.txt'), join(files, 'link.txt'));
  const run = await prepareRun(EXP, EXP.arms[1], 1, deps);
  assert.deepEqual(await readdir(join(run.home, 'custom', 'hive', 'new-spec', 'terse', 'files')), ['SKILL.md']);
});

test('the blindness check also reads the worktree setup and teardown and the resolved env values (#471)', async (t) => {
  const { deps } = await benchHome(t);
  for (const [patch, where] of [
    [{ arms: [arm('a1', 'A', { worktree: { setup: 'RUN echo benchmark', teardown: '' } })] }, 'worktree setup'],
    [{ arms: [arm('a1', 'A', { worktree: { setup: '', teardown: 'RUN echo benchmark' } })] }, 'worktree teardown'],
    [{ isolation: { ...ISOLATION, env: { all: { CI: '1' }, perArm: { a1: { LABEL: 'benchmark' } } } } }, 'env LABEL'],
  ] as [Partial<Experiment>, string][]) {
    const exp = experiment(patch);
    await assert.rejects(prepareRun(exp, exp.arms[0], 1, deps), (err: Error) => /blindness: "benchmark"/.test(err.message) && err.message.includes(where), where);
  }
});

test('a home that fails after the branches were pushed takes the run branch off every origin and removes the partial home (#471)', async (t) => {
  const { hiveDir, calls, deps } = await benchHome(t);
  // The pin holds the versions a run copies (#459), so the corrupt one is the pin's
  await writeFile(join(hiveDir, 'benchmark', 'exp-1', 'plugin', 'custom', 'hive', 'new-spec', 'terse', 'version.json'), '{ not json');
  await assert.rejects(prepareRun(EXP, EXP.arms[1], 1, deps));
  const clone = join(hiveDir, 'benchmark', 'exp-1', 'clone');
  const deleted = calls.filter((c) => c.args[0] === 'push' && c.args.includes('--delete'));
  assert.deepEqual(deleted.map((c) => c.cwd), [clone, join(clone, 'docs')]);
  assert.ok(deleted.every((c) => /^work\/[a-z0-9]{8}$/.test(c.args[3])));
  assert.deepEqual(await readdir(join(hiveDir, 'benchmark', 'exp-1', 'runs')).catch(() => []), []);
});

test('a nested repo path that is absolute, empty, dashed or climbs out is refused before anything is made (#471)', async (t) => {
  const { hiveDir, calls, deps } = await benchHome(t);
  for (const bad of ['../x', '/abs', '-flag', '', 'a/../../b']) {
    const [ws] = deps.config.comb.workspaces;
    const config = { ...deps.config, comb: { ...deps.config.comb, workspaces: [{ ...ws, nestedRepos: [bad] }] } };
    await assert.rejects(prepareRun(EXP, EXP.arms[0], 1, { ...deps, config }), /nested repo path/, bad);
    await assert.rejects(prepareExperiment(experiment(), { ...deps, config }), /nested repo path/, bad);
  }
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(hiveDir, 'benchmark', 'exp-1', 'repo.git')));
  assert.equal(mainConfig().comb.workspaces[0].nestedRepos[0], 'docs');
});

test("prepareRun copies the arm's versions from the experiment's pin, never the current store; a version only the current store holds refuses the run (#459)", async (t) => {
  const { deps } = await benchHome(t);
  const run = await prepareRun(EXP, EXP.arms[1], 1, deps);
  assert.equal(await readFile(join(run.home, 'custom', 'hive', 'new-spec', 'terse', 'files', 'SKILL.md'), 'utf8'), 'Spec skill for this arm, terse.');
  const fresh = experiment({ arms: [arm('a1', 'A', { items: { 'hive:new-spec': 'fresh' } })] });
  await assert.rejects(prepareRun(fresh, fresh.arms[0], 1, (await benchHome(t)).deps), /has no version fresh/);
});

test("a run home renders from its experiment's pinned plugin source; any other home from the shipped plugin (#459)", async (t) => {
  const { hiveDir, deps } = await benchHome(t);
  const run = await prepareRun(EXP, EXP.arms[0], 1, deps);
  assert.equal(renderSource(run.home, '/shipped/plugin'), join(hiveDir, 'benchmark', 'exp-1', 'plugin', 'source'));
  assert.equal(renderSource(hiveDir, '/shipped/plugin'), '/shipped/plugin');
});

test("blindnessLeak answers the first forbidden word an arm's worker would read and writes nothing; off, or with no hit, undefined (#472)", async (t) => {
  const { deps, calls } = await benchHome(t);
  const leaking = experiment({ arms: [arm('a1', 'A', { tasks: [{ key: 'T1', title: 'One', body: 'a benchmark task', blockedBy: [] }] })] });
  const leak = await blindnessLeak(leaking, leaking.arms[0], deps);
  assert.deepEqual(leak, { where: 'task T1', word: 'benchmark' });
  assert.equal(leak && blindnessMessage(leak), 'blindness: "benchmark" in task T1');
  assert.equal(await blindnessLeak({ ...leaking, blindness: { on: false, forbiddenWords: ['benchmark'] } }, leaking.arms[0], deps), undefined);
  assert.equal(await blindnessLeak(EXP, EXP.arms[1], deps), undefined);
  assert.deepEqual(calls, []);
});
