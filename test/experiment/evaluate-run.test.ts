import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasTell } from '../../scripts/experiment/blind.js';
import type { Launch } from '../../scripts/experiment/browser.js';
import { type EvalDeps, evaluateRun } from '../../scripts/experiment/evaluate-run.js';
import type { Run } from '../../scripts/experiment/exec.js';
import { readJson, writeJson } from '../../scripts/experiment/files.js';
import { failedMetrics } from '../../scripts/experiment/metrics.js';
import type { Click, Judge } from '../../scripts/experiment/types.js';
import { tempDir } from '../temp-dir.js';
import { fakeBrowser, fakeChild, fakeRun, line, SEED } from './fixtures.js';

const NIGHT = new Date('2026-10-01T22:00:00.000Z');
const SECRET = 'd'.repeat(64);
const BRANCH = 'feat/monitor-view-abc123';
const TOKEN = 'abc123';
const JUDGED = { fidelity: { score: 7, reason: 'r' }, behaviour: { score: 6, reason: 'r' }, code: { score: 6, reason: 'r' }, specAndPlan: { score: 5, reason: 'r' }, tests: { score: 4, reason: 'r' } };

function tools(o: { buildFails?: boolean; badShot?: boolean } = {}): ReturnType<typeof fakeRun> {
  return fakeRun((call) => {
    const cmd = line(call);
    if (cmd === 'pnpm build' && o.buildFails) return new Error('tsc: error TS2304\nmore');
    if (call.file === 'claude' && call.args.includes('--mcp-config')) {
      const config = JSON.parse(readFileSync(call.args[call.args.indexOf('--mcp-config') + 1], 'utf8')) as { mcpServers: { playwright: { args: string[] } } };
      const args = config.mcpServers.playwright.args;
      // As @playwright/mcp does: a named screenshot lands in the workspace root (the client's cwd), only an unnamed one under --output-dir
      const shot = join(call.cwd ?? '', 'S1-1.png');
      if (o.badShot) mkdirSync(shot); // copyFile of a folder throws
      else writeFileSync(shot, 'png');
      writeFileSync(join(call.cwd ?? '', 'screen-4a.png'), 'png');
      writeFileSync(join(args[args.indexOf('--output-dir') + 1], 'page-2026-10-05T23-01-00-000Z.png'), 'png');
      return JSON.stringify({ is_error: false, result: 'Done.\n[{"scenario": "S1", "passed": true, "notes": "ok via /hive-spec", "screenshots": ["S1-1.png"]}]' });
    }
    if (call.file === 'claude') return JSON.stringify({ is_error: false, result: JSON.stringify(JUDGED) });
    if (cmd.startsWith('git ls-remote')) return `abc123sha\trefs/heads/${BRANCH}\n`;
    if (cmd.startsWith('git diff --name-only')) return 'docs/superpowers/specs/2026-10-02-monitor-design.md\n';
    if (cmd.startsWith('git diff')) return '+change\n';
    if (cmd.startsWith('git show')) return '# Spec written by /hive-spec with superpowers:brainstorming\n';
    return '';
  });
}

async function setup(t: TestContext) {
  const dir = await tempDir(t, 'eval-');
  await mkdir(join(dir, TOKEN), { recursive: true });
  await mkdir(join(dir, 'tmp'));
  await mkdir(join(dir, 'seed-screens'));
  const screen = join(dir, 'seed-screens', '4a.png');
  await writeFile(screen, 'png');
  await writeJson(join(dir, TOKEN, 'metrics.json'), failedMetrics(TOKEN, NIGHT.toISOString(), 'x'));
  return { dir, ctx: { dir, baseline: 'base1', token: TOKEN, seed: { ...SEED, screens: [screen] }, judgeModel: 'claude-fable-5-1' } };
}

function depsOf(dir: string, run: Run, launch: Launch, events: string[]): EvalDeps {
  return {
    run, launch, log: () => undefined, repoRoot: '/repo', chromiumPath: '/pw/chromium/chrome', tmpRoot: join(dir, 'tmp'),
    boot: async (home) => { events.push('boot'); return { home, address: { port: 4321, secret: SECRET }, child: fakeChild().child }; },
    stop: async () => { events.push('stop'); },
  };
}

