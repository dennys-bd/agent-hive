import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { localActivityId } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import { SHORT_SHA } from '../src/tasks.js';
import { worktreePath } from '../src/worktree.js';
import type { Exec, SettingsBody, Task } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, EDITOR_FILE_MAX, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../src/types.js';
import { LOCAL_STAGES, tempHive, workspacesAt } from './fakes.js';
import { savedActivityId, withKeptRecord, withWork, workPath } from './fixtures/work.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// GET /activities/:id/file-base (#668) over a real repository: its first commit is the task's base (BASE_REF), its second changes
// docs/spec.md, so HEAD and the task's base differ. Only the route's git runs for real; the boot's other commands answer nothing
const run: Exec = promisify(execFile);
const SLUG = 'hive-1-base';
const BASE_REF = 'hive-668-base';
const TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Base', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const UI_HEADERS = { 'content-type': 'application/json', 'x-hive-ui': '1' };
const ROUTE_GIT = ['rev-parse', 'cat-file', 'merge-base'];
const exec: Exec = (file, args, opts) => (file === 'git' && ROUTE_GIT.some((command) => args.includes(command)) ? run(file, args, opts) : Promise.resolve({ stdout: '' }));

interface Bases { base: string; repo: string; worktree: string; server: HiveServer; git(...args: string[]): Promise<string> }

