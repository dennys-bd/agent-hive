import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WORKSPACE_TEARDOWN, workspaceSetup } from '../../scripts/experiment/arm-config.js';
import { cleanEnv, execRun, inDir, type Run } from '../../scripts/experiment/exec.js';
import { docsBaseline, runDocs } from '../../scripts/experiment/git.js';
import { tempDir } from '../temp-dir.js';

const RUN_BRANCH = 'feat/monitor-view-abc123';
const TASK_BRANCH = 'hive/MABC123-1-grid';
// Real git, away from the user's config: no signing, no hooks, a fixed identity
const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Hive', GIT_AUTHOR_EMAIL: 'hive@example.invalid', GIT_COMMITTER_NAME: 'Hive', GIT_COMMITTER_EMAIL: 'hive@example.invalid' };
const run: Run = (file, args, opts = {}) => execRun(file, args, { ...opts, env: { ...(opts.env ?? cleanEnv(process.env)), ...ENV } });
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', args, { cwd })).stdout.trim();
const sh = (cwd: string, line: string): Promise<{ stdout: string }> => run('/bin/sh', ['-c', line.replace(/^RUN /, '')], { cwd });

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function newRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main');
  return path;
}

test('docsBaseline drops every doc that names the harness and adds the handoff, as an orphan; runDocs reads a run\'s specs and plans from its task branches (#79)', async (t) => {
  const dir = await tempDir(t, 'docs-');
  const repo = await newRepo(join(dir, 'docs'));
  const source = await commitFiles(repo, {
    'glossary.md': '# Glossary\n',
    'agent/hive/specs/2026-10-01-skills-ab-experiment-design.md': 'The harness lives in scripts/experiment.\n',
    'agent/hive/plans/2026-10-06-commands-stage.md': '| `scripts/experiment/arm-config.ts` | modified |\n',
  }, 'docs: history');
  await writeFile(join(dir, 'README.md'), '# Monitor\n');
  const docs = inDir(run, repo);
  const base = await docsBaseline(docs, { source, files: [{ from: join(dir, 'README.md'), to: 'agent/handoff_monitor/README.md' }], scratch: dir });
  assert.deepEqual((await git(repo, 'ls-tree', '-r', '--name-only', base)).split('\n'), ['agent/handoff_monitor/README.md', 'glossary.md']);
  assert.equal(await git(repo, 'rev-list', '--parents', '-n', '1', base), base, 'an orphan: the source\'s history names the experiment');
  assert.ok(!existsSync(join(dir, 'baseline.index')), 'the private index is gone');

  await git(repo, 'switch', '-q', '-c', TASK_BRANCH, base);
  await commitFiles(repo, { 'agent/hive/plans/2026-10-02-grid.md': '# Plan\n', 'agent/hive/specs/2026-10-02-grid-design.md': '# Spec\n' }, 'docs: grid');
  await git(repo, 'switch', '-q', '-c', 'hive/MDEF456-1-grid', base);
  await commitFiles(repo, { 'agent/hive/specs/2026-10-02-other-design.md': '# The other arm\n' }, 'docs: other');
  assert.deepEqual(await runDocs(docs, base, 'MABC123'), [{ kind: 'spec', text: '# Spec\n' }, { kind: 'plan', text: '# Plan\n' }]);
});

test('the workspace setup gives a task worktree a docs worktree on its own branch from the docs run branch, and the teardown removes it and keeps the branch (#79)', async (t) => {
  const dir = await tempDir(t, 'lab-');
  const src = await newRepo(join(dir, 'src'));
  await commitFiles(src, { 'glossary.md': 'real docs\n' }, 'docs: real');
  await git(src, 'switch', '-q', '-c', RUN_BRANCH);
  const baseline = await commitFiles(src, { 'glossary.md': 'baseline\n' }, 'docs: baseline');
  await git(dir, 'clone', '-q', '--bare', src, join(dir, 'docs.git'));
  const lab = await newRepo(join(dir, 'lab'));
  await commitFiles(lab, { '.gitignore': '/docs/\n' }, 'chore: code');
  await git(lab, 'clone', '-q', join(dir, 'docs.git'), 'docs');
  const worktree = join(lab, '.hive', 'worktrees', 'mabc123-1-grid');
  await git(lab, 'worktree', 'add', '-q', '-b', TASK_BRANCH, worktree);

  const setupLine = workspaceSetup(RUN_BRANCH).split('\n').find((l) => l.includes('worktree add')) ?? '';
  await sh(worktree, setupLine);
  assert.equal(await git(join(worktree, 'docs'), 'branch', '--show-current'), TASK_BRANCH);
  assert.equal(await git(join(worktree, 'docs'), 'rev-parse', 'HEAD'), baseline, 'from the docs run branch, not origin/main');

  await sh(worktree, WORKSPACE_TEARDOWN);
  assert.ok(!existsSync(join(worktree, 'docs')));
  assert.equal(await git(join(lab, 'docs'), 'rev-parse', TASK_BRANCH), baseline, 'the branch stays for the evaluation');
  await sh(worktree, setupLine); // a task worktree made again picks its docs branch up
  assert.equal(await git(join(worktree, 'docs'), 'branch', '--show-current'), TASK_BRANCH);
});