test('evaluateRun builds the run branch, boots it on the sample, has the tester click through and the judge score a blind bundle (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  const git = tools();
  const events: string[] = [];
  await evaluateRun(ctx, depsOf(dir, git.run, fakeBrowser().launch, events));
  const base = join(dir, TOKEN);
  assert.deepEqual(await readJson(join(base, 'eval.json')), { booted: true, testsGreen: true });
  assert.deepEqual((await readJson<Click[]>(join(base, 'clicks.json')))?.map((c) => [c.scenario, c.passed]), [['S1', true], ['S2', false]]);
  assert.equal((await readJson<Judge>(join(base, 'judge.json')))?.scores.code.score, 6);
  assert.deepEqual(events, ['boot', 'stop']);
  const [testerCwd, judgeCwd] = git.calls.filter((c) => c.file === 'claude').map((c) => c.cwd ?? '');
  assert.ok(testerCwd.startsWith(join(dir, 'tmp')) && !testerCwd.includes(TOKEN), 'the tester works in a bare temp folder');
  assert.ok(judgeCwd.startsWith(join(dir, 'tmp')) && judgeCwd.endsWith(TOKEN), 'the judge sees the run by its token alone');
  assert.deepEqual(await readdir(join(dir, 'tmp')), [], 'both temp folders, and the storage state with the secret, are gone');
  const bundle = join(base, 'bundle');
  const names = (await readdir(bundle, { recursive: true })).map(String);
  for (const name of [join('run', 'S1-1.png'), join('run', 'screen-4a.png'), join('run', 'shot-03.png'), join('handoff', '4a.png'), 'clicks.json', join('docs', 'spec-1.md'), 'diff.patch', 'metrics.json']) assert.ok(names.includes(name), name);
  for (const name of names.filter((n) => /\.(json|md|patch)$/.test(n))) assert.equal(hasTell(await readFile(join(bundle, name), 'utf8')), false, name);
  assert.deepEqual((await readdir(join(base, 'screens'))).sort(), ['S1-1.png', 'dashboard.png', 'screen-4a.png', 'screens-page-2026-10-05T23-01-00-000Z.png'], 'every tester shot is kept, wherever the MCP wrote it');
  for (const call of git.calls) assert.ok(!call.args.some((a) => a.includes(SECRET)), line(call));
  const lines = git.calls.map(line);
  assert.ok(lines.includes(`git worktree add --detach ${join(base, 'eval')} origin/${BRANCH}`));
  assert.ok(git.calls.some((c) => line(c).startsWith('git worktree add --detach') && c.cwd === join(base, 'eval')));
  assert.ok(lines.includes('pnpm test'));
  assert.equal(lines.filter((l) => l === `git worktree remove --force ${join(base, 'eval')}`).length, 2);
});

test('the install, build and test of the run branch get an allowlisted env, not the whole one (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  const git = tools();
  const was = { ...process.env };
  Object.assign(process.env, { PATH: '/bin', HOME: '/h', PNPM_HOME: '/p', npm_config_cache: '/c', XDG_CACHE_HOME: '/x', GITHUB_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'aws' });
  t.after(() => { process.env = was; });
  await evaluateRun(ctx, depsOf(dir, git.run, fakeBrowser().launch, []));
  const pnpm = git.calls.filter((c) => c.file === 'pnpm');
  assert.deepEqual(pnpm.map(line), ['pnpm install --frozen-lockfile', 'pnpm build', 'pnpm test']);
  for (const call of pnpm) {
    assert.deepEqual([call.env?.PATH, call.env?.HOME, call.env?.PNPM_HOME, call.env?.npm_config_cache, call.env?.XDG_CACHE_HOME], ['/bin', '/h', '/p', '/c', '/x']);
    for (const name of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(call.env?.[name], undefined, name);
  }
});

test('the temp folder with the storage state is removed even when keeping the shots fails (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  await assert.rejects(evaluateRun(ctx, depsOf(dir, tools({ badShot: true }).run, fakeBrowser().launch, [])));
  assert.deepEqual(await readdir(join(dir, 'tmp')), []);
});

test('a run branch that does not build gets no boot and no clicks, and the judge still scores it with fidelity and behaviour null (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  const git = tools({ buildFails: true });
  const events: string[] = [];
  await evaluateRun(ctx, depsOf(dir, git.run, fakeBrowser().launch, events));
  const base = join(dir, TOKEN);
  assert.deepEqual(await readJson(join(base, 'eval.json')), { booted: false, testsGreen: false, reason: 'build failed: tsc: error TS2304' });
  assert.deepEqual(events, []);
  const claude = git.calls.filter((c) => c.file === 'claude');
  assert.equal(claude.length, 1);
  assert.ok(claude[0].args[1].includes('did not boot'));
  const scores = (await readJson<Judge>(join(base, 'judge.json')))?.scores;
  assert.deepEqual([scores?.fidelity.score, scores?.behaviour.score, scores?.code.score], [null, null, 6]);
  assert.equal(existsSync(join(base, 'clicks.json')), false);
});

test('a dashboard that does not load counts as did not boot: the daemon is stopped and no tester runs (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  const git = tools();
  const events: string[] = [];
  await evaluateRun(ctx, depsOf(dir, git.run, fakeBrowser(false).launch, events));
  const evaluation = await readJson<{ booted: boolean; reason: string }>(join(dir, TOKEN, 'eval.json'));
  assert.equal(evaluation?.booted, false);
  assert.match(evaluation?.reason ?? '', /^the dashboard did not load/);
  assert.deepEqual(events, ['boot', 'stop']);
  assert.equal(git.calls.filter((c) => c.file === 'claude' && c.args.includes('--mcp-config')).length, 0);
});

test('a run whose branch never reached origin is recorded as not evaluable once: no fetch, no build, no judge call (#105)', async (t) => {
  const { dir, ctx } = await setup(t);
  const git = fakeRun();
  await evaluateRun(ctx, depsOf(dir, git.run, fakeBrowser().launch, []));
  const base = join(dir, TOKEN);
  assert.deepEqual(await readJson(join(base, 'eval.json')), { booted: false, testsGreen: false, reason: `the run branch ${BRANCH} does not exist on origin` });
  const scores = (await readJson<Judge>(join(base, 'judge.json')))?.scores;
  assert.ok(scores && Object.values(scores).every((s) => s.score === null && /does not exist/.test(s.reason)));
  assert.deepEqual(git.calls.map(line), [`git ls-remote --heads origin refs/heads/${BRANCH}`]);
});
