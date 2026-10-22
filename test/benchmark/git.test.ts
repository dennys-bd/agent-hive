import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inDir, type Run } from '../../src/benchmark/exec.js';
import { prepareExperiment } from '../../src/benchmark/run-home.js';
import { assertBaselineClean, BASELINE_MESSAGE, createRunBranch, dropRunWorktrees, EXPERIMENT_MENTION, EXPERIMENT_PATHS, experimentBaseline, nestedBaseline, resolveBaseline, sandboxPaths, strippedPackageJson, unsignedCommits } from '../../src/benchmark/git.js';
import { tempDir } from '../temp-dir.js';
import { experiment, fakeChild, fakeRun, line, mainConfig, WS_PATH } from './fixtures.js';
import { stopRun } from '../../src/benchmark/daemon.js';

const BRANCH = 'feat/monitor-view-abc123';
const PKG = JSON.stringify({ name: 'agent-hive', scripts: { test: 'x', 'test:node': 'node --test "dist/test/*.test.js" "dist/test/experiment/*.test.js"', 'experiment:skills': 'y', 'run:experiment-a': 'pnpm build && node dist/scripts/experiment/preview.js a', start: 'node bin/hive.js' } }, null, 2);

test('resolveBaseline fetches and resolves a plain ref past --end-of-options, and refuses one that is not plain (#105)', async () => {
  const { run, calls } = fakeRun((call) => (call.args[0] === 'rev-parse' ? 'src1\n' : ''));
  assert.equal(await resolveBaseline(run, 'origin/main'), 'src1');
  assert.deepEqual(calls.map(line), ['git fetch origin', 'git rev-parse --verify --end-of-options origin/main^{commit}']);
  for (const bad of ['-x', 'a..b', 'main~1', '']) await assert.rejects(resolveBaseline(run, bad), /plain ref/, bad);
});

test('strippedPackageJson drops the experiment scripts and test glob; assertBaselineClean refuses any experiment file (#105)', () => {
  const pkg = strippedPackageJson(PKG);
  assert.ok(!/experiment/i.test(pkg), pkg);
  assert.equal(JSON.parse(pkg).scripts['test:node'], 'node --test "dist/test/*.test.js"');
  assert.deepEqual(Object.keys(JSON.parse(pkg).scripts), ['test', 'test:node', 'start'], 'a script named or running anything of the experiment goes, whatever its prefix');
  assert.doesNotThrow(() => assertBaselineClean('src/a.ts\nsrc/b.ts\n', pkg));
  for (const path of EXPERIMENT_PATHS) assert.throws(() => assertBaselineClean(`${path}/x.ts\n${path}\n`, pkg), /experiment/, path);
  assert.throws(() => assertBaselineClean('src/a.ts\n', PKG), /package\.json/);
});

test('experimentBaseline builds an orphan commit of the source tree without the experiment, on a private index; the handoff goes to the docs baseline (#105, #79)', async (t) => {
  const scratch = await tempDir(t, 'base-');
  const { run, calls } = fakeRun((call) => {
    const [cmd] = call.args;
    if (cmd === 'show') return PKG;
    if (cmd === 'hash-object') return `blob-${call.args.at(-1)?.split('/').at(-1)}\n`;
    if (cmd === 'write-tree') return 'tree1\n';
    if (cmd === 'ls-tree') return call.args.includes('-r') ? 'src/a.ts\n' : 'package.json\n';
    return cmd === 'commit-tree' ? 'base1234567890\n' : '';
  });
  assert.equal(await experimentBaseline(run, { source: 'src1', scratch }), 'base1234567890');
  const lines = calls.map(line);
  assert.equal(lines[0], 'git ls-tree --name-only src1 -- package.json');
  assert.equal(lines[1], 'git read-tree src1');
  assert.equal(lines[2], `git rm -r -q --cached --ignore-unmatch -- ${EXPERIMENT_PATHS.join(' ')}`);
  assert.ok(lines.includes('git update-index --add --cacheinfo 100644,blob-package.json,package.json'));
  assert.equal(lines.filter((l) => l.startsWith('git update-index')).length, 1, 'only package.json is added');
  assert.ok(lines.includes(`git commit-tree tree1 -m ${BASELINE_MESSAGE}`), 'no -p: an orphan commit');
  assert.ok(lines.includes('git update-ref refs/bases/base12345678 base1234567890'));
  const indexed = calls.filter((c) => ['read-tree', 'rm', 'update-index', 'write-tree'].includes(c.args[0]));
  for (const c of indexed) assert.equal(c.env?.GIT_INDEX_FILE, join(scratch, 'baseline.index'), line(c));
  await assert.rejects(readFile(join(scratch, 'package.json')), /ENOENT/, 'scratch files removed');
});

