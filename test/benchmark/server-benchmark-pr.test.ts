import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Run } from '../../src/benchmark/exec.js';
import { registerBenchmarkPrRoutes } from '../../src/server-benchmark-pr.js';
import type { BenchmarkPrIn, Config } from '../../src/types.js';
import { fakeLog } from '../fakes.js';
import { type Call, experiment, fakeRun, line, mainConfig, PR_URL, prAnswers, run, stateWith } from './fixtures.js';

const PATH = '/benchmark/experiments/exp-1/runs';
const AT = `${PATH}/aaaa1/pr`;
const NOW = Date.parse('2026-10-22T09:00:00.000Z');
const EXP = experiment({ status: 'running', rounds: [{ n: 1, runs: [run('aaaa1', { status: 'done', delivered: 1 }), run('bbbb1', { armId: 'a2', status: 'running' })] }] });
const OPEN = { branch: 'feat/skills', withSummary: false };
const BODY_MESSAGE = { error: 'the body must be { branch: string, withSummary: boolean }' };
const BRANCH_MESSAGE = { error: 'branch must be a plain branch name' };

// The main config of the fixtures (workspace hive at /work/hive, base develop) with every workspace's benchmarkPrIn set
const configWith = (via: BenchmarkPrIn): Config => {
  const config = mainConfig();
  return { ...config, comb: { ...config.comb, workspaces: config.comb.workspaces.map((w) => ({ ...w, benchmarkPrIn: via })) } };
};

interface Options { now?: () => number; answer?: (call: Call) => string | Error; via?: BenchmarkPrIn; gh?: Run }
interface Harness { base: string; calls: Call[]; bodies: string[]; lines: string[] }

// The PR routes alone on a bare express app, as server-benchmark-report.test.ts builds its own: git and gh recorded on one list, each PR
// body read while gh runs
function routes(t: TestContext, { answer = prAnswers(), via = 'worktree', gh, now = () => NOW }: Options = {}): Harness {
  const bodies: string[] = [];
  const { run: exec, calls } = fakeRun((call) => {
    if (call.file === 'gh') bodies.push(readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8'));
    return answer(call);
  });
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerBenchmarkPrRoutes(app, { getState: () => stateWith(EXP), getConfig: () => configWith(via), hiveDir: '/hive', exec, gh: gh ?? exec, now, log });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, bodies, lines };
}

async function call(base: string, path: string, init?: RequestInit): Promise<[number, unknown]> {
  const res = await fetch(`${base}${path}`, init);
  return [res.status, await res.json()];
}
const post = (base: string, path: string, body: unknown) =>
  call(base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET …/runs/:token/pr fetches the run and answers the preview; unknown is a 404, a live run a 409, a failed fetch a 502 that logs no git text (#477)', async (t) => {
  const h = routes(t);
  assert.deepEqual(await call(h.base, AT), [200, {
    token: 'aaaa1', armId: 'a1', status: 'done', commits: 3, tasks: 1, base: 'origin/develop', baseSha: 'a42b2fc', branch: 'feat/skills', title: 'feat: Skills', via: 'worktree',
  }]);
  assert.ok(h.calls.some((c) => line(c) === 'git -c transfer.fsckObjects=true fetch /hive/benchmark/exp-1/repo.git +refs/heads/work/aaaa1:refs/hive/bench/aaaa1' && c.cwd === '/work/hive'));
  assert.deepEqual(await call(h.base, '/benchmark/experiments/nope/runs/aaaa1/pr'), [404, { error: 'no such experiment' }]);
  assert.deepEqual(await call(h.base, `${PATH}/zzzz9/pr`), [404, { error: 'no such run in this experiment' }]);
  assert.deepEqual(await call(h.base, `${PATH}/AAAA1/pr`), [404, { error: 'no such run in this experiment' }], 'a token BENCH_TOKEN refuses names no run');
  assert.deepEqual(await call(h.base, `${PATH}/bbbb1/pr`), [409, { error: 'not-ended' }]);
  const broken = routes(t, { answer: prAnswers({ 'git -c transfer.fsckObjects=true fetch': new Error('fatal: /Users/someone/repo.git does not appear to be a git repository') }) });
  assert.deepEqual(await call(broken.base, AT), [502, { error: 'fetch' }]);
  assert.ok(broken.lines.some((l) => l === 'ERROR benchmark PR of experiment exp-1 failed at fetch: Error'));
  assert.equal(broken.lines.some((l) => l.includes('fatal') || l.includes('someone')), false, 'git\'s words never reach the log');
});

test('POST …/pr takes { branch, withSummary } and nothing else, and a plain branch name git accepts; anything else is a 400 before any fetch (#477)', async (t) => {
  const h = routes(t, { answer: prAnswers({ 'git check-ref-format --branch feat/x.lock': new Error('bad') }) });
  for (const body of [{}, { branch: 'feat/x' }, { branch: 'feat/x', withSummary: 'yes' }, { ...OPEN, draft: true }, [OPEN]]) {
    assert.deepEqual(await post(h.base, AT, body), [400, BODY_MESSAGE], JSON.stringify(body));
  }
  for (const branch of ['-x', 'a..b', 'feat/x.lock']) assert.deepEqual(await post(h.base, AT, { ...OPEN, branch }), [400, BRANCH_MESSAGE], branch);
  assert.deepEqual(await post(h.base, `${PATH}/bbbb1/pr`, OPEN), [409, { error: 'not-ended' }]);
  assert.deepEqual(h.calls.map(line), ['git check-ref-format --branch feat/x.lock'], 'only git\'s own check of the one name isPlainRef let through');
});

