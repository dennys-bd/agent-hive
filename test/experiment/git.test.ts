import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBaselineClean, BASELINE_MESSAGE, createRunBranch, docsClone, dropRunWorktrees, experimentBaseline, resolveBaseline, sandboxPaths, strippedPackageJson, unsignedCommits } from '../../scripts/experiment/git.js';
import { EXPERIMENT_PATHS } from '../../scripts/experiment/seed.js';
import { tempDir } from '../temp-dir.js';
import { fakeRun, line } from './fixtures.js';

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
    if (cmd === 'ls-tree') return 'src/a.ts\n';
    return cmd === 'commit-tree' ? 'base1234567890\n' : '';
  });
  assert.equal(await experimentBaseline(run, { source: 'src1', scratch }), 'base1234567890');
  const lines = calls.map(line);
  assert.equal(lines[0], 'git read-tree src1');
  assert.equal(lines[1], `git rm -r -q --cached --ignore-unmatch -- ${EXPERIMENT_PATHS.join(' ')}`);
  assert.ok(lines.includes('git update-index --add --cacheinfo 100644,blob-package.json,package.json'));
  assert.equal(lines.filter((l) => l.startsWith('git update-index')).length, 1, 'only package.json is added');
  assert.ok(lines.includes(`git commit-tree tree1 -m ${BASELINE_MESSAGE}`), 'no -p: an orphan commit');
  assert.ok(lines.includes('git update-ref refs/bases/monitor-view-base12345678 base1234567890'));
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
  await dropRunWorktrees(run, 'MAAAAAA');
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

test('docsClone runs git in docs/ and returns its paths; a missing clone, or one whose origin is not local, is refused (#79)', async (t) => {
  const root = await tempDir(t, 'lab-');
  const answer = (origin: string) => fakeRun((call) => (call.args[0] === 'remote' ? `${origin}\n` : `${join(root, 'docs', '.git')}\n`));
  await assert.rejects(docsClone(answer('/lab/hive-docs.git').run, root), /no docs clone/);
  await mkdir(join(root, 'docs', '.git'), { recursive: true });
  const local = answer('/lab/hive-docs.git');
  const { docs, paths } = await docsClone(local.run, root);
  assert.deepEqual(paths, { gitDir: join(root, 'docs', '.git'), origin: '/lab/hive-docs.git' });
  await docs('git', ['status']);
  assert.ok(local.calls.every((c) => c.cwd === join(root, 'docs')), 'every call runs in the docs clone');
  await assert.rejects(docsClone(answer('git@github.com:someone/docs.git').run, root), /must be a local repository/);
});