test('createRunBranch makes the run branch at the baseline and pushes it; a branch origin already holds is refused (#105)', async () => {
  const { run, calls } = fakeRun();
  await createRunBranch(run, BRANCH, 'base1');
  assert.deepEqual(calls.map(line), [`git ls-remote --heads origin refs/heads/${BRANCH}`, `git branch -f ${BRANCH} base1`, `git push -u origin ${BRANCH}`]);
  const taken = fakeRun((call) => (call.args[0] === 'ls-remote' ? `def456\trefs/heads/${BRANCH}\n` : ''));
  await assert.rejects(createRunBranch(taken.run, BRANCH, 'base1'), /already on origin/);
  assert.equal(taken.calls.length, 1);
});

test('dropRunWorktrees removes only the worktrees and branches of this run prefix, locally and on origin: never the other arm (#105)', async () => {
  const porcelain = [
    'worktree /repo\nHEAD a\nbranch refs/heads/main',
    'worktree /repo/.hive/worktrees/hive-maaaaaa-1-x\nHEAD b\nbranch refs/heads/hive/MAAAAAA-1-x',
    'worktree /repo/.hive/worktrees/hive-mbbbbbb-1-x\nHEAD c\nbranch refs/heads/hive/MBBBBBB-1-x',
    'worktree /repo/.hive/worktrees/hive-test-1\nHEAD d\nbranch refs/heads/hive/TEST-1-y',
  ].join('\n\n');
  const { run, calls } = fakeRun((call) => {
    if (call.args[0] === 'worktree' && call.args[1] === 'list') return `${porcelain}\n`;
    if (call.args[0] === 'branch' && call.args[1] === '--list') return 'hive/MAAAAAA-1-x\nhive/MAAAAAA-2-z\n';
    if (call.args[0] === 'ls-remote') return 'abc\trefs/heads/hive/MAAAAAA-2-z\n';
    return '';
  });
  await dropRunWorktrees(run, 'MAAAAAA', '/repo');
  const done = calls.map(line);
  assert.ok(done.includes('git worktree remove --force /repo/.hive/worktrees/hive-maaaaaa-1-x'));
  assert.ok(done.includes('git branch --list hive/MAAAAAA-* --format=%(refname:short)'));
  assert.ok(done.includes('git branch -D hive/MAAAAAA-1-x') && done.includes('git branch -D hive/MAAAAAA-2-z'));
  assert.ok(done.includes('git push origin --delete refs/heads/hive/MAAAAAA-2-z'));
  assert.ok(!done.some((l) => /MBBBBBB|mbbbbbb|TEST-/.test(l) || l.endsWith(' main')));
});

test('sandboxPaths reads the clone\'s git folder and origin as git answers them, absolute (#105)', async () => {
  const { run, calls } = fakeRun((call) => (call.args[0] === 'rev-parse' ? '/lab/hive/.git\n' : '/lab/hive.git\n'));
  assert.deepEqual(await sandboxPaths(run), { gitDir: '/lab/hive/.git', origin: '/lab/hive.git' });
  assert.deepEqual(calls.map(line), ['git rev-parse --path-format=absolute --git-common-dir', 'git remote get-url origin']);
});

test('unsignedCommits turns signing off in the clone only: a sandboxed worker cannot reach the user\'s signing agent (#105)', async () => {
  const { run, calls } = fakeRun(() => '');
  await unsignedCommits(run);
  assert.deepEqual(calls.map(line), ['git config --local commit.gpgsign false', 'git config --local tag.gpgsign false']);
});

test('experimentBaseline on a tree with no package.json drops the harness paths and adds no blob (#471)', async (t) => {
  const scratch = await tempDir(t, 'base-');
  const { run, calls } = fakeRun((call) => ({ 'write-tree': 'tree1\n', 'commit-tree': 'base1234567890\n', 'ls-tree': call.args.includes('-r') ? 'lib/a.py\n' : '' })[call.args[0]] ?? '');
  assert.equal(await experimentBaseline(run, { source: 'src1', scratch }), 'base1234567890');
  const lines = calls.map(line);
  assert.ok(lines.includes(`git rm -r -q --cached --ignore-unmatch -- ${EXPERIMENT_PATHS.join(' ')}`));
  assert.ok(!lines.some((l) => l.startsWith('git show') || l.startsWith('git update-index')));
  assert.ok(lines.includes(`git commit-tree tree1 -m ${BASELINE_MESSAGE}`));
});