test('POST …/pr runs fetch, branch, rebase, push and gh pr create in that order and answers the URL; the summary lands in the body only when asked (#477)', async (t) => {
  const h = routes(t);
  assert.deepEqual(await post(h.base, AT, OPEN), [200, { url: PR_URL }]);
  assert.deepEqual(await post(h.base, AT, { ...OPEN, withSummary: true }), [200, { url: PR_URL }]);
  const steps = h.calls.map(line).map((l) => l.replace(/^git -c \S+ /, 'git ')).filter((l) => /^(git (fetch|worktree add|rebase|push)|gh pr create)/.test(l)).slice(0, 6).map((l) => l.split(' ').slice(0, 3).join(' '));
  assert.deepEqual(steps, ['git fetch /hive/benchmark/exp-1/repo.git', 'git fetch origin', 'git worktree add', 'git rebase --onto', 'git push --no-verify', 'gh pr create']);
  assert.ok(h.calls.some((c) => line(c).startsWith('gh pr create --base develop --head feat/skills --title feat: Skills --body-file ')));
  assert.equal(h.bodies[0], 'Opened from a benchmark run.\n\n- One\n');
  assert.match(h.bodies[1], /^Experiment Skills, arm A · arm A, run aaaa1, round 1\.$/m);
  assert.equal(h.bodies[0].includes('tokens'), false);
});

test('POST …/pr answers each refusal as a 409: the branch on origin, no commit, a conflict with its files, a dirty checkout with its files (#477)', async (t) => {
  const with_ = (overrides: Record<string, string | Error>, via: BenchmarkPrIn = 'worktree') => routes(t, { via, answer: prAnswers(overrides) });
  assert.deepEqual(await post(with_({ 'git ls-remote': `${'d'.repeat(40)}\trefs/heads/feat/skills\n` }).base, AT, OPEN), [409, { error: 'branch-exists' }]);
  assert.deepEqual(await post(with_({ 'git rev-list --count': '0\n' }).base, AT, OPEN), [409, { error: 'no-commits' }]);
  assert.deepEqual(await post(with_({ 'git -c core.hooksPath=/dev/null rebase --onto': new Error('conflict'), 'git diff --name-only --diff-filter=U': 'src/a.ts\n' }).base, AT, OPEN), [409, { error: 'conflict', files: ['src/a.ts'] }]);
  const dirty = with_({ 'git status --porcelain': ' M src/x.ts\n' }, 'checkout');
  assert.deepEqual(await post(dirty.base, AT, OPEN), [409, { error: 'dirty', files: ['src/x.ts'] }]);
  assert.equal(dirty.calls.some((c) => c.args.includes('checkout')), false, 'a dirty checkout is never switched');
});

test('a second POST …/pr while one runs in the same workspace answers 409 busy; the lock goes when the first ends (#477)', async (t) => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ghStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => { ghStarted = resolve; });
  const { run: inner } = fakeRun(prAnswers());
  const gh: Run = async (file, args, opts) => {
    ghStarted();
    await gate;
    return inner(file, args, opts);
  };
  const h = routes(t, { gh });
  const first = post(h.base, AT, OPEN);
  await started;
  assert.deepEqual(await post(h.base, AT, OPEN), [409, { error: 'busy' }]);
  release();
  assert.deepEqual(await first, [200, { url: PR_URL }]);
  assert.deepEqual(await post(h.base, AT, OPEN), [200, { url: PR_URL }]);
});

test('a failed push or gh answers 502 with the step, and hive.log gets the step and the error\'s class, never git\'s or gh\'s words (#477)', async (t) => {
  const push = routes(t, { answer: prAnswers({ 'git -c core.hooksPath=/dev/null push': new Error('remote: Permission to someone/repo denied') }) });
  assert.deepEqual(await post(push.base, AT, OPEN), [502, { error: 'push' }]);
  const pr = routes(t, { answer: prAnswers({ 'gh pr create': new Error('GraphQL: someone has no access') }) });
  assert.deepEqual(await post(pr.base, AT, OPEN), [502, { error: 'pr' }]);
  for (const [h, step] of [[push, 'push'], [pr, 'pr']] as const) {
    assert.ok(h.lines.includes(`ERROR benchmark PR of experiment exp-1 failed at ${step}: Error`), step);
    assert.equal(h.lines.some((l) => l.includes('someone')), false, step);
  }
});

test('GET …/pr answers 409 busy while the workspace\'s PR sequence holds the lock (it fetches into the same refs) (#477)', async (t) => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ghStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => { ghStarted = resolve; });
  const { run: inner } = fakeRun(prAnswers());
  const gh: Run = async (file, args, opts) => {
    ghStarted();
    await gate;
    return inner(file, args, opts);
  };
  const h = routes(t, { gh });
  const first = post(h.base, AT, OPEN);
  await started;
  assert.deepEqual(await call(h.base, AT), [409, { error: 'busy' }]);
  release();
  await first;
  assert.equal((await call(h.base, AT))[0], 200);
});

test('an unexpected throw (not a git or gh step) answers 500 internal and logs the class only, never Express\'s default page (#477)', async (t) => {
  const h = routes(t, { now: () => { throw new RangeError('/Users/someone/y leaked'); } });
  assert.deepEqual(await post(h.base, AT, { ...OPEN, withSummary: true }), [500, { error: 'internal' }]);
  assert.ok(h.lines.some((l) => l === 'ERROR benchmark PR of experiment exp-1 failed: RangeError'));
  assert.equal(h.lines.some((l) => l.includes('someone')), false);
  assert.deepEqual(await post(h.base, AT, OPEN), [200, { url: PR_URL }], 'the lock went with the failure');
});