// The files every test reads: spec.md changed by the second commit, a binary, an oversized one, one at the checkout's root, and an untracked one
async function commitFiles(repo: string, worktree: string, git: Bases['git']): Promise<void> {
  await mkdir(join(worktree, 'docs'), { recursive: true });
  await writeFile(join(worktree, 'docs', 'spec.md'), 'one\n');
  await writeFile(join(worktree, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(join(worktree, 'big.txt'), 'a'.repeat(EDITOR_FILE_MAX + 1));
  await writeFile(join(repo, 'readme.md'), 'readme\n');
  await git('add', '--force', '--all'); // --force: a global excludes file may ignore .hive
  await git('commit', '--quiet', '-m', 'base');
  await git('branch', BASE_REF);
  await writeFile(join(worktree, 'docs', 'spec.md'), 'one\ntwo\n');
  await git('commit', '--quiet', '-am', 'second');
  await writeFile(join(worktree, 'docs', 'new.md'), 'fresh\n');
}

// deleted: the activity is gone, its record alone kept (#629)
async function startBases(t: TestContext, isDeleted = false): Promise<Bases> {
  const made = await tempHive(t);
  const repo = await realpath(made.repo);
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', repo, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();
  const worktree = worktreePath(repo, SLUG);
  await commitFiles(repo, worktree, git);
  const base0 = { ...initialState(0), localCount: 1, tasks: [TASK] };
  const state = isDeleted
    ? withKeptRecord(base0, 'local:1', savedActivityId(1), { slug: SLUG })
    : withWork(base0, 'local:1', { id: savedActivityId(1), slug: SLUG, base: { ref: BASE_REF, tellWorker: false } });
  await saveState(made.home, state);
  const server = createServer({ secret: SECRET, home: made.home, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SettingsBody = { prefix: 'HIVE', workspaces: workspacesAt(repo), sources: [], stages: LOCAL_STAGES, onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS, commands: [] };
  assert.equal((await hiveFetch(`${base}/settings`, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify(body) })).status, 200);
  return { base, repo, worktree, server, git };
}

const localRoute = `/activities/${encodeURIComponent(localActivityId('hive'))}`;
async function ask(b: Bases, query: Record<string, string>, activity = workPath(b.server, 'local:1')): Promise<[number, unknown]> {
  const res = await hiveFetch(`${b.base}${activity}/file-base?${new URLSearchParams(query)}`);
  return [res.status, await res.json()];
}
// A file's blob id at a commit, as git names it
const blob = (b: Bases, ref: string, file: string): Promise<string> => b.git('rev-parse', `${ref}:${relative(b.repo, file)}`);

test('head answers HEAD\'s blob of the file, its text and id, labelled HEAD; task answers the merge-base with the task\'s base ref, labelled as the diff pane labels it (#668)', async (t) => {
  const b = await startBases(t);
  const spec = join(b.worktree, 'docs', 'spec.md');
  const commit = await b.git('rev-parse', BASE_REF);
  assert.deepEqual(await ask(b, { path: 'docs/spec.md', against: 'head' }), [200, { against: 'head', label: 'HEAD', oid: await blob(b, 'HEAD', spec), text: 'one\ntwo\n' }]);
  assert.deepEqual(await ask(b, { path: 'docs/spec.md', against: 'task' }), [200, { against: 'task', label: `${commit.slice(0, SHORT_SHA)} (${BASE_REF})`, oid: await blob(b, BASE_REF, spec), text: 'one\n' }]);
});

test('the blob id the page already holds answers without the text; a file the base does not have, an untracked one, answers an empty text and no id (#668)', async (t) => {
  const b = await startBases(t);
  const oid = await blob(b, 'HEAD', join(b.worktree, 'docs', 'spec.md'));
  assert.deepEqual(await ask(b, { path: 'docs/spec.md', against: 'head', oid }), [200, { against: 'head', label: 'HEAD', oid }]);
  assert.deepEqual(await ask(b, { path: 'docs/new.md', against: 'head' }), [200, { against: 'head', label: 'HEAD', text: '' }]);
});

test('no base: a binary blob, one past EDITOR_FILE_MAX, or a file outside the repository answers its label with no text and no id (#668)', async (t) => {
  const b = await startBases(t);
  const outside = join(await realpath(await tempDir(t, 'outside-')), 'notes.md');
  await writeFile(outside, 'x\n');
  for (const path of ['logo.bin', 'big.txt', outside]) assert.deepEqual(await ask(b, { path, against: 'head' }), [200, { against: 'head', label: 'HEAD' }], path);
});

test('a local activity compares against HEAD of its checkout; the task base there is a 400 (#668)', async (t) => {
  const b = await startBases(t);
  const oid = await blob(b, 'HEAD', join(b.repo, 'readme.md'));
  assert.deepEqual(await ask(b, { path: 'readme.md', against: 'head' }, localRoute), [200, { against: 'head', label: 'HEAD', oid, text: 'readme\n' }]);
  assert.deepEqual(await ask(b, { path: 'readme.md', against: 'task' }, localRoute), [400, { error: 'a local activity has no task base' }]);
});

test('an against other than head or task, or none, and a missing path are 400s; a deleted activity is a 409 (#668)', async (t) => {
  const b = await startBases(t);
  assert.deepEqual(await ask(b, { path: 'docs/spec.md', against: 'stage' }), [400, { error: 'against must be head or task' }]);
  assert.deepEqual(await ask(b, { path: 'docs/spec.md' }), [400, { error: 'against must be head or task' }]);
  assert.deepEqual(await ask(b, { against: 'head' }), [400, { error: 'path must be a non-empty string' }]);
  const gone = await startBases(t, true);
  assert.deepEqual(await ask(gone, { path: 'docs/spec.md', against: 'head' }), [409, { error: 'a atividade foi apagada' }]);
});

// #377: a repository inside the worktree (the task's docs/ checkout) answers for its own files: the outer one ignores them, so asking it
// marked every line as added. The task's base ref is the outer repository's (absent here, so a merge-base would fail): task reads HEAD
test('a file of a nested repository compares against that repository\'s HEAD, for head and for task (#377)', async (t) => {
  const b = await startBases(t);
  const nested = join(b.worktree, 'vendor');
  await mkdir(nested, { recursive: true });
  const git = (...args: string[]): Promise<{ stdout: string }> => run('git', ['-C', nested, '-c', 'user.name=Hive', '-c', 'user.email=hive@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await git('init', '--quiet');
  await writeFile(join(nested, 'notes.md'), 'kept\n');
  await git('add', 'notes.md');
  await git('commit', '--quiet', '-m', 'nested');
  await writeFile(join(nested, 'notes.md'), 'kept\nedited\n');
  const oid = (await git('rev-parse', 'HEAD:notes.md')).stdout.trim();
  for (const against of ['head', 'task']) {
    assert.deepEqual(await ask(b, { path: 'vendor/notes.md', against }), [200, { against, label: 'HEAD', oid, text: 'kept\n' }], against);
  }
});