test('nestedBaseline drops every file naming the harness or the decomposition, adds no file when given none, and refuses a tree that still names them (#471)', async (t) => {
  const scratch = await tempDir(t, 'nested-');
  let tree = false;
  const { run, calls } = fakeRun((call) => {
    if (call.args[0] === 'grep') return tree ? '' : 'src1:agent/x.md\nsrc1:agent/hive/specs/2026-10-21-benchmark-view-decomposition.md\n';
    if (call.args[0] === 'write-tree') { tree = true; return 'tree1\n'; }
    return call.args[0] === 'commit-tree' ? 'nest12345678ab\n' : '';
  });
  assert.equal(await nestedBaseline(run, { source: 'src1', scratch }), 'nest12345678ab');
  const lines = calls.map(line);
  assert.ok(lines.includes(`git grep -l -I -E ${EXPERIMENT_MENTION} src1 --`));
  assert.ok(EXPERIMENT_MENTION.includes('benchmark-view-decomposition'));
  assert.ok(lines.includes('git rm -q --cached -- agent/x.md agent/hive/specs/2026-10-21-benchmark-view-decomposition.md'));
  assert.ok(!lines.some((l) => l.startsWith('git update-index')));
  const leaking = fakeRun((call) => (call.args[0] === 'grep' ? 'tree1:a.md\n' : call.args[0] === 'write-tree' ? 'tree1\n' : ''));
  await assert.rejects(nestedBaseline(leaking.run, { source: 'src1', scratch }), /names the experiment/);
});

test('dropRunWorktrees clears each nested clone before the clone, and never touches another prefix or the run branch (#471)', async () => {
  const porcelain = (root: string): string => [`worktree ${root}\nHEAD a\nbranch refs/heads/main`, `worktree ${root}/.hive/worktrees/x\nHEAD b\nbranch refs/heads/hive/ABCD1234-1-x`, `worktree ${root}/w\nHEAD c\nbranch refs/heads/work/abcd1234`].join('\n\n');
  const { run, calls } = fakeRun((call) => (call.args[1] === 'list' && call.args[0] === 'worktree' ? `${porcelain(call.cwd ?? '')}\n` : ''));
  await dropRunWorktrees(inDir(run, '/e/clone'), 'ABCD1234', '/e/clone', ['/e/clone/docs']);
  const cwds = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove').map((c) => c.cwd);
  assert.deepEqual(cwds, ['/e/clone/docs', '/e/clone'], 'a nested worktree sits inside its task worktree: its repo forgets it first');
  assert.ok(!calls.map(line).some((l) => l.includes('work/abcd1234') || l.endsWith(' main')));
});

test('stopRun stops the daemon, then removes the run\'s worktrees and task branches in the nested clones and the clone, never work/<token> (#471)', async () => {
  const home = '/hive/benchmark/exp-1/runs/abcd1234';
  const stopped: string[] = [];
  const { run, calls } = fakeRun((call) => (call.args[0] === 'branch' && call.args[1] === '--list' ? 'hive/ABCD1234-1-x\n' : ''));
  await stopRun({ token: 'abcd1234', daemon: { home, address: { port: 1, secret: 'x' }, child: fakeChild().child } }, { exec: run, nestedRepos: ['docs'], stop: async (h) => { stopped.push(h); return true; } });
  assert.deepEqual(stopped, [home]);
  assert.deepEqual([...new Set(calls.map((c) => c.cwd))], ['/hive/benchmark/exp-1/clone/docs', '/hive/benchmark/exp-1/clone']);
  assert.ok(calls.map(line).includes('git branch -D hive/ABCD1234-1-x'));
  assert.ok(!calls.map(line).some((l) => l.includes('work/')));
});

const PKG_TEXT = JSON.stringify({ name: 'x', scripts: { test: 't' } });
const prepGit = () => fakeRun((call) => {
  const [cmd] = call.args;
  if (cmd === 'init') mkdirSync(String(call.args.at(-1)), { recursive: true });
  if (cmd === 'ls-tree') return call.args.includes('-r') ? 'src/a.ts\n' : 'package.json\n';
  if (cmd === 'show') return PKG_TEXT;
  if (cmd === 'rev-parse') return 'nestedsrc\n';
  if (cmd === 'write-tree') return 'tree1\n';
  if (cmd === 'commit-tree') return call.cwd === WS_PATH ? 'codebase0000\n' : 'nestbase0000\n';
  return '';
});

test('prepareExperiment makes both origins with their baselines, the clone and its nested clone, unsigned, the sandbox excluded; a second call runs no git (#471)', async (t) => {
  const hiveDir = await tempDir(t, 'bench-');
  const { run, calls } = prepGit();
  const deps = { hiveDir, config: mainConfig(), exec: run };
  await prepareExperiment(experiment(), deps);
  const dir = join(hiveDir, 'benchmark', 'exp-1');
  const at = calls.map((c) => `${c.cwd ?? '.'}$ ${line(c)}`);
  for (const expected of [
    `${WS_PATH}$ git read-tree ${'a'.repeat(40)}`,
    `${WS_PATH}$ git rm -r -q --cached --ignore-unmatch -- ${EXPERIMENT_PATHS.join(' ')}`,
    `.$ git init --bare -q --initial-branch main ${join(dir, 'repo.git')}`,
    `${WS_PATH}$ git push -q ${join(dir, 'repo.git')} codebase0000:refs/heads/main`,
    `${join(WS_PATH, 'docs')}$ git grep -l -I -E ${EXPERIMENT_MENTION} nestedsrc --`,
    `.$ git init --bare -q --initial-branch main ${join(dir, 'nested', 'docs.git')}`,
    `${join(WS_PATH, 'docs')}$ git push -q ${join(dir, 'nested', 'docs.git')} nestbase0000:refs/heads/main`,
    `.$ git clone -q -- ${join(dir, 'repo.git')} ${join(dir, 'clone')}`,
    `.$ git clone -q -- ${join(dir, 'nested', 'docs.git')} ${join(dir, 'clone', 'docs')}`,
    `${join(dir, 'clone')}$ git config --local commit.gpgsign false`,
    `${join(dir, 'clone', 'docs')}$ git config --local commit.gpgsign false`,
  ]) assert.ok(at.includes(expected), expected);
  assert.equal(await readFile(join(dir, 'clone', '.git', 'info', 'exclude'), 'utf8'), '.claude/settings.local.json\n');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const before = calls.length;
  await prepareExperiment(experiment(), deps);
  assert.equal(calls.length, before);
});

test('a preparation that fails leaves no origin behind, so the next call prepares again; logs never name a path (#471)', async (t) => {
  const hiveDir = await tempDir(t, 'bench-');
  const ok = prepGit();
  const exec: Run = (file, args, opts) => (args[0] === 'clone' ? Promise.reject(new Error('clone failed')) : ok.run(file, args, opts));
  await assert.rejects(prepareExperiment(experiment(), { hiveDir, config: mainConfig(), exec }), /clone failed/);
  assert.equal(existsSync(join(hiveDir, 'benchmark', 'exp-1', 'repo.git')), false);
  const lines: string[] = [];
  await prepareExperiment(experiment(), { hiveDir, config: mainConfig(), exec: prepGit().run, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ['benchmark exp-1: origins and clone ready']);
});

test('dropRunWorktrees removes only worktrees inside the clone folder: a forged .git/worktrees entry cannot aim it elsewhere (#471)', async () => {
  const porcelain = ['worktree /e/clone/.hive/worktrees/x\nHEAD b\nbranch refs/heads/hive/ABCD1234-1-x', 'worktree /home/u/precious\nHEAD c\nbranch refs/heads/hive/ABCD1234-2-y', 'worktree /e/clone-evil/w\nHEAD d\nbranch refs/heads/hive/ABCD1234-3-z'].join('\n\n');
  const { run, calls } = fakeRun((call) => (call.args[0] === 'worktree' && call.args[1] === 'list' ? `${porcelain}\n` : ''));
  await dropRunWorktrees(run, 'ABCD1234', '/e/clone');
  const removed = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove').map((c) => c.args[3]);
  assert.deepEqual(removed, ['/e/clone/.hive/worktrees/x']);
});
